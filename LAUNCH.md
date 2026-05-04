# Launch Runbook

Sequenced steps from "files on disk" to a fully running application, with a verification gate after each phase. Don't move forward if a gate fails — every later step assumes the earlier one works.

For the lightweight first-time-on-this-machine view, see [SETUP.md](SETUP.md). For day-to-day operations after the app is running, see [RUN.md](RUN.md).

## Phase 0 — Accounts and access (provision early)

1. **GCP project** with billing enabled. Need `roles/owner` or at least `roles/aiplatform.user` + `roles/run.admin` + `roles/secretmanager.admin`.
2. **MongoDB Atlas cluster** — M10 or larger, in a region that supports Atlas Vector Search (e.g. `australia-southeast1`, `us-central1`, `eu-west-1`). Co-locate with your Vertex AI region for lower latency.
3. **Voyage AI API key** — set as `VOYAGE_API_KEY` in `.env`. Used by [agent/embeddings.py](agent/embeddings.py) which calls the Atlas Embedding & Reranking API at `https://ai.mongodb.com/v1/embeddings`. (autoEmbed is the future state — public preview pending.)

**Gate**: Atlas cluster reachable; `VOYAGE_API_KEY` accepted by the Atlas Embedding API (a single curl proves it).

## Phase 1 — Local environment (15 min)

```bash
cd <path-to-cloned-repo>

python3.11 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env
# Edit .env: GOOGLE_CLOUD_PROJECT, MONGODB_URI, VOYAGE_API_KEY

gcloud auth login
gcloud auth application-default login
gcloud config set project $(grep GOOGLE_CLOUD_PROJECT .env | cut -d= -f2)
gcloud services enable aiplatform.googleapis.com run.googleapis.com \
  secretmanager.googleapis.com artifactregistry.googleapis.com
```

**Gate**: `python -c "from agent.config import SETTINGS; print(SETTINGS.gcp_project, SETTINGS.mongodb_db)"` prints your project and `adk_demo`.

## Phase 2 — Verify ADK API compatibility

The scaffold targets `google-adk>=1.32.0`. The library evolves fast — abstract method signatures on `BaseSessionService` / `BaseMemoryService` change between versions, and `LlmAgent.sub_agents` semantics matter for the multi-agent topology.

```bash
pip show google-adk
.venv/bin/python -c "from agent.runner import get_runner; r = get_runner(); print(r); print(r.agent.name, '->', [s.name for s in r.agent.sub_agents])"
```

Expected output ends with something like: `orchestrator -> ['concierge_agent', 'catalog_agent', 'butler_agent', 'planner_agent']`.

**If `Can't instantiate abstract class MongoSessionService with abstract method <name>`**: read the installed source at `.venv/lib/python3.11/site-packages/google/adk/sessions/base_session_service.py` and add stubs to [agent/session_service.py](agent/session_service.py) that read/write the same `sessions` document.

**Gate**: `get_runner()` returns a `Runner` and lists three sub-agents.

## Phase 3 — Atlas vector indexes (10 min + Atlas build time)

```bash
python -m scripts.create_index
```

Creates two standard vector indexes (1024-dim Voyage embeddings stored client-side):
- `products_vector_index` on `adk_demo.products` (path: `embedding`, cosine similarity)
- `memory_vector_index` on `adk_demo.memory` (path: `embedding`, cosine similarity, filter on `user_id`)

The script polls until both are queryable.

**Gate**: `scripts.create_index` exits 0; Atlas UI shows both indexes "Active."

## Phase 4 — Load data and verify retrieval (10 min)

```bash
python -m scripts.ingest

MONGODB_URI_LIVE="$MONGODB_URI" pytest tests/test_smoke.py -v
```

The smoke test calls `search_products("healthy school lunchbox", limit=3)` and asserts results have scores in [0,1].

**Gate**: smoke test passes. Lunchbox-relevant SKUs (apples, sultanas, sandwich bread, cheese) rank highly.

## Phase 5 — Build the UI (5 min)

```bash
cd ui
npm install        # ~30s, ~150 packages
npm run build      # ~1s, outputs ui/dist/
cd ..
```

`agent/server.py` mounts `ui/dist` as static at `/`. Without `ui/dist`, the homepage shows a fallback "UI not built yet" page (handy for diagnosing "why is the page blank").

**Gate**: `ls ui/dist/index.html ui/dist/assets/` returns files.

