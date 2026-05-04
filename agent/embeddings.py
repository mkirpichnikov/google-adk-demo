"""Voyage AI embedding client via the Atlas Embedding & Reranking API.

Endpoint: https://ai.mongodb.com/v1/embeddings
Auth: Bearer token using an Atlas Model API Key.
"""
from __future__ import annotations

import logging
from typing import Optional

import requests

from agent.config import SETTINGS

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

    resp = _get_session().post(SETTINGS.voyage_api_url, json=body, timeout=30)
    resp.raise_for_status()
    data = resp.json()["data"]
    return [item["embedding"] for item in data]


def embed_query(query: str, *, model: str | None = None) -> list[float]:
    """Embed a single search query."""
    return embed_texts([query], model=model, input_type="query")[0]


def embed_documents(docs: list[str], *, model: str | None = None) -> list[list[float]]:
    """Embed a batch of documents for indexing."""
    return embed_texts(docs, model=model, input_type="document")
