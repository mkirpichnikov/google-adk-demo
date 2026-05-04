"""Construct the ADK Runner with MongoDB-backed session and memory services.

`StreamingMode.SSE` means partial token events are yielded by the runner
(see flows/llm_flows/base_llm_flow.py:1217). Without it, ADK accumulates
deltas internally and yields only the final consolidated response — which
defeats the live UI.
"""
from __future__ import annotations

from functools import lru_cache

from google.adk.agents.run_config import RunConfig, StreamingMode
from google.adk.runners import Runner
from google.genai import types as genai_types

from agent.config import SETTINGS
from agent.core import ROOT_AGENT
from agent.memory_service import MongoMemoryService
from agent.session_service import MongoSessionService


@lru_cache(maxsize=1)
def get_runner() -> Runner:
    return Runner(
        app_name=SETTINGS.app_name,
        agent=ROOT_AGENT,
        session_service=MongoSessionService(),
        memory_service=MongoMemoryService(),
    )


def streaming_run_config() -> RunConfig:
    """RunConfig that enables token-by-token streaming for the live UI."""
    return RunConfig(streaming_mode=StreamingMode.SSE)


def text_message(text: str) -> genai_types.Content:
    """Wrap user text in the Content type ADK expects."""
    return genai_types.Content(
        role="user",
        parts=[genai_types.Part.from_text(text=text)],
    )
