# Setup — first time on this machine

You've cloned the template. This walks you through everything you need to make the example application run on your laptop. **Allow ~30–60 minutes** end-to-end. Most of that time is waiting for MongoDB Atlas to provision a cluster and build vector indexes.

The repo intentionally ships with no credentials. You will provide your own:
- a MongoDB Atlas cluster
- a Voyage AI key (configured inside Atlas)
- a Google Cloud project with Vertex AI enabled

If any of these are unfamiliar, follow the linked sections — they're explicit, not "go figure it out".

> Reading order: [README.md](README.md) explains what the template is and the architecture choices it makes. **This file (SETUP.md)** is the first-time setup checklist. [LAUNCH.md](LAUNCH.md) is the sequenced runbook with verification gates. [RUN.md](RUN.md) is the day-to-day operational reference.

---

## 💡 Shortcut — let your coding agent do it

If you have a coding agent open in this repo (Claude Code, Cursor, Windsurf, etc.), just ask. The agent has access to this entire `SETUP.md` and can:

- **Drive the whole setup** — install dependencies, create your `.env`, run `scripts/create_index`, run `scripts/ingest`, build the UI, start the server. Effectively `setup.md` automated. You'll still need to log in to Atlas and Google Cloud yourself (those require a browser), but everything else is "you do it / it does it" hand-offs.
- **Walk you through it interactively** — explain each step before running it, pause for your input on choices (region, cluster name, etc.), and surface errors with concrete fixes when they happen.
- **Diagnose** — paste any failure into the chat and it'll trace through the relevant files and suggest a fix.

A first prompt to try: *"Walk me through the setup in SETUP.md. Pause before any action that touches an external service so I can review."* If you want it more autonomous: *"Do the full setup from SETUP.md. Stop only when you need credentials I haven't provided."*

This whole demo was built that way — so it'll feel natural.

---

## What this demo costs to run

You do need to know this up front because two of the services aren't free:

| Service | Cost | Required tier | Why |
|---|---|---|---|
| MongoDB Atlas | **~US$30–60/month** | M10 or larger | Atlas Vector Search isn't available on the free M0 / shared tiers |
| Voyage AI (via Atlas Embedding API) | a few cents during testing | — | usage-based, very cheap at demo scale |
| Google Cloud Vertex AI (Gemini) | a few cents during testing | — | usage-based, very cheap at demo scale |

If you don't already have a paid Atlas cluster, factor that in before starting.

---

## Prerequisites — install once

| Tool | Version | Check |
|---|---|---|
| Python | 3.11+ | `python3 --version` |
| Node.js | 20+ | `node --version` |
| npm | bundled with Node | `npm --version` |
| `gcloud` CLI | recent | `gcloud --version` |
| Git | any recent | `git --version` |
| (optional) Docker | any recent | `docker --version` |
| (optional) MongoDB Compass | latest | for visual inspection during demos |

If you're on macOS:

```bash
brew install python@3.11 node@20 google-cloud-sdk
```

---

## 1. Clone and enter the repo

```bash
git clone <repo-url> google-adk-demo
cd google-adk-demo
```

The rest of this doc assumes your shell's working directory is the repo root.

---

## 2. Provision MongoDB Atlas

You need a cluster, a database user, IP allowlist, and (later) two vector indexes.

### 2a. Create the cluster

1. Sign in at <https://cloud.mongodb.com>. Create an organization if you don't have one. Create a project — call it whatever you like (e.g. `adk-demo`).
2. **Create cluster** → choose **M10** (or M20). Vector search **is not available on M0/shared tiers**.
3. **Cloud provider**: GCP. **Region**: pick the GCP region you'll use for Vertex AI — examples: `us-central1`, `europe-west4`, `australia-southeast1`. Same-region cluster + Vertex AI cuts ~50ms off every turn.
4. **Cluster name**: anything you like. MongoDB version 8.0+.
5. Click **Create**. Provisioning takes ~7–10 minutes — let it run while you do step 2b.

### 2b. Database user (while the cluster spins up)

In Atlas → **Security** → **Database Access**:

1. **Add new database user**.
2. Authentication method: **Password**.
3. Username: anything (e.g. `adk-app`). Password: generate a strong one and **save it somewhere private**.
4. **Built-in role**: `Atlas admin` (simplest; you can scope down later).
5. Save.

### 2c. Network access

Atlas → **Security** → **Network Access**:

1. **Add IP Address** → **Add Current IP Address**. This allowlists the machine you're sitting at.
2. If you'll demo from a different network (venue, Cloud Run egress), either add those IPs now or click **Allow Access from Anywhere** (`0.0.0.0/0`) — fine for a demo, never for production.

### 2d. Grab the connection string

Atlas → **Database** → **Connect** → **Drivers** → **Python**.

Copy the URI. It looks like:

```
mongodb+srv://<username>:<password>@cluster0.abcde.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0
```

Replace `<username>` and `<password>` with the credentials you set in step 2b. **Keep this string private** — it's a credential.

### 2e. Configure Voyage AI inside Atlas

Atlas hosts Voyage as part of its Embedding & Reranking API, so you don't need a Voyage account.

1. Atlas → **Project Settings** (top-right gear icon) → **AI Models** (or **Integrations** depending on UI version) → **Model API Keys**.
2. **Add API Key**. Provider: **Voyage AI**. Atlas will mint a key for you that looks like `al-...`.
3. Copy the key — this is your `VOYAGE_API_KEY`.

> The endpoint the app calls is `https://ai.mongodb.com/v1/embeddings`. That URL doesn't change.

---

## 3. Provision Google Cloud (Vertex AI)

You need a project with Vertex AI enabled and Application Default Credentials on your machine.

### 3a. Project + APIs

1. Sign in at <https://console.cloud.google.com>. Create a new project (or pick an existing one). Note the **Project ID** (not the display name) — e.g. `my-demo-12345`.
2. Make sure billing is enabled on the project (Console → **Billing**). Vertex AI requires it; the actual cost during testing is cents.
3. Enable required APIs:

```bash
gcloud config set project YOUR_PROJECT_ID
gcloud services enable aiplatform.googleapis.com
```

### 3b. Authenticate locally

```bash
gcloud auth login
gcloud auth application-default login
```

The second command opens a browser and writes credentials to `~/.config/gcloud/application_default_credentials.json`. The agent uses these via the standard ADC discovery, so you do **not** need to set `GOOGLE_APPLICATION_CREDENTIALS` in `.env` for local dev.

### 3c. Verify Gemini is reachable in your region

```bash
gcloud ai models list --region=YOUR_REGION 2>&1 | head -5
```

If you get permission errors, double-check the project + IAM. You'll need at least `roles/aiplatform.user`.

---

## 4. Local environment

### 4a. Python

```bash
python3.11 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### 4b. Node / UI

```bash
cd ui
npm install
cd ..
```

You'll build the UI at the end (step 7).

---

## 5. Wire up `.env`

Copy the template and fill in the three values you collected:

```bash
cp .env.example .env
```

Open `.env` and edit **only** these:

| Variable | Source | Example |
|---|---|---|
| `GOOGLE_CLOUD_PROJECT` | step 3a | `my-demo-12345` |
| `GOOGLE_CLOUD_LOCATION` | step 3a — must match the region where you'll use Vertex AI | `us-central1` |
| `MONGODB_URI` | step 2d | `mongodb+srv://adk-app:...@cluster0.abcde.mongodb.net/?retryWrites=true&w=majority` |
| `VOYAGE_API_KEY` | step 2e | `al-...` |

Everything else in `.env.example` has sensible defaults — leave them.

> **Never commit `.env`.** It's in `.gitignore` for a reason. If you accidentally do, rotate every key in it (Atlas DB password, Voyage key) and force-push a clean history.

### Sanity-check that the values load

```bash
.venv/bin/python -c "from agent.config import SETTINGS; print('GCP:', SETTINGS.gcp_project); print('DB:', SETTINGS.mongodb_db); print('Voyage key prefix:', SETTINGS.voyage_api_key[:5])"
```

You should see your project, `adk_demo`, and `al-` (or similar). If a `RuntimeError: Missing required env var` fires, you missed a required field.

---

## 6. Initialise Atlas (indexes + data)

### 6a. Create the vector indexes

```bash
.venv/bin/python -m scripts.create_index
```

This creates two `vectorSearch` indexes (`products_vector_index`, `memory_vector_index`).

**Atlas needs 5–10 minutes to build them.** The script polls until both report `READY`. Don't skip ahead.

If the script errors with "no embedding model API key configured" or similar — the Voyage key in step 2e isn't actually attached to your project. Go back and verify it's saved under **Project Settings → AI Models → Model API Keys**, not somewhere else.

