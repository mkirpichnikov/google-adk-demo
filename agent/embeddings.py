"""Voyage AI embedding client via the Atlas Embedding & Reranking API.

Endpoint: https://ai.mongodb.com/v1/embeddings
Auth: Bearer token using an Atlas Model API Key.

Each call publishes a `voyage_call` event with phase=start/end onto the
per-request EventBus (when one is bound via `set_bus` from the server).
The UI uses these events to pulse the Atlas Embedding API node on the
live graph, the same way `db_op` events pulse MongoDB collection nodes.
"""
from __future__ import annotations

import logging
import time
from typing import Optional

import requests

from agent.config import SETTINGS
from agent.db_listener import _bus_var

log = logging.getLogger(__name__)

_SESSION: Optional[requests.Session] = None


def _get_session() -> requests.Session:
    global _SESSION
    if _SESSION is None:
        _SESSION = requests.Session()
        _SESSION.headers.update(
            {
                "Authorization": f"Bearer {SETTINGS.voyage_api_key}",
                "Content-Type": "application/json",
            }
        )
    return _SESSION


def _publish(payload: dict) -> None:
    """Best-effort publish to the active request's bus.

    Out-of-request callers (ingest scripts, smoke tests) have no bus
    bound; we silently drop in that case so the embedding path still
    works outside the server.
    """
    bus = _bus_var.get()
    if bus is None:
        return
    try:
        bus.publish_threadsafe(payload)
    except Exception:  # noqa: BLE001
        log.exception("voyage_call publish failed")


def embed_texts(
    texts: list[str],
    *,
    model: str | None = None,
    input_type: str | None = None,
) -> list[list[float]]:
    """Return embedding vectors for a batch of texts."""
    model = model or SETTINGS.embedding_model
    body: dict = {"input": texts, "model": model}
    if input_type:
        body["input_type"] = input_type

    started = time.perf_counter()
    _publish(
        {
            "kind": "voyage_call",
            "phase": "start",
            "model": model,
            "input_type": input_type or "document",
            "text_count": len(texts),
        }
    )
    try:
        resp = _get_session().post(SETTINGS.voyage_api_url, json=body, timeout=30)
        resp.raise_for_status()
        data = resp.json()["data"]
        result = [item["embedding"] for item in data]
        _publish(
            {
                "kind": "voyage_call",
                "phase": "end",
                "model": model,
                "input_type": input_type or "document",
                "text_count": len(texts),
                "duration_ms": (time.perf_counter() - started) * 1000.0,
                "ok": True,
            }
        )
        return result
    except Exception as exc:
        _publish(
            {
                "kind": "voyage_call",
                "phase": "end",
                "model": model,
                "input_type": input_type or "document",
                "text_count": len(texts),
                "duration_ms": (time.perf_counter() - started) * 1000.0,
                "ok": False,
                "error": str(exc)[:200],
            }
        )
        raise


def embed_query(query: str, *, model: str | None = None) -> list[float]:
    """Embed a single search query."""
    return embed_texts([query], model=model, input_type="query")[0]


def embed_documents(docs: list[str], *, model: str | None = None) -> list[list[float]]:
    """Embed a batch of documents for indexing."""
    return embed_texts(docs, model=model, input_type="document")
