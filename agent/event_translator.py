"""Translate ADK runner events into the SSE wire protocol.

ADK emits a stream of `Event` objects with rich shape (text parts, function
calls, function responses, transfer actions, end-of-agent markers). The UI
only needs a flat event union. This module bridges them.

Event protocol (mirrored on the UI side as `src/lib/types.ts`):
  turn_start       — { turn_id, user_id, session_id, message }
  memory_recalled  — { hits: [{text, kind, score}, ...] }
  agent_active     — { agent, branch }              (fires when author changes)
  agent_transfer   — { from, to }                   (delegation moment)
  tool_call        — { agent, tool, args, call_id }
  tool_result      — { agent, tool, call_id, summary }
  text_delta       — { agent, text }                (streaming partial)
  agent_done       — { agent }                       (end_of_agent)
  db_op            — { phase, op, collection, vector_search, ... }
                       (published by MongoLiveListener; not emitted here)
  turn_end         — { turn_id, reply }
  error            — { message }
"""
from __future__ import annotations

import json
import logging
from typing import Any, AsyncIterator, Optional

from agent.event_bus import EventBus

log = logging.getLogger(__name__)


def _summarise_tool_result(result: Any) -> str:
    """Compact one-line summary for tool results — full data stays in db_op events."""
    if isinstance(result, dict):
        if "result" in result and isinstance(result["result"], list):
            return f"{len(result['result'])} items"
        if "status" in result:
            return str(result["status"])
        return json.dumps(result, default=str)[:120]
    if isinstance(result, list):
        return f"{len(result)} items"
    return str(result)[:120]


# Tools whose full result payload should be sent to the UI (for rendering
# product cards, recall lists, etc.). For other tools we only ship the
# short summary above. Bound the payload size so a runaway result never
# blows the SSE stream.
_PAYLOAD_TOOLS: frozenset[str] = frozenset(
    {"search_products", "recall_preferences"}
)


def _payload_for_ui(tool_name: str, result: Any) -> Any:
    """Return a JSON-safe payload for tools we want to render structurally."""
    if tool_name not in _PAYLOAD_TOOLS:
        return None
    # ADK wraps the function return in {"result": ...}.
    if isinstance(result, dict) and "result" in result:
        result = result["result"]
    if isinstance(result, list):
        return result[:20]  # cap
    return None


class _AuthorTracker:
    """Emits `agent_active` events when the active author changes."""

    def __init__(self, bus: EventBus) -> None:
        self.bus = bus
        self.current: Optional[str] = None

    def observe(self, author: Optional[str], branch: Optional[str]) -> None:
        if author and author != self.current and author != "user":
            self.bus.publish(
                {
                    "kind": "agent_active",
                    "agent": author,
                    "branch": branch or author,
                }
            )
            self.current = author


async def translate_run(
    bus: EventBus,
    runner_events: AsyncIterator[Any],
    *,
    turn_id: str,
) -> str:
    """Drain runner events into the bus and return the final reply text.

    Caller is responsible for emitting `turn_start` (before this) and
    `turn_end` (after this) so the wrapping HTTP request boundaries are
    captured even if the runner errors out.
    """
    tracker = _AuthorTracker(bus)
    final_text_parts: list[str] = []

    async for ev in runner_events:
        author = getattr(ev, "author", None)
        branch = getattr(ev, "branch", None)
        actions = getattr(ev, "actions", None)
        partial = getattr(ev, "partial", None)
        content = getattr(ev, "content", None)
        parts = getattr(content, "parts", None) or [] if content else []

        # 1. agent_transfer — fires before the author actually flips.
        if actions and getattr(actions, "transfer_to_agent", None):
            from_agent = author or "?"
            to_agent = actions.transfer_to_agent
            bus.publish(
                {"kind": "agent_transfer", "from": from_agent, "to": to_agent}
            )

        # 2. agent_active — emit on author transitions (after possible transfer).
        tracker.observe(author, branch)

        # 3. content parts.
        for p in parts:
            fc = getattr(p, "function_call", None)
            fr = getattr(p, "function_response", None)
            text = getattr(p, "text", None)

            # Skip the framework-injected transfer_to_agent calls and responses.
            # The UI already has agent_transfer above; surfacing the raw call
            # would clutter the timeline.
            if fc and fc.name == "transfer_to_agent":
                continue
            if fr and fr.name == "transfer_to_agent":
                continue

            if fc and not partial:
                # Only emit on the consolidated event (partial=False/None) so we
                # don't double-fire while gemini streams the call name.
                bus.publish(
                    {
                        "kind": "tool_call",
                        "agent": author,
                        "tool": fc.name,
                        "args": dict(fc.args or {}),
                        "call_id": getattr(fc, "id", None) or f"{author}:{fc.name}",
                    }
                )
                continue

            if fr:
                bus.publish(
                    {
                        "kind": "tool_result",
                        "agent": author,
                        "tool": fr.name,
                        "call_id": getattr(fr, "id", None) or f"{author}:{fr.name}",
                        "summary": _summarise_tool_result(fr.response),
                        "payload": _payload_for_ui(fr.name, fr.response),
                    }
                )
                continue

            if text:
                if partial:
                    bus.publish(
                        {"kind": "text_delta", "agent": author, "text": text}
                    )
                else:
                    # Final consolidated text. Capture it for the turn reply.
                    final_text_parts.append(text)

        # 4. agent_done — end_of_agent flag set by ADK at agent termination.
        if actions and getattr(actions, "end_of_agent", False):
            bus.publish({"kind": "agent_done", "agent": author})

    return "".join(final_text_parts).strip()
