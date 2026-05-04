"""Centralised runtime config. Reads .env at import time."""
from __future__ import annotations

import os
from dataclasses import dataclass

from dotenv import load_dotenv

load_dotenv()


def _required(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"Missing required env var: {name}")
    return value


@dataclass(frozen=True)
class Settings:
    gcp_project: str
    gcp_location: str
    gemini_model: str
    app_name: str
    mongodb_uri: str
    mongodb_db: str
    products_collection: str
    products_vector_index: str
    embedding_model: str
    embedding_dimensions: int
    voyage_api_key: str
    voyage_api_url: str
    sessions_collection: str
    memory_collection: str
    artifacts_collection: str
    log_level: str


def load_settings() -> Settings:
    return Settings(
        gcp_project=_required("GOOGLE_CLOUD_PROJECT"),
        gcp_location=os.getenv("GOOGLE_CLOUD_LOCATION", "us-central1"),
        gemini_model=os.getenv("GEMINI_MODEL", "gemini-2.5-flash"),
        app_name=os.getenv("APP_NAME", "grocery_assistant"),
        mongodb_uri=_required("MONGODB_URI"),
        mongodb_db=os.getenv("MONGODB_DB", "adk_demo"),
        products_collection=os.getenv("PRODUCTS_COLLECTION", "products"),
        products_vector_index=os.getenv("PRODUCTS_VECTOR_INDEX", "products_vector_index"),
        embedding_model=os.getenv("EMBEDDING_MODEL", "voyage-4-large"),
        embedding_dimensions=int(os.getenv("EMBEDDING_DIMENSIONS", "1024")),
        voyage_api_key=_required("VOYAGE_API_KEY"),
        voyage_api_url=os.getenv("VOYAGE_API_URL", "https://ai.mongodb.com/v1/embeddings"),
        sessions_collection=os.getenv("SESSIONS_COLLECTION", "sessions"),
        memory_collection=os.getenv("MEMORY_COLLECTION", "memory"),
        artifacts_collection=os.getenv("ARTIFACTS_COLLECTION", "artifacts"),
        log_level=os.getenv("LOG_LEVEL", "INFO"),
    )


SETTINGS = load_settings()
