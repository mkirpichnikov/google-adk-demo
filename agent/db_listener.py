"""PyMongo CommandListener that publishes per-request `db_op` events.

Registered on the singleton MongoClient. On every command (find, aggregate,
insert, update, delete), the listener checks the current contextvar for an
EventBus and publishes a structured event. Out-of-request operations
(healthz pings, startup heartbeats) have no bus bound and are dropped.

Concurrency note: PyMongo invokes listener callbacks on the calling thread.
For sync PyMongo inside async FastAPI, that calling thread is the asyncio
loop thread when the call is direct, or a worker thread when wrapped in
`run_in_executor`. EventBus.publish_threadsafe handles both via
`call_soon_threadsafe`. Contextvars propagate into worker threads on
Python 3.7+ because the executor copies the current context.
"""
from __future__ import annotations

import logging
from typing import Any

from pymongo import monitoring

from agent.context import current_event_queue, _event_queue
from agent.event_bus import EventBus

log = logging.getLogger(__name__)

# Commands worth surfacing in the demo UI.
_INTERESTING_COMMANDS: frozenset[str] = frozenset(
    {"aggregate", "find", "insert", "update", "delete", "findAndModify"}
)


def _get_collection(command: dict[str, Any], command_name: str) -> str:
    """The first key of the command doc names the collection."""
    coll = command.get(command_name)
    if isinstance(coll, str):
        return coll
    return "?"


def _is_vector_search(command: dict[str, Any], command_name: str) -> bool:
    """Detect $vectorSearch as the first stage of an aggregate pipeline."""
    if command_name != "aggregate":
        return False
    pipeline = command.get("pipeline") or []
    if not pipeline:
        return False
    first = pipeline[0]
    return isinstance(first, dict) and "$vectorSearch" in first


def _doc_count_started(command: dict[str, Any], command_name: str) -> int | None:
    if command_name == "insert":
        docs = command.get("documents")
        return len(docs) if isinstance(docs, list) else None
    if command_name in {"update", "delete"}:
        items = command.get("updates" if command_name == "update" else "deletes")
        return len(items) if isinstance(items, list) else None
    return None


def _doc_count_succeeded(command_name: str, reply: dict[str, Any]) -> int | None:
    if command_name == "insert":
        return reply.get("n")
    if command_name in {"update", "delete"}:
        return reply.get("n")
    if command_name in {"aggregate", "find"}:
        cursor = reply.get("cursor") or {}
        first_batch = cursor.get("firstBatch")
        if isinstance(first_batch, list):
            return len(first_batch)
    return None


# Map (request_id, command_name) → bus reference. Lets us route the
# success/failure events to the same per-request bus that saw the start
# event, even if PyMongo dispatches the success on a different thread.
_pending: dict[int, tuple[Any, str, str]] = {}


def _bus_from_context() -> EventBus | None:
    queue = current_event_queue()
    if queue is None:
        return None
    # `current_event_queue` returns the raw asyncio.Queue; we attach the
    # bus reference via a parallel contextvar.
    bus = _bus_var.get()
    return bus


# Parallel contextvar holding the bus directly (so listener callbacks
# don't need to reconstruct one from the queue).
from contextvars import ContextVar

_bus_var: ContextVar[EventBus | None] = ContextVar("adk_demo_bus", default=None)


def set_bus(bus: EventBus | None):
    """Bind the bus into the current context. Returns the token to reset."""
    return _bus_var.set(bus)


def reset_bus(token):
    _bus_var.reset(token)


class MongoLiveListener(monitoring.CommandListener):
    """Publishes per-command events into the active request's EventBus.

    Out-of-request commands (current_event_queue() is None) are silently
    dropped — that's how healthz pings and driver heartbeats stay out of
    the live UI.
    """

    def started(self, event: monitoring.CommandStartedEvent) -> None:  # noqa: D401
        if event.command_name not in _INTERESTING_COMMANDS:
            return
        bus = _bus_var.get()
        if bus is None:
            return
        try:
            collection = _get_collection(event.command, event.command_name)
            payload = {
                "kind": "db_op",
                "phase": "start",
                "request_id": event.request_id,
                "op": event.command_name,
                "collection": collection,
                "vector_search": _is_vector_search(event.command, event.command_name),
                "doc_count": _doc_count_started(event.command, event.command_name),
            }
            _pending[event.request_id] = (bus, event.command_name, collection)
            bus.publish_threadsafe(payload)
        except Exception:  # noqa: BLE001
            log.exception("MongoLiveListener.started failed")

    def succeeded(self, event: monitoring.CommandSucceededEvent) -> None:
        record = _pending.pop(event.request_id, None)
        if record is None:
            return
        bus, command_name, collection = record
        try:
            payload = {
                "kind": "db_op",
                "phase": "end",
                "request_id": event.request_id,
                "op": command_name,
                "collection": collection,
                "duration_ms": event.duration_micros / 1000.0,
                "doc_count": _doc_count_succeeded(command_name, event.reply or {}),
                "ok": True,
            }
            bus.publish_threadsafe(payload)
        except Exception:  # noqa: BLE001
            log.exception("MongoLiveListener.succeeded failed")

    def failed(self, event: monitoring.CommandFailedEvent) -> None:
        record = _pending.pop(event.request_id, None)
        if record is None:
            return
        bus, command_name, collection = record
        try:
            payload = {
                "kind": "db_op",
                "phase": "end",
                "request_id": event.request_id,
                "op": command_name,
                "collection": collection,
                "duration_ms": event.duration_micros / 1000.0,
                "ok": False,
                "error": str(event.failure)[:200],
            }
            bus.publish_threadsafe(payload)
        except Exception:  # noqa: BLE001
            log.exception("MongoLiveListener.failed failed")
