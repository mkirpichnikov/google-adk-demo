"""ADK tools backed entirely by MongoDB.

Embeddings are produced via the Atlas Embedding & Reranking API (Voyage AI)
and stored alongside documents. $vectorSearch uses queryVector for retrieval.

`user_id` and `session_id` are NOT tool arguments — the LLM has no reliable
way to know them. They are read from `agent.context` contextvars set by the
CLI / HTTP server before the runner is invoked. This keeps the agent
focused on its actual job and prevents id hallucination.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from agent import db
from agent.config import SETTINGS
from agent.context import current_session_id, current_user_id
from agent.embeddings import embed_documents, embed_query

log = logging.getLogger(__name__)


def search_products(
    query: str,
    limit: int = 5,
    max_price: float | None = None,
    min_price: float | None = None,
    category: str | None = None,
) -> list[dict[str, Any]]:
    """Search the grocery catalog using hybrid semantic + structured filtering.

    Vector search ranks by semantic match. Optional filters (max_price,
    min_price, category) are applied as a `$match` stage AFTER `$vectorSearch`
    — a post-filter pattern. We compensate by bumping numCandidates when
    filters are present so enough hits survive to fill `limit`.

    Use this whenever the customer is looking for products, ingredients,
    substitutes, or items matching a description.

    Args:
        query: Natural-language description of what the customer wants.
        limit: Max number of products to return (default 5).
        max_price: Optional. Maximum price in AUD. Pass this ONLY when the
            customer states an explicit dollar ceiling (e.g. "under $5",
            "no more than $10"). Do NOT pass for vague terms like "cheap"
            or "budget" — let the catalog rank.
        min_price: Optional. Minimum price in AUD. Rare; pass only on
            explicit lower bounds ("at least $20").
        category: Optional. Restrict to one category — one of
            "produce", "dairy", "meat", "bakery", "pantry", "frozen",
            "snacks", "drinks", "deli", "household". Pass only when the
            customer names the category explicitly.

    Returns:
        List of matching products with sku, name, category, price, size,
        text, and a relevance score in [0,1].
    """
    query_vector = embed_query(query)

    has_filters = bool(max_price or min_price or category)
    # Bump candidate pool when filtering — Atlas can't prune at $vectorSearch
    # time without the price/category being declared as filter paths on the
    # index, so we filter after the fact and need more headroom.
    num_candidates = max(200, limit * 40) if has_filters else max(50, limit * 20)

    pipeline: list[dict[str, Any]] = [
        {
            "$vectorSearch": {
                "index": SETTINGS.products_vector_index,
                "path": "embedding",
                "queryVector": query_vector,
                "numCandidates": num_candidates,
                # Pull a wider set when filtering so $match has something to whittle.
                "limit": max(limit * 5, 25) if has_filters else limit,
            }
        }
    ]

    match: dict[str, Any] = {}
    if max_price is not None:
        match.setdefault("price", {})["$lte"] = float(max_price)
    if min_price is not None:
        match.setdefault("price", {})["$gte"] = float(min_price)
    if category:
        match["category"] = category.lower()
    if match:
        pipeline.append({"$match": match})

    pipeline.extend([
        {"$limit": limit},
        {
            "$project": {
                "_id": 0,
                "sku": 1,
                "name": 1,
                "text": 1,
                "category": 1,
                "price": 1,
                "size": 1,
                "score": {"$meta": "vectorSearchScore"},
            }
        },
    ])

    results = list(db.products().aggregate(pipeline))
    log.info(
        "search_products(query=%r, max_price=%s, category=%s) -> %d hits",
        query, max_price, category, len(results),
    )
    return results


def save_preference(preference: str) -> dict[str, str]:
    """Persist a customer preference to long-term memory.

    Use when the customer mentions a durable fact about themselves —
    dietary requirements, allergies, household size, brand preferences,
    budget targets. Do NOT use for one-off requests.

    The user identifier is read from per-turn context; the model does not
    need to supply it.

    Args:
        preference: Plain-text description of the preference.
    """
    user_id = current_user_id()
    embedding = embed_documents([preference])[0]
    db.memory().insert_one(
        {
            "user_id": user_id,
            "text": preference,
            "embedding": embedding,
            "kind": "preference",
            "created_at": datetime.now(timezone.utc),
        }
    )
    log.info("save_preference(user_id=%s) saved", user_id)
    return {"status": "saved", "preference": preference}


def record_artifact(kind: str, content: str) -> dict[str, str]:
    """Persist an agent-generated artifact (e.g. shopping list, recipe).

    The session identifier is read from per-turn context; the model does
    not need to supply it.

    Args:
        kind: Artifact type (e.g. 'shopping_list', 'recipe', 'meal_plan').
        content: The artifact body as text.
    """
    session_id = current_session_id()
    result = db.artifacts().insert_one(
        {
            "session_id": session_id,
            "kind": kind,
            "content": content,
            "created_at": datetime.now(timezone.utc),
        }
    )
    log.info("record_artifact(session=%s, kind=%s) saved", session_id, kind)
    return {"status": "saved", "artifact_id": str(result.inserted_id)}


def recall_preferences(query: str, limit: int = 5) -> list[dict[str, Any]]:
    """Recall what we already know about the current customer.

    Use when the customer asks what you remember about them, or when you
    need to check prior preferences before composing a plan. Returns
    semantic-search hits scoped to the current `user_id`.

    Args:
        query: Natural-language description of what to recall, e.g.
            "dietary preferences", "household size", "brand loyalty".
        limit: Max number of memories to return (default 5).

    Returns:
        List of memory entries with text, kind, score, and created_at.
    """
    user_id = current_user_id()
    query_vector = embed_query(query)
    pipeline = [
        {
            "$vectorSearch": {
                "index": f"{SETTINGS.memory_collection}_vector_index",
                "path": "embedding",
                "queryVector": query_vector,
                "numCandidates": max(50, limit * 20),
                "limit": limit,
                "filter": {"user_id": user_id},
            }
        },
        {
            "$project": {
                "_id": 0,
                "text": 1,
                "kind": 1,
                "created_at": 1,
                "score": {"$meta": "vectorSearchScore"},
            }
        },
    ]
    results = list(db.memory().aggregate(pipeline))
    log.info("recall_preferences(user=%s, query=%r) -> %d hits", user_id, query, len(results))
    return results


ALL_TOOLS = [search_products, save_preference, record_artifact, recall_preferences]
