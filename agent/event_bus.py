"""Per-request event bus.

One EventBus is created per `/chat/stream` request and bound into the
contextvars before the agent runs. The bus owns an `asyncio.Queue` that
the SSE endpoint drains. Both the ADK event translator and the PyMongo
command listener publish onto the same queue so the UI sees a single
ordered stream of events.

The queue is unbounded — each request lasts seconds, the rate is bounded
by Gemini and Mongo throughput, and dropping events would corrupt the
animations. If a stream stalls, the request times out at the server level.
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from typing import Any, Optional

log = logging.getLogger(__name__)

# Sentinel placed on the queue to tell the SSE drainer to close the stream.
END_SENTINEL: dict = {"kind": "__end__"}


class EventBus:
    """Per-request fan-in queue for SSE events."""

    def __init__(self, *, request_id: Optional[str] = None) -> None:
        self.request_id = request_id or str(uuid.uuid4())
        self.queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self.loop: asyncio.AbstractEventLoop = asyncio.get_event_loop()

    def publish(self, event: dict[str, Any]) -> None:
        """Put an event on the queue from the asyncio loop thread."""
        self.queue.put_nowait(event)

    def publish_threadsafe(self, event: dict[str, Any]) -> None:
        """Put an event on the queue from any thread.

        The PyMongo command listener may fire on either the asyncio loop
        thread (sync calls inside async code path) or a worker thread (sync
        calls dispatched via run_in_executor). `call_soon_threadsafe` works
        in either case.
        """
        try:
            self.loop.call_soon_threadsafe(self.queue.put_nowait, event)
        except RuntimeError:
            # Loop already closed (request ended). Drop silently.
            log.debug("dropped event after loop close: %s", event.get("kind"))

    def close(self) -> None:
        """Signal the SSE drainer that the stream is done."""
        self.publish(END_SENTINEL)
