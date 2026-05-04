"""Per-turn execution context.

Three contextvars travel with each /chat request:
- `user_id` — read by tools to scope writes (save_preference, etc.)
- `session_id` — read by tools and the DB listener
- `event_queue` — the async queue the SSE endpoint drains. The PyMongo
  CommandListener reads this contextvar at callback time so it can publish
  `db_op` events to the right per-request stream.

ADK tools cannot reliably ask the LLM for `user_id` / `session_id` — the
model would hallucinate them. The HTTP server sets these contextvars before
invoking the runner, and tools read from them. The values are invisible
to the LLM.
"""
from __future__ import annotations

import asyncio
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Iterator, Optional

_user_id: ContextVar[Optional[str]] = ContextVar("adk_demo_user_id", default=None)
_session_id: ContextVar[Optional[str]] = ContextVar("adk_demo_session_id", default=None)
_event_queue: ContextVar[Optional[asyncio.Queue]] = ContextVar(
    "adk_demo_event_queue", default=None
)
_event_loop: ContextVar[Optional[asyncio.AbstractEventLoop]] = ContextVar(
    "adk_demo_event_loop", default=None
)


def current_user_id() -> str:
    value = _user_id.get()
    if not value:
        raise RuntimeError(
            "user_id is not set in this context. "
            "Use bind_turn_context(user_id=..., session_id=...) before invoking the runner."
        )
    return value


def current_session_id() -> str:
    value = _session_id.get()
    if not value:
        raise RuntimeError(
            "session_id is not set in this context. "
            "Use bind_turn_context(user_id=..., session_id=...) before invoking the runner."
        )
    return value


def current_event_queue() -> Optional[asyncio.Queue]:
    """Return the per-request event queue, or None if no request is active.

    The PyMongo command listener calls this from a worker thread; returning
    None for out-of-request operations (healthz, startup pings) is the
    intended way to silently drop those.
    """
    return _event_queue.get()


def current_event_loop() -> Optional[asyncio.AbstractEventLoop]:
    """The event loop owning the current request's queue.

    Listener callbacks may run on the asyncio loop thread (when PyMongo is
    invoked from `await ... in_executor`-wrapped sync code), or directly on
    the loop thread itself. Holding the loop reference lets us schedule
    `queue.put_nowait` thread-safely from either source.
    """
    return _event_loop.get()


@contextmanager
def bind_turn_context(
    *,
    user_id: str,
    session_id: str,
    event_queue: Optional[asyncio.Queue] = None,
    event_loop: Optional[asyncio.AbstractEventLoop] = None,
) -> Iterator[None]:
    user_token = _user_id.set(user_id)
    session_token = _session_id.set(session_id)
    queue_token = _event_queue.set(event_queue)
    loop_token = _event_loop.set(event_loop)
    try:
        yield
    finally:
        _user_id.reset(user_token)
        _session_id.reset(session_token)
        _event_queue.reset(queue_token)
        _event_loop.reset(loop_token)
