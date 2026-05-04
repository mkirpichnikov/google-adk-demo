"""Single MongoClient for the process. PyMongo manages its own pool.

The MongoLiveListener is registered on the singleton client so every
command issued by the app is observed and published to the active
request's EventBus (via contextvars). Out-of-request commands have no
bus bound and are dropped silently — that's how heartbeats and healthz
pings stay out of the live UI.
"""
from __future__ import annotations

from functools import lru_cache

from pymongo import MongoClient
from pymongo.collection import Collection
from pymongo.database import Database

from agent.config import SETTINGS
from agent.db_listener import MongoLiveListener


@lru_cache(maxsize=1)
def get_client() -> MongoClient:
    return MongoClient(
        SETTINGS.mongodb_uri,
        appname=SETTINGS.app_name,
        event_listeners=[MongoLiveListener()],
    )


def get_db() -> Database:
    return get_client()[SETTINGS.mongodb_db]


def products() -> Collection:
    return get_db()[SETTINGS.products_collection]


def sessions() -> Collection:
    return get_db()[SETTINGS.sessions_collection]


def memory() -> Collection:
    return get_db()[SETTINGS.memory_collection]


def artifacts() -> Collection:
    return get_db()[SETTINGS.artifacts_collection]


def ping() -> bool:
    get_client().admin.command("ping")
    return True
