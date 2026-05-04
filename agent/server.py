"""FastAPI server for the grocery assistant.

POST /chat                   — single turn, blocking JSON response (legacy)
POST /chat/stream            — SSE stream of live agent + DB events
GET  /sessions               — list a user's prior chats (sidebar source)
GET  /sessions/{session_id}  — replay a prior chat as render-ready turns
GET  /healthz                — liveness + MongoDB ping
GET  /                       — chat UI for the demo (Vite-built SPA)
"""
from __future__ import annotations

import asyncio
import json
import logging
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator

from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from agent import db
from agent.config import SETTINGS
from agent.context import bind_turn_context
from agent.db_listener import set_bus, reset_bus
from agent.event_bus import EventBus, END_SENTINEL
from agent.event_translator import translate_run
from agent.runner import get_runner, streaming_run_config, text_message


def _format_recalled(hits: list[dict]) -> str:
    if not hits:
        return ""
    bullets = "\n".join(f"- {h.get('text','').strip()}" for h in hits if h.get("text"))
    return f"[Known about this customer]\n{bullets}\n\n" if bullets else ""

logging.basicConfig(level=SETTINGS.log_level, format="%(levelname)s %(name)s: %(message)s")
log = logging.getLogger("server")

# Path to the Vite-built SPA. Served as static files in production; the Vite
# dev server proxies /chat etc. to this FastAPI in development.
_UI_DIST = Path(__file__).parent.parent / "ui" / "dist"
_FALLBACK_HTML = """<!doctype html><html><body style="font-family:sans-serif;padding:32px">
<h1>UI not built yet</h1><p>Run <code>npm run build</code> in the <code>ui/</code> directory,
or run <code>npm run dev</code> for live development.</p></body></html>"""


class ChatRequest(BaseModel):
    user_id: str = Field(..., examples=["customer-123"])
    session_id: str | None = Field(None, description="Reuse to continue a conversation")
    message: str


class ToolCall(BaseModel):
    name: str
    args: dict


class ToolResult(BaseModel):
    name: str
    result: object


class ChatResponse(BaseModel):
    session_id: str
    reply: str
    tool_calls: list[ToolCall]
    tool_results: list[ToolResult]
    memory_recalled: list[dict]


class SessionSummary(BaseModel):
    session_id: str
    title: str
    turn_count: int
    updated_at: str | None


class SessionList(BaseModel):
    sessions: list[SessionSummary]


class ReplayTurn(BaseModel):
    role: str
    text: str = ""
    tool_calls: list[ToolCall] = []
    tool_results: list[ToolResult] = []


class SessionReplay(BaseModel):
    session_id: str
    user_id: str
    turns: list[ReplayTurn]


class ArtifactSummary(BaseModel):
    artifact_id: str
    kind: str
    title: str
    content: str
    session_id: str | None
    created_at: str | None


class ArtifactList(BaseModel):
    artifacts: list[ArtifactSummary]


def _artifact_title(kind: str, content: str) -> str:
    """Pick a human title from the artifact content.

    The Planner's reply format is `## <Kind>\\n### <Specific name>` — the
    deeper heading is the descriptive one, so prefer the second heading
    when the first matches the kind label.
    """
    fallback = kind.replace("_", " ").title()
    if not content:
        return fallback

    headings: list[str] = []
    for line in content.splitlines():
        s = line.strip()
        if s.startswith("#"):
            text = s.lstrip("#").strip()
            if text:
                headings.append(text)
        if len(headings) >= 2:
            break

    if not headings:
        # No headings — first non-empty line, truncated.
        for line in content.splitlines():
            s = line.strip()
            if s:
                return s[:80]
        return fallback

    first = headings[0]
    # If the first heading is the kind label, prefer the next one.
    if len(headings) >= 2 and first.lower().replace(" ", "_") == kind.lower():
        return headings[1]
    return first


def _extract_title(events: list[dict[str, Any]]) -> str:
    """Pick the first user-authored text part as the chat title."""
    for ev in events:
        content = ev.get("content") or {}
        if content.get("role") != "user":
            continue
        for part in content.get("parts") or []:
            text = part.get("text")
            if text:
                cleaned = text.split("\n\n", 1)[-1] if text.startswith("[Known about") else text
                cleaned = cleaned.strip().splitlines()[0] if cleaned.strip() else ""
                return cleaned[:80]
    return ""


def _count_user_turns(events: list[dict[str, Any]]) -> int:
    n = 0
    for ev in events:
        content = ev.get("content") or {}
        if content.get("role") != "user":
            continue
        if any(p.get("text") for p in content.get("parts") or []):
            n += 1
    return n