## Phase 6 — Run the multi-agent server locally (15 min)

```bash
.venv/bin/uvicorn agent.server:app --reload --port 8080
# open http://localhost:8080
```

Verify the SSE pipeline before opening the browser:
```bash
curl -sN -X POST http://localhost:8080/chat/stream \
  -H 'content-type: application/json' \
  -d '{"user_id":"alice","message":"Find healthy snacks under $5"}' | head -40
```

You should see, in order: `turn_start`, `memory_recalled`, `db_op aggregate on memory (vector_search:true)`, `agent_active orchestrator`, `agent_transfer orchestrator → catalog_agent`, `tool_call search_products`, `db_op aggregate on products (vector_search:true)`, `tool_result`, `text_delta` chunks, `turn_end`.

In the browser:
- Left panel: **agent graph**. Watch nodes pulse (Catalog/Butler/Planner) as control hands off. Watch `products`/`memory`/`artifacts` collection nodes pulse green when `$vectorSearch` or writes fire.
- Centre: **chat** with streaming reply, product cards (from `tool_result.payload`), and recall cards.
- Right panel: **event timeline** with millisecond timestamps.

Inspect MongoDB to prove "MongoDB is the only datastore":
```bash
mongosh "$MONGODB_URI"
> use adk_demo
> db.sessions.find().pretty()
> db.memory.find().pretty()
> db.artifacts.find().pretty()
```

**Gate**: each verification prompt below produces visible animations on the graph + entries in the timeline + correct chat output.

## Phase 7 — End-to-end verification (1 hour)

Four prompts that exercise every specialist in the example application. If your fork has changed the agent set or tool surface, adapt accordingly.

1. **"I'm vegetarian and have two kids"** → orchestrator → **Butler** → `save_preference` (×2) → memory writes. Both Butler node and `memory` collection node pulse.
2. **"Find healthy snacks under $5"** → orchestrator → **Catalog** → `search_products` → `$vectorSearch on products`. Product cards render in chat. Edge from `search_products` → `products` animates.
3. **"Plan a $30 vegetarian dinner for four"** → orchestrator → **Planner** → multiple `search_products` calls + `record_artifact`. Timeline accumulates ~10 events; `artifacts` collection gets a new document.
4. **(Refresh browser; same `user_id`)** → "What dinner do you suggest?" → `memory_recalled` fires before any agent runs. Reply is vegetarian-leaning. Cross-session memory verified.

Optional: open MongoDB Compass and watch `sessions.events`, `memory`, and `artifacts` populate in real time as you run the above prompts.

## Phase 8 — Deploy to Cloud Run (optional, 30 min)

```bash
docker build -t adk-demo .
docker run --env-file .env -p 8080:8080 adk-demo
# verify locally first

# then push + deploy via gcloud (commands in ARCHITECTURE.md#gcp-cli-setup)
```

The Dockerfile is multi-stage: a Node 20 stage builds `ui/dist`, the Python runtime copies it in. Single container, single port (8080), no separate UI host.

If you're running this in front of an audience, a working local instance is more reliable than a hastily-deployed Cloud Run. Skip Phase 8 if short on time.

## Phase 9 — Pre-launch checks

Before going live (whether for a presentation or production traffic), verify:

1. **Atlas IP allowlist includes the runtime IP.** If you'll connect from a transient location, `0.0.0.0/0` is the easy way; in production, allowlist the Cloud Run egress range.
2. **Vertex AI Gemini quota** is warm. New projects sometimes hit per-minute caps; 5–10 trial calls confirm quota.
3. **Browser zoom** at 100% — the 4-column layout needs ~1280px of horizontal space; below that the timeline panel hides on the `lg:` breakpoint.

## Realistic timeline

| Phase | Optimistic | Realistic | Risk case |
|---|---|---|---|
| 0 | provisioning | provisioning | + approvals |
| 1 | 15 min | 30 min | + IT |
| **2** | **30 min** | **2 hours** | **half a day** ← biggest risk |
| 3 | 15 min | 30 min | + index schema fixes |
| 4 | 15 min | 30 min | + retrieval troubleshooting |
| 5 | 5 min | 10 min | — |
| 6 | 30 min | 1 hour | — |
| 7 | 1 hour | 2 hours | — |
| 8 | 30 min | 1 hour | skip if short |
| 9 | 30 min | 1 hour | — |

**Critical path is Phase 2.** Start it as soon as Phase 1 completes.
