"""Smoke tests. Most are skipped without live MongoDB; the import-graph test
catches the most common breakage (typos, circular imports, missing deps)
without needing any external services.
"""
from __future__ import annotations

import os

import pytest


def test_imports_resolve():
    """All agent modules import cleanly with env vars set."""
    os.environ.setdefault("GOOGLE_CLOUD_PROJECT", "test-project")
    os.environ.setdefault("MONGODB_URI", "mongodb://localhost:27017")

    import agent.config  # noqa: F401
    import agent.db  # noqa: F401
    import agent.tools  # noqa: F401
    import agent.core  # noqa: F401


@pytest.mark.skipif(not os.getenv("MONGODB_URI_LIVE"), reason="needs live Atlas")
def test_vector_search_returns_results():
    """End-to-end: query the products vector index. Run only against a
    populated cluster by setting MONGODB_URI_LIVE in your shell."""
    os.environ["MONGODB_URI"] = os.environ["MONGODB_URI_LIVE"]
    from agent.tools import search_products

    hits = search_products("healthy school lunchbox", limit=3)
    assert hits, "expected at least one match"
    assert all("score" in h for h in hits)
    assert all(0.0 <= h["score"] <= 1.0 for h in hits)