def _replay_turns(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Group raw ADK events into UI-renderable turns matching /chat's shape."""
    turns: list[dict[str, Any]] = []
    current_agent: dict[str, Any] | None = None

    for ev in events:
        content = ev.get("content") or {}
        role = content.get("role")
        parts = content.get("parts") or []

        has_function_response = any(p.get("function_response") for p in parts)
        has_function_call = any(p.get("function_call") for p in parts)
        text_chunks = [p.get("text") for p in parts if p.get("text")]

        if has_function_response:
            if current_agent is None:
                current_agent = {"role": "agent", "text": "", "tool_calls": [], "tool_results": []}
                turns.append(current_agent)
            for p in parts:
                fr = p.get("function_response")
                if fr:
                    current_agent["tool_results"].append(
                        {"name": fr.get("name", ""), "result": fr.get("response")}
                    )
            continue

        if role == "user" and text_chunks:
            current_agent = None
            text = "".join(text_chunks)
            if text.startswith("[Known about"):
                text = text.split("\n\n", 1)[-1]
            turns.append({"role": "user", "text": text, "tool_calls": [], "tool_results": []})
            continue

        if role == "model" or has_function_call or text_chunks:
            if current_agent is None:
                current_agent = {"role": "agent", "text": "", "tool_calls": [], "tool_results": []}
                turns.append(current_agent)
            if text_chunks:
                current_agent["text"] += "".join(text_chunks)
            for p in parts:
                fc = p.get("function_call")
                if fc:
                    current_agent["tool_calls"].append(
                        {"name": fc.get("name", ""), "args": fc.get("args") or {}}
                    )

    return turns


@asynccontextmanager
async def lifespan(_: FastAPI):
    db.ping()
    log.info("MongoDB reachable; app=%s model=%s", SETTINGS.app_name, SETTINGS.gemini_model)
    yield


app = FastAPI(title="ADK + MongoDB Grocery Assistant", lifespan=lifespan)


# ---------- Static SPA serving ----------

if (_UI_DIST / "assets").exists():
    app.mount("/assets", StaticFiles(directory=str(_UI_DIST / "assets")), name="assets")


@app.get("/", response_class=HTMLResponse)
async def root():
    index = _UI_DIST / "index.html"
    return HTMLResponse(index.read_text() if index.exists() else _FALLBACK_HTML)


@app.get("/healthz")
async def healthz():
    db.ping()
    return {"status": "ok"}


# ---------- Sessions ----------


@app.get("/sessions", response_model=SessionList)
async def list_user_sessions(user_id: str, limit: int = 50) -> SessionList:
    cursor = (
        db.sessions()
        .find(
            {"app_name": SETTINGS.app_name, "user_id": user_id},
            projection={"_id": 1, "events": 1, "last_update_time": 1},
        )
        .sort("last_update_time", -1)
        .limit(limit)
    )
    summaries: list[SessionSummary] = []
    for doc in cursor:
        events = doc.get("events", []) or []
        if not _count_user_turns(events):
            continue
        ts = doc.get("last_update_time")
        summaries.append(
            SessionSummary(
                session_id=doc["_id"],
                title=_extract_title(events) or "New chat",
                turn_count=_count_user_turns(events),
                updated_at=ts.isoformat() if ts else None,
            )
        )
    return SessionList(sessions=summaries)


@app.get("/artifacts", response_model=ArtifactList)
async def list_user_artifacts(user_id: str, limit: int = 50) -> ArtifactList:
    """Most-recent-first list of artifacts saved for the given user."""
    cursor = (
        db.artifacts()
        .find(
            {"user_id": user_id},
            projection={"_id": 1, "kind": 1, "content": 1, "session_id": 1, "created_at": 1},
        )
        .sort("created_at", -1)
        .limit(limit)
    )
    artifacts: list[ArtifactSummary] = []
    for doc in cursor:
        kind = doc.get("kind", "artifact")
        content = doc.get("content", "") or ""
        ts = doc.get("created_at")
        artifacts.append(
            ArtifactSummary(
                artifact_id=str(doc["_id"]),
                kind=kind,
                title=_artifact_title(kind, content),
                content=content,
                session_id=doc.get("session_id"),
                created_at=ts.isoformat() if ts else None,
            )
        )
    return ArtifactList(artifacts=artifacts)


@app.get("/sessions/{session_id}", response_model=SessionReplay)
async def get_session_replay(session_id: str, user_id: str) -> SessionReplay:
    doc = db.sessions().find_one(
        {"_id": session_id, "app_name": SETTINGS.app_name, "user_id": user_id}
    )
    if not doc:
        raise HTTPException(status_code=404, detail="session not found")
    return SessionReplay(
        session_id=doc["_id"],
        user_id=doc["user_id"],
        turns=[ReplayTurn(**t) for t in _replay_turns(doc.get("events", []) or [])],
    )


# ---------- Chat: blocking (legacy) ----------


@app.post("/chat", response_model=ChatResponse)
async def chat(req: ChatRequest) -> ChatResponse:
    runner = get_runner()
    session_service = runner.session_service
    memory_service = runner.memory_service

    session = None
    if req.session_id:
        session = await session_service.get_session(
            app_name=SETTINGS.app_name, user_id=req.user_id, session_id=req.session_id
        )
    if session is None:
        session = await session_service.create_session(
            app_name=SETTINGS.app_name, user_id=req.user_id, session_id=req.session_id
        )

    recalled = await memory_service.search_memory(
        app_name=SETTINGS.app_name, user_id=req.user_id, query=req.message
    )

    prefixed_message = _format_recalled(recalled) + req.message

    reply_text_parts: list[str] = []
    tool_calls: list[dict] = []
    tool_results: list[dict] = []

    with bind_turn_context(user_id=req.user_id, session_id=session.id):
        async for event in runner.run_async(
            user_id=req.user_id,
            session_id=session.id,
            new_message=text_message(prefixed_message),
        ):
            content = getattr(event, "content", None)
            if not content:
                continue
            for part in getattr(content, "parts", []) or []:
                if getattr(part, "text", None):
                    reply_text_parts.append(part.text)
                if getattr(part, "function_call", None):
                    fc = part.function_call
                    tool_calls.append({"name": fc.name, "args": dict(fc.args or {})})
                if getattr(part, "function_response", None):
                    fr = part.function_response
                    tool_results.append({"name": fr.name, "result": fr.response})

    if not reply_text_parts:
        raise HTTPException(status_code=502, detail="agent produced no text response")

    return ChatResponse(
        session_id=session.id,
        reply="".join(reply_text_parts).strip(),
        tool_calls=tool_calls,
        tool_results=tool_results,
        memory_recalled=recalled,
    )


# ---------- Chat: SSE stream (live UI) ----------


def _sse_format(event: dict[str, Any]) -> bytes:
    return f"data: {json.dumps(event, default=str)}\n\n".encode("utf-8")


async def _run_turn_into_bus(req: ChatRequest, bus: EventBus) -> None:
    """Drive one chat turn, publishing every event into the bus."""
    runner = get_runner()
    session_service = runner.session_service
    memory_service = runner.memory_service
    turn_id = str(uuid.uuid4())

    try:
        session = None
        if req.session_id:
            session = await session_service.get_session(
                app_name=SETTINGS.app_name,
                user_id=req.user_id,
                session_id=req.session_id,
            )
        if session is None:
            session = await session_service.create_session(
                app_name=SETTINGS.app_name,
                user_id=req.user_id,
                session_id=req.session_id,
            )

        # Recall first — outside the bus context — so the recall hits also
        # appear as a discrete db_op in the live UI (memory.aggregate runs
        # under the bus). To enable that we attach the bus *before* recall.
        bus_token = set_bus(bus)
        try:
            with bind_turn_context(
                user_id=req.user_id,
                session_id=session.id,
                event_queue=bus.queue,
                event_loop=bus.loop,
            ):
                bus.publish(
                    {
                        "kind": "turn_start",
                        "turn_id": turn_id,
                        "user_id": req.user_id,
                        "session_id": session.id,
                        "message": req.message,
                    }
                )

                recalled = await memory_service.search_memory(
                    app_name=SETTINGS.app_name,
                    user_id=req.user_id,
                    query=req.message,
                )
                bus.publish({"kind": "memory_recalled", "hits": recalled})

                prefixed_message = _format_recalled(recalled) + req.message

                reply = await translate_run(
                    bus,
                    runner.run_async(
                        user_id=req.user_id,
                        session_id=session.id,
                        new_message=text_message(prefixed_message),
                        run_config=streaming_run_config(),
                    ),
                    turn_id=turn_id,
                )

                bus.publish(
                    {"kind": "turn_end", "turn_id": turn_id, "reply": reply}
                )
        finally:
            reset_bus(bus_token)
    except Exception as exc:  # noqa: BLE001
        log.exception("chat/stream turn failed")
        bus.publish({"kind": "error", "message": str(exc)[:500]})
    finally:
        bus.close()


@app.post("/chat/stream")
async def chat_stream(req: ChatRequest) -> StreamingResponse:
    """SSE endpoint streaming agent + DB events for one chat turn."""
    bus = EventBus()

    async def drainer() -> AsyncIterator[bytes]:
        # Run the agent turn as a background task so we can drain the queue
        # concurrently. The turn closes the bus when it's done.
        task = asyncio.create_task(_run_turn_into_bus(req, bus))
        try:
            while True:
                ev = await bus.queue.get()
                if ev is END_SENTINEL or ev.get("kind") == "__end__":
                    break
                yield _sse_format(ev)
        finally:
            if not task.done():
                task.cancel()
            # Ensure the task has settled so any final exceptions surface in logs.
            try:
                await task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass

    return StreamingResponse(
        drainer(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )
