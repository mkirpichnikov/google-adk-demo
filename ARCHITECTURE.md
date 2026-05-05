# Architecture

What this template is, the architectural choices it makes, and why.

---

## What this is

A reference template for building multi-agent systems with **Google ADK** (Python) and **MongoDB Atlas** as the only datastore. The template ships with a working grocery-assistant example application; the architecture, agent topology, persistence model, and live UI are intended to be reused or forked into other domains (insurance, customer support, healthcare advisor, financial-services concierge, etc.) by replacing the agent instructions, the example data, and the tool implementations.

The grocery scenario is illustrative. Nothing about the architecture is grocery-specific.

---

## Architectural choices the template makes

1. **Custom Python ADK** rather than the UI-based Agent Builder.
2. **Direct PyMongo TLS** rather than MCP.
3. **MongoDB-only persistence** — sessions, long-term memory, vector RAG, and artifacts in one cluster.
4. **`sub_agents=[...]`** rather than wrapping agents as `AgentTool`s.
5. **Server-Sent Events** carrying a typed event stream so the UI can render every agent transfer, tool call, and MongoDB command as it happens.

Each of these is justified below.

---

## Why each choice

### Direct PyMongo, not MCP

The MCP-based path (where an MCP server fronts MongoDB and the agent reaches the database through MCP tool adapters) requires a running server process exposing MongoDB operations over a network interface. Many enterprise security teams haven't approved that pattern. Direct PyMongo over TLS on port 27017 is the same network shape any Python application uses to talk to MongoDB and is already covered by existing approvals. This template uses the direct path so a fork stays portable across environments without negotiating new network policy.

### MongoDB-only persistence

```
Browser SPA (React + ReactFlow + Tailwind v4 + zustand)
   │ POST /chat/stream  (SSE)
   ▼
FastAPI server  ── per-request EventBus (asyncio.Queue)
   │
   ├── ADK Runner (StreamingMode.SSE; gemini-2.5-flash on Vertex AI)
   │     OrchestratorAgent
   │       ├── ConciergeAgent  (no tools — help / general / introspection)
   │       ├── CatalogAgent    →  search_products       →  products
   │       ├── ButlerAgent     →  save_preference       →  memory
   │       │                      recall_preferences
   │       └── PlannerAgent    →  search_products       →  products
   │                              record_artifact       →  artifacts
   │
   └── PyMongo CommandListener  (publishes every command into the EventBus)
         │
         ▼
   MongoDB Atlas (M10+ cluster, your chosen GCP region)
       sessions  memory  products  artifacts
```

```
Browser SPA (React + ReactFlow + Tailwind v4 + zustand)
   │ POST /chat/stream  (SSE)
   ▼
FastAPI server  ── per-request EventBus (asyncio.Queue)
   │
   ├── ADK Runner (StreamingMode.SSE; gemini-2.5-flash on Vertex AI)
   │     OrchestratorAgent
   │       ├── ConciergeAgent  (no tools — help / general / introspection)
   │       ├── CatalogAgent    →  search_products       →  products
   │       ├── ButlerAgent     →  save_preference       →  memory
   │       │                      recall_preferences
   │       └── PlannerAgent    →  search_products       →  products
   │                              record_artifact       →  artifacts
   │
   └── PyMongo CommandListener  (publishes every command into the EventBus)
         │
         ▼
   MongoDB Atlas (M10+ cluster, your chosen GCP region)
       sessions  memory  products  artifacts
```

