# Memory Architecture

How conversation state and long-term memory work in this agent. Two layers, both backed by MongoDB Atlas, deliberately kept distinct.

> Keep this file in sync with the code. If you change `agent/session_service.py`, `agent/memory_service.py`, `agent/tools.py` (memory tools), `agent/server.py` (recall plumbing), or `agent/core.py` (memory-related prompt rules), update this doc in the same change.

---

## TL;DR

| Layer | Purpose | Collection | Service | Lifetime |
|---|---|---|---|---|
| **Sessions** | Within-conversation working memory: every user message, tool call, tool result, and model reply for a single chat thread | `sessions` | `MongoSessionService` ([agent/session_service.py](agent/session_service.py)) | Per chat thread; reused when a client passes the same `session_id` |
| **Long-term memory** | Cross-session facts about the customer (preferences, dietary needs, household size, summaries) | `memory` | `MongoMemoryService` ([agent/memory_service.py](agent/memory_service.py)) | Persistent across sessions, scoped by `user_id` |

Sessions are **replayed verbatim** to the LLM as conversation history. Memory is **semantically retrieved** via vector search and injected as a system-style preface into the user message.

---

## Layer 1: Sessions (working memory)

### What's stored

One MongoDB document per chat thread, in the `sessions` collection:

```json
{
  "_id": "cf97865c-cfc2-463b-8197-396c2da31026",
  "app_name": "grocery_assistant",
  "user_id": "customer-123",
  "state": {},
  "events": [
    { "author": "user",                 "content": { "role": "user",  "parts": [{ "text": "..." }] } },
    { "author": "grocery_orchestrator", "content": { "role": "model", "parts": [{ "function_call":  { "name": "search_products", "args": {...} } }] } },
    { "author": "grocery_orchestrator", "content": { "role": "user",  "parts": [{ "function_response": { "name": "search_products", "response": {...} } }] } },
    { "author": "grocery_orchestrator", "content": { "role": "model", "parts": [{ "text": "Here are some options..." }] } }
  ],
  "created_at": "...",
  "last_update_time": "..."
}
```

`events` is an append-only log of every step in every turn — user inputs, model `function_call` parts, tool results (recorded as `function_response` parts authored by the agent), and the final model text. ADK reconstructs `LlmRequest.contents` from this list on every model call, which is how the model sees prior turns and tool outcomes.

### Service contract

`MongoSessionService` extends `BaseSessionService` and implements:

- `create_session` — insert one document.
- `get_session` — fetch by `(app_name, user_id, session_id)` and reconstruct `Session` + `Event` Pydantic objects from the stored dicts.
- `list_sessions`, `delete_session` — CRUD.
- `append_event` — **the load-bearing one** (see gotcha below).

### ⚠️ The `append_event` gotcha

`BaseSessionService.append_event` does two things:
1. Mutates the **in-memory** `session` object: applies state deltas, appends to `session.events`.
2. Subclasses are expected to *additionally* persist to storage.

The Runner reads `session.events` from the in-memory object to assemble the next `LlmRequest.contents`. If a subclass overrides `append_event` and only writes to storage without mutating the in-memory list, **the new event is invisible to the next LLM call within the same turn** — the user's message, tool calls, and tool results all silently disappear from the model's view, and ADK falls back to the placeholder `"Handle the requests as specified in the System Instruction."`. The model then produces a generic reply with no tool calls.

`MongoSessionService.append_event` therefore calls `super().append_event(...)` first (in-memory update) and then persists to MongoDB. Partial (streaming) events get the in-memory update only — they're not persisted, matching the base class behaviour. This is the only reason this pattern exists; do not "simplify" by removing the `super()` call.

---

## Layer 2: Long-term memory (cross-session)

### What's stored

One MongoDB document per remembered fact in the `memory` collection:

```json
{
  "user_id": "customer-123",
  "text": "vegetarian",
  "embedding": [ 0.0123, -0.0456, ... ],   // 1024-dim Voyage vector
  "kind": "preference",                      // or "session_summary"
  "created_at": "...",
  "session_id": "..."                        // present for kind=session_summary
}
```

