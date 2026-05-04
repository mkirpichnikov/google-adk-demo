"""Create Atlas Vector Search indexes.

Indexes use standard `vector` type with pre-computed embeddings stored in
the `embedding` field. Embeddings are produced client-side via the Atlas
Embedding & Reranking API (Voyage AI).

Run: python -m scripts.create_index
"""
from __future__ import annotations

import logging
import sys
import time

from pymongo.errors import OperationFailure
from pymongo.operations import SearchIndexModel

from agent import db
from agent.config import SETTINGS

logging.basicConfig(level=SETTINGS.log_level, format="%(levelname)s %(name)s: %(message)s")
log = logging.getLogger("create_index")


def _vector_definition(filter_fields: list[str]) -> dict:
    """Standard vector index definition with pre-computed embeddings."""
    fields: list[dict] = [
        {
            "type": "vector",
            "path": "embedding",
            "numDimensions": SETTINGS.embedding_dimensions,
            "similarity": "cosine",
        }
    ]
    for fp in filter_fields:
        fields.append({"type": "filter", "path": fp})
    return {"fields": fields}


def _ensure_index(collection, index_name: str, filter_fields: list[str]) -> None:
    existing = {idx["name"] for idx in collection.list_search_indexes()}
    if index_name in existing:
        log.info("index '%s' already exists on %s — skipping", index_name, collection.name)
        return

    model = SearchIndexModel(
        definition=_vector_definition(filter_fields),
        name=index_name,
        type="vectorSearch",
    )
    collection.create_search_index(model=model)
    log.info(
        "index '%s' submitted on %s (dims=%d, cosine) — Atlas builds asynchronously",
        index_name, collection.name, SETTINGS.embedding_dimensions,
    )


def _wait_until_queryable(collection, index_name: str, timeout_s: int = 600) -> None:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        for idx in collection.list_search_indexes(name=index_name):
            if idx.get("queryable"):
                log.info("index '%s' is queryable", index_name)
                return
        log.info("waiting for '%s' to become queryable...", index_name)
        time.sleep(10)
    log.warning("timed out waiting for '%s' — check Atlas UI for build status", index_name)


def main() -> int:
    db.ping()
    log.info("connected to MongoDB; database=%s", SETTINGS.mongodb_db)

    targets = [
        (db.products(), SETTINGS.products_vector_index, []),
        (db.memory(), f"{SETTINGS.memory_collection}_vector_index", ["user_id"]),
    ]
    for coll, name, filters in targets:
        _ensure_index(coll, name, filters)
    for coll, name, _ in targets:
        _wait_until_queryable(coll, name)

    return 0


if __name__ == "__main__":
    sys.exit(main())