### 6b. Load sample products

```bash
.venv/bin/python -m scripts.ingest
```

This embeds the ~70 products in [data/products.json](data/products.json) using your Voyage key and inserts them. Should take ~30 seconds.

### 6c. Verify retrieval works

```bash
.venv/bin/pytest tests/test_smoke.py -v
```

Expect a passing test that calls `search_products("healthy school lunchbox")` and asserts the results have `score` ∈ [0, 1].

If you get **zero hits**: the products are in but Atlas hasn't finished indexing them. Wait a minute, retry. If still zero after five minutes, the Voyage key isn't actually wired (return to 2e).

---

## 7. Build the UI and run the server

### 7a. Build the SPA

```bash
cd ui
npm run build
cd ..
```

This produces `ui/dist/`, which the FastAPI process serves at `/`.

### 7b. Start the server

```bash
.venv/bin/uvicorn agent.server:app --port 8080
```

Open <http://localhost:8080> — you should see the four-panel UI (History, Live agent graph, Conversation, Event timeline).

### 7c. Send a test prompt

Click any of the suggested prompts. Watch:
- the **graph** pulse as agents become active and tools fire,
- the **chat** stream a markdown reply with product cards,
- the **timeline** accumulate events including `aggregate $vectorSearch on products`.

If all three panels light up, you're done. If only the chat reacts (no graph/timeline), make sure you're hitting `localhost:8080` (where FastAPI serves both the UI and the SSE stream) — not a separate Vite dev server.

---

## Optional — Vite dev server (faster iteration)

If you'll be editing UI code:

```bash
# terminal 1: API
.venv/bin/uvicorn agent.server:app --reload --port 8080

# terminal 2: Vite hot-reload (proxies /chat/stream → :8080)
cd ui && npm run dev
# open http://localhost:5173
```

The Vite proxy is configured in [ui/vite.config.ts](ui/vite.config.ts).

## Optional — Docker

If you'd rather run it in a container (single command, no local Python/Node):

```bash
docker build -t adk-demo .
docker run --env-file .env -p 8080:8080 adk-demo
```

The multi-stage Dockerfile builds the UI and the Python runtime in one image.

---

## Troubleshooting

### `Missing required env var: ...`
You missed a value in `.env`. Re-run the sanity check from step 5.

### `pymongo.errors.ServerSelectionTimeoutError`
Either the IP allowlist (step 2c) doesn't include your current IP, or the cluster URI in `.env` is wrong. Test with:

```bash
.venv/bin/python -c "from agent import db; print(db.ping())"
```

### `400 Voyage AI` / no embeddings on ingest
The Voyage key isn't configured at the **project** level in Atlas. Check **Atlas → Project Settings → AI Models → Model API Keys**.

### `google.api_core.exceptions.PermissionDenied: 403 ... aiplatform.googleapis.com`
Either the API isn't enabled (step 3a), or your ADC user lacks `roles/aiplatform.user`. Re-run `gcloud auth application-default login` and `gcloud services enable aiplatform.googleapis.com`.

### Graph stays grey when I send a message
Check the browser console + the FastAPI logs. Most likely: the SSE stream is being buffered by a proxy / CDN. Run the server directly on `localhost` without anything in between — the local app doesn't need TLS or a reverse proxy.

### `npm install` complains about Node version
You have an older Node. `nvm install 20 && nvm use 20`, or upgrade your Homebrew Node to `node@20`.

### Indexes never become `READY`
Atlas's vector search backend is region-dependent. If the cluster is in a region where vector search isn't enabled, the indexes will sit in `BUILDING` forever. Use a major region (e.g. `us-central1`, `australia-southeast1`, `eu-west-1`).

---

## Where to look when things change

This doc is the "you, on a fresh machine" guide. Sister docs:

- [README.md](README.md) — project overview, layout, what to point at during a demo.
- [LAUNCH.md](LAUNCH.md) — sequenced runbook from "files on disk" to a fully running app.
- [ARCHITECTURE.md](ARCHITECTURE.md) — architecture deep-dive (multi-agent topology, MongoDB-only persistence, autoEmbed deferral).
- [MEMORY.md](MEMORY.md) — how working memory and long-term memory are wired through MongoDB.
- [DEMO.md](DEMO.md) — demo design + improvement roadmap.
