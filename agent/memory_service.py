"""MongoDB-backed ADK MemoryService.

Long-term memory is stored in the `memory` collection. Embeddings are
produced via the Atlas Embedding & Reranking API (Voyage AI) and stored
alongside documents. Retrieval uses $vectorSearch with queryVector.

Note: ADK's BaseMemoryService surface evolves. The methods here implement
the core contract; if the installed version requires additional methods,
they should read/write the same collection.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from google.adk.memory import BaseMemoryService
from google.adk.sessions import Session

from agent import db
from agent.config import SETTINGS
from agent.embeddings import embed_documents, embed_query

log = logging.getLogger(__name__)

MEMORY_VECTOR_INDEX = f"{SETTINGS.memory_collection}_vector_index"


class MongoMemoryService(BaseMemoryService):
    """Persists session-derived memory and retrieves it via vector search."""

    async def add_session_to_memory(self, session: Session) -> None:
        """Summarise a finished session and store it for future recall."""
        text = self._summarise(session)
        if not text:
            return
        embedding = embed_documents([text])[0]
        db.memory().insert_one(
            {
                "user_id": session.user_id,
                "session_id": session.id,
                "text": text,
                "embedding": embedding,
                "kind": "session_summary",
                "created_at": datetime.now(timezone.utc),
            }
        )
        log.info("memory: stored summary for session=%s", session.id)

    async def search_memory(
        self, *, app_name: str, user_id: str, query: str
    ) -> list[dict[str, Any]]:
        query_vector = embed_query(query)
        pipeline = [
            {
                "$vectorSearch": {
                    "index": MEMORY_VECTOR_INDEX,
                    "path": "embedding",
                    "queryVector": query_vector,
                    "numCandidates": 50,
                    "limit": 5,
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
        return list(db.memory().aggregate(pipeline))

    @staticmethod
    def _summarise(session: Session) -> str:
        """Cheap summary — concatenate user/agent text from the session events.

        For production, replace with a call to Gemini that produces a
        structured summary. For the example application, raw concatenation
        is enough to demonstrate semantic recall.
        """
        parts: list[str] = []
        for event in session.events:
            content = getattr(event, "content", None)
            if not content:
                continue
            for part in getattr(content, "parts", []) or []:
                if getattr(part, "text", None):
                    parts.append(part.text.strip())
        return " ".join(p for p in parts if p)[:4000]
