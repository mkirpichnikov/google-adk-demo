"""Interactive CLI for local demos. Conversation persists to MongoDB."""
from __future__ import annotations

import asyncio
import logging
import sys
import uuid

from agent import db
from agent.config import SETTINGS
from agent.context import bind_turn_context
from agent.runner import get_runner, text_message

logging.basicConfig(level=SETTINGS.log_level, format="%(levelname)s %(name)s: %(message)s")
log = logging.getLogger("cli")


def _format_recalled(hits: list[dict]) -> str:
    """Render memory hits as a short context block the agent can read.

    Empty list returns an empty string (no block prepended)."""
    if not hits:
        return ""
    bullets = "\n".join(f"- {h.get('text','').strip()}" for h in hits if h.get("text"))
    if not bullets:
        return ""
    return f"[Known about this customer]\n{bullets}\n\n"


async def converse(user_id: str) -> None:
    runner = get_runner()
    memory_service = runner.memory_service
    session = await runner.session_service.create_session(
        app_name=SETTINGS.app_name, user_id=user_id
    )
    print(f"\nNew session: {session.id}\nUser: {user_id}\nType 'exit' to quit.\n")

    while True:
        try:
            message = input("you> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if not message:
            continue
        if message.lower() in {"exit", "quit"}:
            break

        # Recall long-term memory via the MongoDB-backed MemoryService and
        # prepend any hits to the message before the runner sees it. This is
        # the read path that exercises MongoMemoryService.search_memory.
        recalled = await memory_service.search_memory(
            app_name=SETTINGS.app_name, user_id=user_id, query=message
        )
        prefix = _format_recalled(recalled)
        if prefix:
            log.info("recalled %d memory hit(s) for user=%s", len(recalled), user_id)

        with bind_turn_context(user_id=user_id, session_id=session.id):
            async for event in runner.run_async(
                user_id=user_id,
                session_id=session.id,
                new_message=text_message(prefix + message),
            ):
                content = getattr(event, "content", None)
                if not content:
                    continue
                for part in getattr(content, "parts", []) or []:
                    if getattr(part, "text", None):
                        print(f"agent> {part.text.strip()}")
                    if getattr(part, "function_call", None):
                        fc = part.function_call
                        print(f"  [tool: {fc.name}({dict(fc.args or {})})]")

    # Write a session summary to long-term memory on exit. This is the
    # write path that exercises MongoMemoryService.add_session_to_memory.
    final_session = await runner.session_service.get_session(
        app_name=SETTINGS.app_name, user_id=user_id, session_id=session.id
    )
    if final_session is not None:
        await memory_service.add_session_to_memory(final_session)
        log.info("session summary stored to memory for user=%s", user_id)


def main() -> int:
    db.ping()
    user_id = sys.argv[1] if len(sys.argv) > 1 else f"demo-{uuid.uuid4().hex[:8]}"
    asyncio.run(converse(user_id))
    return 0


if __name__ == "__main__":
    sys.exit(main())
