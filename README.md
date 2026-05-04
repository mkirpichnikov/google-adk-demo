# Google ADK + MongoDB Atlas — Multi-Agent Template

A **reference template** for building multi-agent systems with Google ADK (Python) and MongoDB Atlas as the only datastore. Fork it, replace the example data and agent instructions, and you have a domain-specific multi-agent application with live observability built in.

The template ships with a **grocery shopping assistant** as the example application. The architecture, agent topology, persistence model, and live UI are domain-agnostic.

**MongoDB is the only database.** It serves vector search, sessions, long-term memory, and artifacts. The UI animates every agent transfer, tool call, and MongoDB operation as the conversation runs — including the `$vectorSearch` aggregations and the writes to memory and artifacts.

- **[SETUP.md](SETUP.md) — first-time setup after cloning. Start here.**
- [ARCHITECTURE.md](ARCHITECTURE.md) — architectural choices and rationale (multi-agent topology, MongoDB-only persistence, direct PyMongo over MCP, etc.).
- [MEMORY.md](MEMORY.md) — how working memory and long-term memory are wired through MongoDB.
- [LAUNCH.md](LAUNCH.md) — sequenced runbook from "files on disk" to "live application".
- [RUN.md](RUN.md) — day-to-day operational reference (local dev + Cloud Run deploy).

## Architecture at a glance

```
Browser SPA (React + ReactFlow + Tailwind, served by FastAPI)
   │ POST /chat/stream  (SSE)
   ▼
FastAPI server  ── per-request EventBus (asyncio.Queue)
   │
   ├── ADK Runner (StreamingMode.SSE)
   │     OrchestratorAgent
   │       ├── ConciergeAgent (no tools — help / general queries)
   │       ├── CatalogAgent   →  search_products       →  products  (Atlas $vectorSearch)
   │       ├── ButlerAgent    →  save_preference       →  memory
   │       │                     recall_preferences
   │       └── PlannerAgent   →  search_products       →  products
   │                             record_artifact       →  artifacts
   │
   └── PyMongo CommandListener  (publishes every command into the EventBus)
         │
         ▼
   MongoDB Atlas (M10+ cluster, your chosen GCP region)
       sessions  memory  products  artifacts
```

Embeddings are produced via the **Atlas Embedding & Reranking API** (Voyage AI; `voyage-4-large`) called from [agent/embeddings.py](agent/embeddings.py). Atlas autoEmbed indexes are a planned follow-up once they go public preview.

## Prerequisites

