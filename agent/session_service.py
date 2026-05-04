"""MongoDB-backed ADK SessionService.

Implements the BaseSessionService interface so all session state — turns,
events, agent scratchpad — lives in the `sessions` collection. This is the
template's headline claim: MongoDB is the only datastore.

Note: ADK's BaseSessionService surface evolves; methods here cover the core
contract (create / get / list / append_event / delete). If the installed
`google-adk` version exposes additional abstract methods, add thin pass-
throughs that read/write the same `sessions` document.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from google.adk.events import Event
from google.adk.sessions import BaseSessionService, Session
from google.adk.sessions.base_session_service import ListSessionsResponse

from agent import db

log = logging.getLogger(__name__)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _doc_to_session(doc: dict[str, Any]) -> Session:
    return Session(
        id=doc["_id"],
        app_name=doc["app_name"],
        user_id=doc["user_id"],
        state=doc.get("state", {}),
        events=[Event.model_validate(e) for e in doc.get("events", [])],
        last_update_time=doc.get("last_update_time", _now()).timestamp(),
    )


class MongoSessionService(BaseSessionService):
    """Persists ADK sessions to MongoDB. One document per session."""

    async def create_session(
        self,
        *,
        app_name: str,
        user_id: str,
        state: Optional[dict[str, Any]] = None,
        session_id: Optional[str] = None,
    ) -> Session:
        sid = session_id or str(uuid.uuid4())
        doc = {
            "_id": sid,
            "app_name": app_name,
            "user_id": user_id,
            "state": state or {},
            "events": [],
            "created_at": _now(),
            "last_update_time": _now(),
        }
        db.sessions().insert_one(doc)
        log.info("create_session id=%s user=%s", sid, user_id)
        return _doc_to_session(doc)

    async def get_session(
        self,
        *,
        app_name: str,
        user_id: str,
        session_id: str,
        config: Optional[Any] = None,
    ) -> Optional[Session]:
        doc = db.sessions().find_one(
            {"_id": session_id, "app_name": app_name, "user_id": user_id}
        )
        return _doc_to_session(doc) if doc else None

    async def list_sessions(
        self, *, app_name: str, user_id: Optional[str] = None
    ) -> ListSessionsResponse:
        query: dict[str, Any] = {"app_name": app_name}
        if user_id:
            query["user_id"] = user_id
        cursor = db.sessions().find(query).sort("last_update_time", -1)
        return ListSessionsResponse(sessions=[_doc_to_session(d) for d in cursor])

    async def delete_session(
        self, *, app_name: str, user_id: str, session_id: str
    ) -> None:
        db.sessions().delete_one(
            {"_id": session_id, "app_name": app_name, "user_id": user_id}
        )

    async def append_event(self, session: Session, event: Event) -> Event:
        # Mutate the in-memory session first (appends to session.events,
        # applies state deltas, trims temp state). The Runner reads
        # session.events to build LlmRequest.contents on the next LLM call,
        # so skipping this leaves the user's message invisible to the model.
        # super() returns early without mutating when event.partial=True;
        # mirror that here so streaming chunks aren't persisted to Mongo.
        if event.partial:
            return await super().append_event(session=session, event=event)
        await super().append_event(session=session, event=event)

        db.sessions().update_one(
            {"_id": session.id},
            {
                "$push": {"events": event.model_dump(mode="json")},
                "$set": {
                    "state": session.state,
                    "last_update_time": _now(),
                },
            },
        )
        return event
