"""Load sample grocery products into MongoDB with Voyage AI embeddings.

Embeddings are produced via the Atlas Embedding & Reranking API and stored
in the `embedding` field alongside each document.

Run: python -m scripts.ingest
"""
from __future__ import annotations

import json
import logging
import sys
from pathlib import Path

from pymongo import ReplaceOne

from agent import db
from agent.config import SETTINGS
from agent.embeddings import embed_documents

logging.basicConfig(level=SETTINGS.log_level, format="%(levelname)s %(name)s: %(message)s")
log = logging.getLogger("ingest")

DATA_FILE = Path(__file__).resolve().parent.parent / "data" / "products.json"

BATCH_SIZE = 20


def main() -> int:
    db.ping()
    products = json.loads(DATA_FILE.read_text())
    log.info("loaded %d products from %s", len(products), DATA_FILE.name)

    # Embed product text in batches
    texts = [p["text"] for p in products]
    all_embeddings: list[list[float]] = []
    for i in range(0, len(texts), BATCH_SIZE):
        batch = texts[i : i + BATCH_SIZE]
        all_embeddings.extend(embed_documents(batch))
        log.info("embedded %d / %d", min(i + BATCH_SIZE, len(texts)), len(texts))

    for p, emb in zip(products, all_embeddings):
        p["embedding"] = emb

    ops = [ReplaceOne({"sku": p["sku"]}, p, upsert=True) for p in products]
    result = db.products().bulk_write(ops, ordered=False)
    log.info(
        "upserted=%d modified=%d matched=%d",
        result.upserted_count,
        result.modified_count,
        result.matched_count,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