Two `kind` values today:
- `preference` — written explicitly by the `save_preference` tool ([agent/tools.py:69](agent/tools.py#L69)) when the LLM detects a durable customer fact.
- `session_summary` — written by `MongoMemoryService.add_session_to_memory` when a session is committed to long-term memory. The current `_summarise` is a cheap concatenation of all text parts, capped at 4000 chars; replace with a Gemini summarisation call when this matters.

### Vector index

Atlas Vector Search index on the `memory` collection — name from `SETTINGS.memory_collection + "_vector_index"` (default `memory_vector_index`):

```json
{
  "fields": [
    { "type": "vector", "path": "embedding", "numDimensions": 1024, "similarity": "cosine" },
    { "type": "filter", "path": "user_id" }
  ]
}
```

The `filter` path on `user_id` is mandatory — it scopes recall to one customer and prevents cross-customer leakage. See [scripts/create_index.py](scripts/create_index.py) for the actual index definitions in code.

### Read path: recall on every turn

Recall is plumbed through the HTTP layer, not the agent's tools:

1. `POST /chat` arrives at [agent/server.py:80](agent/server.py#L80).
2. *Before* the runner is invoked, the server calls `MemoryService.search_memory(user_id, query=req.message)` — see [agent/server.py:97-99](agent/server.py#L97-L99).
3. `MongoMemoryService.search_memory` embeds the query with Voyage and runs `$vectorSearch` against `memory_vector_index`, filtered on `user_id`, top-5.
4. Results are formatted by `_format_recalled` ([agent/server.py:23-27](agent/server.py#L23-L27)) into a `[Known about this customer]\n- ...` preface and prepended to the user's message.
5. The system prompt at [agent/core.py:31-32](agent/core.py#L31-L32) instructs the model to honour the `Known about this customer:` block silently — i.e. influence answers without parroting it back.

This is RAG-for-memory. It runs once per turn, on the raw user input, before the LLM is asked anything. The model never invokes a "recall_memory" tool — recall is unconditional and always-on.

### Write path: explicit and implicit

**Explicit (per-turn):** the LLM calls `save_preference(preference)` ([agent/tools.py:69](agent/tools.py#L69)). The tool reads `user_id` from `agent.context` contextvars — the LLM never sees or supplies user IDs, which prevents id hallucination. The text is embedded with Voyage, then inserted as `kind="preference"`. The Butler sub-agent owns this tool exclusively.

**Implicit (end-of-session):** `MongoMemoryService.add_session_to_memory(session)` summarises all text events from a session and stores them as `kind="session_summary"`. Currently nothing in the runtime calls this automatically; it's available for batch jobs or end-of-session hooks.

### Two read paths now

After the multi-agent split, memory has two complementary read paths:

1. **Always-on RAG preface** (server-side, every turn) — the chat handler embeds the raw user message, runs `$vectorSearch` with the `user_id` filter, and prepends a `[Known about this customer]` block to the message before invoking the runner. Implemented in [agent/server.py](agent/server.py); the system prompt at [agent/core.py](agent/core.py) tells the model to honour the block silently.

2. **Explicit `recall_preferences(query)` tool** (Butler sub-agent) — the LLM calls this when the customer directly asks what's known about them ("what dietary needs do they have?"). Same `$vectorSearch` against `memory` with the same `user_id` filter; the difference is intent — explicit recall vs. implicit context.

Both paths share the same index (`memory_vector_index`) and same scope filter, so they're consistent. The explicit tool exists for the cases where the always-on preface isn't enough — e.g. when the customer's query doesn't surface the right memories via embedding similarity but a phrased recall query would.

---

## Why preferences live in `memory` and not in session `state`

ADK exposes a `session.state` dict that's persisted alongside events. We deliberately do **not** put preferences there because:

- `state` is per-session — a preference set on session A is invisible to session B.
- `state` is opaque key-value storage — no semantic search, only exact-key lookup.
- Memory needs cross-session vector retrieval, which `state` cannot provide.

`session.state` is reserved for ephemeral within-session scratchpad (e.g. transient agent state across sub-agent calls). Long-term facts go through the memory layer.

---

## End-to-end turn

```
HTTP POST /chat { user_id, session_id?, message }
        │
        ▼
server.py  ─── get/create session via MongoSessionService
        │
        ├── memory_service.search_memory(user_id, message)         ◄── reads `memory` (vector search + user_id filter)
        │       returns [{text, kind, score, ...}, ...]
        │
        ├── prefixed_message = "[Known about this customer]\n- ...\n\n" + message
        │
        ├── bind_turn_context(user_id, session_id)                 ◄── contextvars; tools read from these
        │
        └── runner.run_async(new_message=Content(prefixed_message))
                 │
                 ├── MongoSessionService.append_event(user msg)    ◄── writes `sessions` AND mutates session.events
                 │
                 ├── LlmAgent.run                                  ◄── builds LlmRequest from session.events
                 │       Gemini decides → function_call(search_products) | function_call(save_preference) | text
                 │
                 ├── tool execution
                 │   • search_products  →  $vectorSearch on `products`  (read-only)
                 │   • save_preference  →  insert into `memory`  (write, kind=preference)
                 │   • record_artifact  →  insert into `artifacts`
                 │
                 ├── append_event (function_call, function_response)  ◄── written to sessions, mutated on session
                 │
                 └── final model text → append_event → return to caller
```

---

## Collections summary

| Collection | Written by | Read by | Indexes |
|---|---|---|---|
| `sessions` | `MongoSessionService.append_event` | `MongoSessionService.get_session` (and `_doc_to_session`) | `_id` (default), no vector index |
| `memory` | `save_preference` tool, `MongoMemoryService.add_session_to_memory` | `MongoMemoryService.search_memory` (called from server, every turn) | `memory_vector_index` (vector + filter on `user_id`) |
| `products` | `scripts/ingest.py` | `search_products` tool | `products_vector_index` |
| `artifacts` | `record_artifact` tool | `GET /artifacts?user_id=...` (Saved tab in the library sidebar) | `_id`, `user_id` for filtering |

---

## autoEmbed migration (deferred)

[ARCHITECTURE.md](ARCHITECTURE.md) notes that Atlas **autoEmbed** indexes are the future state — Voyage runs server-side, the application stores text only and never sees vectors. autoEmbed isn't yet public preview, so the current implementation in [agent/tools.py](agent/tools.py), [agent/memory_service.py](agent/memory_service.py), and [agent/embeddings.py](agent/embeddings.py) does **client-side embedding via the Atlas Embedding & Reranking API** (`https://ai.mongodb.com/v1/embeddings`), stores the resulting vectors in an `embedding` field, and queries with `$vectorSearch` using `queryVector` (not `query`). Both approaches use Voyage models; the difference is who calls Voyage.

If/when the app migrates to autoEmbed:
- Drop `agent/embeddings.py` and the `embedding` field from inserts.
- Switch `$vectorSearch` stages to use `query: <natural language string>` instead of `queryVector`.
- Drop `VOYAGE_API_KEY` from app config (it moves to Atlas Project Settings → Integrations).
- Update this doc accordingly.

---

## Touch points when extending memory

- **Adding a new kind of memory** (e.g. `recipe_history`): add a write site (tool or service method) — the Butler agent is the natural owner for new memory tools. Use the same `memory` collection so existing recall picks it up, document the new `kind` in the table above.
- **Changing the recall prompt format**: edit `_format_recalled` in [agent/server.py](agent/server.py) AND the orchestrator's instruction in [agent/core.py](agent/core.py) (the `Known about this customer:` rule, currently in the Planner instruction). They're a contract.
- **Replacing the summariser**: `_summarise` in [agent/memory_service.py](agent/memory_service.py) is intentionally trivial. Wire in a Gemini call when this matters.
- **Adding write paths in tools**: pull `user_id` from `agent.context.current_user_id()` — never accept it as a tool argument. The LLM cannot reliably know it and will hallucinate.
- **Adding a new SessionService backend**: implement `BaseSessionService`, and **call `super().append_event(...)` from your override** (see gotcha above).
- **Adding a new specialist that needs memory access**: give it the existing `recall_preferences` tool (or create a kind-filtered variant). Don't reach into the memory collection from a tool that "doesn't own" memory — Butler is the canonical owner and the topology in the live graph reflects that.