The orchestrator owns no domain tools. On every turn it calls `transfer_to_agent` (auto-injected by ADK's `agent_transfer.request_processor`) to delegate to a specialist. Specialist events flow through the parent generator with `event.author = <specialist_name>`, which is what makes the live graph in the UI possible.

The motivation for keeping all state in MongoDB: a fork of this template can deploy to any environment without standing up a second datastore for sessions or memory. One cluster covers vector search, session events, long-term per-user memory, and an artifact / audit log.

---

## MongoDB collections and roles

MongoDB serves all four agent persistence roles so no other database is introduced:

| Role | Collection | Key Fields |
|---|---|---|
| Vector Search / RAG | `products` | `sku`, `name`, `text`, `category`, `price`, `size`, `embedding` (1024-dim Voyage) |
| Session State | `sessions` | `_id`, `app_name`, `user_id`, `state`, `events[]`, `created_at`, `last_update_time` |
| Long-term Memory | `memory` | `user_id`, `text`, `embedding`, `kind` (`preference` or `session_summary`), `created_at` |
| Artifact / Audit Store | `artifacts` | `user_id`, `session_id`, `kind`, `content`, `created_at` |

See [MEMORY.md](MEMORY.md) for the deep dive on how sessions and memory are wired through.

### Vector Search Indexes

Today both indexes are standard `vector` indexes (1024-dim Voyage embeddings stored on the `embedding` field, computed client-side):

`products_vector_index` on `adk_demo.products`:

```json
{ "fields": [
  { "type": "vector", "path": "embedding", "numDimensions": 1024, "similarity": "cosine" }
]}
```

`memory_vector_index` on `adk_demo.memory`:

```json
{ "fields": [
  { "type": "vector", "path": "embedding", "numDimensions": 1024, "similarity": "cosine" },
  { "type": "filter", "path": "user_id" }
]}
```

The `user_id` filter on `memory_vector_index` is mandatory — it scopes recall to one customer and prevents cross-customer leakage.

When autoEmbed lands publicly, the `embedding` field disappears and the indexes switch to `type: autoEmbed` with `model: voyage-4-large` declared inline. Code paths that change: [scripts/create_index.py](scripts/create_index.py), [agent/tools.py](agent/tools.py) (`queryVector` → `query`), removal of [agent/embeddings.py](agent/embeddings.py), removal of `VOYAGE_API_KEY` from app config.

### Ingestion (today)

```python
import pymongo
from agent.embeddings import embed_documents  # calls Atlas Embedding & Reranking API

products = pymongo.MongoClient(MONGODB_URI).adk_demo.products
docs = [
    {"sku": "WW-1234", "name": "Organic Fuji Apples 1kg", "category": "produce", "price": 5.50,
     "text": "Crisp and sweet, NSW grown. Lunchbox snack, baking, salads."},
    # ...
]
texts = [d["text"] for d in docs]
embeddings = embed_documents(texts)
for d, e in zip(docs, embeddings):
    d["embedding"] = e
products.insert_many(docs)
```

### Query (today)

`$vectorSearch` with a precomputed `queryVector`:

```python
from agent.embeddings import embed_query

results = list(products.aggregate([
    {"$vectorSearch": {
        "index": "products_vector_index",
        "path": "embedding",
        "queryVector": embed_query("something for a healthy lunchbox"),
        "numCandidates": 100,
        "limit": 5,
    }},
    {"$project": {"sku": 1, "name": 1, "category": 1, "price": 1,
                  "score": {"$meta": "vectorSearchScore"}}},
]))
```

---

## Multi-Agent Topology

### Agents

```
OrchestratorAgent  (gemini-2.5-flash)  — routes; no own tools
 ├── ConciergeAgent — no tools (help, capability questions, general chat)
 ├── CatalogAgent   — search_products
 ├── ButlerAgent    — save_preference, recall_preferences
 └── PlannerAgent   — search_products, record_artifact
```

Defined in [agent/core.py](agent/core.py). Each specialist has a focused system instruction and a tight tool surface. The orchestrator's instruction emphasises that it must always call `transfer_to_agent` rather than reply to the customer directly.

**Why a Concierge agent rather than letting the Orchestrator answer directly?** Two reasons. First, the topology stays explicit — every turn flows through the orchestrator's delegation step, including the "what can you do" question that surfaces in the Concierge. Second, the orchestrator's job stays narrow (routing only), which keeps `transfer_to_agent` reliable. The Orchestrator's prompt explicitly instructs "if you can't tell which of catalog/butler/planner applies, route to concierge" — so vague queries don't default to a domain specialist.

`sub_agents=[...]` is the right declaration for this topology (not `AgentTool` — that black-boxes child events inside its own runner and breaks the live UI). With `sub_agents`, ADK's `agent_transfer.request_processor` injects a `transfer_to_agent` function with an enum of valid sub-agent names, and child events flow through the parent's event generator.

### Tools

All four tools are plain Python functions in [agent/tools.py](agent/tools.py):

| Tool | Owner agent(s) | Reads/writes | Notes |
|---|---|---|---|
| `search_products(query, limit=5, max_price?, min_price?, category?)` | Catalog, Planner | reads `products` | Embeds the query via Voyage, runs `$vectorSearch` then optional `$match` post-filter on price / category, returns `[{sku, name, category, price, size, score}]` |
| `save_preference(preference)` | Butler | writes `memory` | Reads `user_id` from contextvars (never from the LLM) |
| `recall_preferences(query, limit=5)` | Butler | reads `memory` | `$vectorSearch` filtered on `user_id` |
| `record_artifact(kind, content)` | Planner | writes `artifacts` | `kind` is one of `shopping_list`, `meal_plan`, `recipe`. Both `user_id` and `session_id` are read from contextvars; the user-scoped list is exposed via `GET /artifacts?user_id=...` and rendered in the Saved tab. |

`user_id` and `session_id` are deliberately not tool arguments — they're read from `agent.context` contextvars set by the HTTP server. This prevents the LLM from hallucinating identifiers.

### Session & Memory Services

ADK's default session backend is in-memory or Firestore. We override with [agent/session_service.py](agent/session_service.py) (`MongoSessionService`) and [agent/memory_service.py](agent/memory_service.py) (`MongoMemoryService`) so all state lives in MongoDB.

> **Critical detail in `MongoSessionService.append_event`:** the override calls `super().append_event(...)` *first* to mutate the in-memory session (apply state delta + append to `session.events`), *then* persists to Mongo. Without the super-call, the runner cannot see new events in the same turn — user messages disappear, and ADK falls back to the placeholder `"Handle the requests as specified in the System Instruction."`.

---

## Live UI

The browser sees a single SSE stream of structured events. Every agent activation, tool call, MongoDB command, text chunk, and turn boundary is one event. The translation is centralised in [agent/event_translator.py](agent/event_translator.py); see also [MEMORY.md](MEMORY.md) for how the protocol relates to ADK's internals.

UI panels (left to right):
1. **History** — sidebar of the current user's prior sessions; click to replay.
2. **Live agent graph** — ReactFlow topology of agents/tools/collections. Nodes pulse when active, edges animate when control or data flows. Click any node for an inline description of what it does.
3. **Conversation** — chat bubbles with streamed reply, recall cards, product card grids.
4. **Event timeline** — chronological log of every server event with millisecond timestamps.

---

## Reference application

The example app shipped with the template is a **grocery shopping assistant**. The Catalog agent surfaces products from a small reference catalog ([data/products.json](data/products.json), ~70 SKUs), the Butler tracks dietary and household preferences in long-term memory, and the Planner composes shopping lists / meal plans / recipes and persists them as artifacts.

To retarget the template to another domain, the surface area to swap is small:
- Replace [data/products.json](data/products.json) with your own reference data.
- Update the Catalog agent's system instruction to match the new entity vocabulary.
- Adjust the `search_products` tool's filter parameters if your domain has different structured fields.
- Update the Planner agent's `record_artifact` `kind` enum (e.g. `quote`, `policy_summary`, `treatment_plan`) and its instruction.
- Update the suggested prompts in [ui/src/components/Chat.tsx](ui/src/components/Chat.tsx).
- Update the node descriptions in [ui/src/lib/nodeInfo.ts](ui/src/lib/nodeInfo.ts).

The Concierge, the orchestrator, the multi-agent transfer mechanics, the live event protocol, the MongoDB schema, and the UI panels do not need to change.

Example sequences in the shipped app:
1. "I'm vegetarian and have two kids" → Butler node pulses, two `save_preference` writes hit `memory`.
2. "Find healthy snacks under $5" → Catalog node pulses, `$vectorSearch on products` lights up, product cards render.
3. "Plan a $30 vegetarian dinner for four" → Planner node, multiple search calls, `record_artifact` writes a list to `artifacts`.
4. Refresh tab (same `user_id`) → `memory_recalled` fires before any agent runs; replies are vegetarian-leaning.

---

## GCP Resources Required

### Resource Checklist

| Resource | Purpose | SKU / Tier |
|---|---|---|
| Vertex AI (Gemini) | LLM for the orchestrator + specialists | `gemini-2.5-flash` (only Gemini available in `australia-southeast1` as of 2026-04; thinking enabled by default) |
| Cloud Run | Host the FastAPI process serving the SPA + SSE | 1 vCPU, 512MB, min-instances=0 |
| Artifact Registry | Store the multi-stage container image | Standard |
| Secret Manager | `MONGODB_URI`, `VOYAGE_API_KEY` | — |
| VPC / Serverless VPC Connector | Optional: if Atlas uses private endpoint | — |

MongoDB Atlas is external to GCP. Place your cluster in the same GCP region as Vertex AI and the Cloud Run target so all traffic stays in-region (no cross-cloud hop).

**Atlas-side prerequisites**:

1. Cluster tier M10+ (vector search is not available on M0 / shared tiers).
2. Cluster region: GCP `australia-southeast1` ✓.
3. Network Access list → add Cloud Run egress IPs (production) or `0.0.0.0/0` (development / quick experiments).
4. Vector Search indexes created via `python -m scripts.create_index`.

### GCP CLI Setup

```bash
# 1. Authenticate
gcloud auth login
gcloud auth application-default login   # for SDK calls from local code

# 2. Set project
gcloud config set project YOUR_PROJECT_ID

# 3. Enable required APIs
gcloud services enable \
  aiplatform.googleapis.com \
  run.googleapis.com \
  secretmanager.googleapis.com \
  artifactregistry.googleapis.com

# 4. Create secrets (MongoDB URI + Voyage API key)
gcloud secrets create MONGODB_URI --data-file=- <<< "mongodb+srv://..."
gcloud secrets create VOYAGE_API_KEY --data-file=- <<< "your-voyage-key"

gcloud secrets add-iam-policy-binding MONGODB_URI \
  --member="serviceAccount:YOUR_SA@YOUR_PROJECT.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
gcloud secrets add-iam-policy-binding VOYAGE_API_KEY \
  --member="serviceAccount:YOUR_SA@YOUR_PROJECT.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"

# 5. Create Artifact Registry repo
gcloud artifacts repositories create adk-demo \
  --repository-format=docker \
  --location=australia-southeast1

# 6. Build and push container (multi-stage Dockerfile builds the React SPA + Python runtime)
gcloud builds submit --tag australia-southeast1-docker.pkg.dev/YOUR_PROJECT/adk-demo/agent:latest

# 7. Deploy to Cloud Run
gcloud run deploy adk-agent \
  --image australia-southeast1-docker.pkg.dev/YOUR_PROJECT/adk-demo/agent:latest \
  --region australia-southeast1 \
  --set-secrets MONGODB_URI=MONGODB_URI:latest,VOYAGE_API_KEY=VOYAGE_API_KEY:latest \
  --allow-unauthenticated \
  --port 8080
```

### Recommended Region

Pick the region closest to your end users. Co-locate your Atlas cluster and Vertex AI in the same region so request traffic stays in-region and round-trip latency stays low (typically saves ~50ms per turn). All major Vertex AI regions support Gemini.

---

## Key Dependencies

See [requirements.txt](requirements.txt). Key Python entries: `google-adk>=1.32`, `google-cloud-aiplatform`, `pymongo[srv]`, `fastapi`, `uvicorn`, `requests` (for the Atlas Embedding API).

UI deps in [ui/package.json](ui/package.json): `react@19`, `reactflow@11`, `zustand@5`, `tailwindcss@4`, `vite@8`.

**No `voyageai` Python package** — the Atlas Embedding & Reranking API is consumed via plain `requests` from [agent/embeddings.py](agent/embeddings.py).

---

## Environment Variables

```
GOOGLE_CLOUD_PROJECT=
GOOGLE_CLOUD_LOCATION=australia-southeast1
GOOGLE_GENAI_USE_VERTEXAI=true
MONGODB_URI=mongodb+srv://USER:PASS@cluster0.example.mongodb.net/?retryWrites=true&w=majority
VOYAGE_API_KEY=             # Atlas Embedding & Reranking API (Voyage); removed when autoEmbed lands
GOOGLE_APPLICATION_CREDENTIALS=   # local dev only; use Workload Identity on Cloud Run
```

---

## Development Commands

```bash
# Install Python deps (once venv is active)
pip install -r requirements.txt

# Build the UI
cd ui && npm install && npm run build && cd ..

# Run the full app (FastAPI serves the built SPA + the SSE endpoint)
uvicorn agent.server:app --port 8080
# open http://localhost:8080

# Dev mode (Vite hot-reload, FastAPI separate)
uvicorn agent.server:app --reload --port 8080  # terminal 1
cd ui && npm run dev                            # terminal 2 — proxies to :8080

# CLI (no UI)
python -m agent.main

# Ingest sample data
python -m scripts.ingest

# Tests
pytest tests/ -v

# Container
docker build -t adk-demo .
docker run --env-file .env -p 8080:8080 adk-demo
```

---

## Summary of architectural choices

1. **No MCP** — direct PyMongo TLS connection works in any environment that already permits Python apps to talk to MongoDB; no new server processes or network approvals required.
2. **MongoDB-only persistence** — one database handles vector search, sessions, memory, and artifacts. No Firestore, no AlloyDB, no Redis. The live event timeline shows every command firing in real time.
3. **Multi-agent topology with native ADK delegation** — `sub_agents=[...]` rather than wrapping agents as `AgentTool`s, so child events stream through the parent generator and the live UI can render every transfer.
4. **Voyage AI** — used today via the Atlas Embedding & Reranking API; will move server-side to autoEmbed when public preview ships. Either way, the embedding model lives in Atlas, not in the application code.
5. **Cloud Run** — serverless, scales to zero, no cluster management. A single container holds both the React SPA and the FastAPI process.
6. **Gemini as the reasoning layer only** — all data stays in MongoDB; Gemini never sees raw embeddings.