1. **MongoDB Atlas** cluster, M10 or larger (Atlas Vector Search isn't available on shared / free tiers). Co-locate it in the same GCP region as Vertex AI for low-latency in-region traffic.
2. **Voyage AI key** for the Atlas Embedding & Reranking API — set as `VOYAGE_API_KEY` in `.env`.
3. **GCP project** with Vertex AI API enabled in your chosen region (e.g. `us-central1`, `europe-west4`, `australia-southeast1` — pick the region closest to your Atlas cluster for low-latency in-region traffic).
4. **Python 3.11+**.
5. **Node 20+** (for building the UI).

## Setup

```bash
# Python
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env
# Fill in GOOGLE_CLOUD_PROJECT, MONGODB_URI, VOYAGE_API_KEY in .env

gcloud auth application-default login

# Atlas: create vector indexes (products + memory)
python -m scripts.create_index

# Atlas: load sample grocery products (uses VoyageAI to compute embeddings client-side)
python -m scripts.ingest

# UI: install + build the SPA into ui/dist (FastAPI serves from there)
cd ui && npm install && npm run build && cd ..
```

## Run

**Production-style (single FastAPI process serves the built SPA + API):**
```bash
uvicorn agent.server:app --port 8080
# open http://localhost:8080
```

**Dev (hot-reload UI on Vite, FastAPI on :8080):**
```bash
# terminal 1: API
uvicorn agent.server:app --reload --port 8080

# terminal 2: Vite dev server (proxies /chat/stream → :8080)
cd ui && npm run dev
# open http://localhost:5173
```

**CLI (no UI):**
```bash
python -m agent.main
```

**Direct SSE smoke-test:**
```bash
curl -sN -X POST http://localhost:8080/chat/stream \
  -H 'content-type: application/json' \
  -d '{"user_id":"alice","message":"Find healthy snacks under $5"}'
```

## Layout

```
agent/
  config.py             env-driven settings
  db.py                 MongoClient (with CommandListener registered)
  db_listener.py        PyMongo listener → EventBus  (live MongoDB ops in the UI)
  embeddings.py         Voyage client (Atlas Embedding & Reranking API)
  context.py            per-turn contextvars (user_id, session_id, event_queue)
  event_bus.py          per-request asyncio.Queue used by the SSE endpoint
  event_translator.py   ADK events → wire-protocol events for the UI
  tools.py              search_products, save_preference, recall_preferences, record_artifact
  core.py               Orchestrator + Concierge/Catalog/Butler/Planner sub-agents
  session_service.py    MongoDB-backed BaseSessionService
  memory_service.py     MongoDB-backed BaseMemoryService
  runner.py             ADK Runner + StreamingMode.SSE config
  server.py             FastAPI app, /chat/stream SSE, serves ui/dist
  main.py               CLI entry-point
scripts/
  create_index.py       creates Atlas Vector Search indexes
  ingest.py             loads data/products.json with Voyage embeddings
data/
  products.json         sample grocery products
ui/                     Vite + React + TypeScript + ReactFlow + Tailwind v4
  src/
    App.tsx             4-column layout (library | graph | chat | event timeline)
    components/
      AgentGraph.tsx    ReactFlow topology with live pulse + edge animations
      AgentNode.tsx     custom node renderer (orchestrator/specialist/tool/db)
      Chat.tsx          chat bubbles, product cards, memory cards, suggestions
      EventTimeline.tsx chronological event log with timing
      LibrarySidebar.tsx tabbed sidebar — Chats (sessions) and Saved (artifacts)
      SessionList.tsx   row renderer for the Chats tab
      SavedArtifacts.tsx row renderer + modal for the Saved tab
    lib/
      types.ts          wire protocol mirror
      sse.ts            POST /chat/stream → SSE-over-fetch parser
      prompts.ts        suggested-prompt pools, sampled fresh on each load
      store.ts          zustand store
      dispatch.ts       reduce server events into store state
```

## Deploy to Cloud Run

The multi-stage [Dockerfile](Dockerfile) builds the UI in a Node stage and serves it from the Python runtime:

```bash
docker build -t adk-demo .
docker run --env-file .env -p 8080:8080 adk-demo
```

Cloud Run deployment commands are in [ARCHITECTURE.md](ARCHITECTURE.md#gcp-cli-setup) and the operational reference [RUN.md](RUN.md).

## What's worth understanding from the running app

- **The library sidebar** (far left) — tabbed: **Chats** lists prior sessions for replay; **Saved** lists artifacts the Planner has persisted (shopping lists, meal plans, recipes). Clicking a saved row opens a modal with the full markdown content.
- **The live agent graph** — every agent transfer, tool call, and MongoDB collection access lights up in real time. Multi-agent delegation made visible.
- **The event timeline** (far right) — exact chronology with millisecond timing on every operation. Includes labelled `$vectorSearch` rows for retrieval steps.
- **MongoDB-only persistence** — open MongoDB Compass against your cluster and watch `sessions.events`, `memory`, and `artifacts` populate as the conversation runs. The same database serves all four state roles.
- **No MCP server in the runtime** — direct PyMongo TLS connection (port 27017). The same network shape any Python application uses.
- **Native ADK delegation** — sub-agents declared with `sub_agents=[...]`, native event streaming via `StreamingMode.SSE`. Specialist events flow through the parent generator, which is what makes the live graph possible.

## Forking for another domain

The grocery-assistant example is illustrative. To retarget the template:

1. Replace [data/products.json](data/products.json) with your reference data (insurance policies, support articles, healthcare products, financial instruments — anything semantically searchable).
2. Update the Catalog agent's instruction in [agent/core.py](agent/core.py) to match your entity vocabulary.
3. Adjust the structured filter parameters in `search_products` ([agent/tools.py](agent/tools.py)) if your domain has different fields than `category` / `price`.
4. Update the Planner agent's `record_artifact` `kind` enum (e.g. `quote`, `policy_summary`, `treatment_plan`).
5. Update the suggested prompts in [ui/src/components/Chat.tsx](ui/src/components/Chat.tsx) and the node descriptions in [ui/src/lib/nodeInfo.ts](ui/src/lib/nodeInfo.ts).

The orchestrator, the concierge, the multi-agent transfer mechanics, the live event protocol, the MongoDB schema, and the UI panels do not need to change.
