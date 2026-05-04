# Run Guide

Two paths: **run locally** for development, or **launch in GCP** (Cloud Run) for a cloud-hosted instance. Both share the same Atlas cluster and the same code — only the host changes.

For the sequenced first-time setup with verification gates (Atlas indexes, ingest, smoke tests), see [LAUNCH.md](LAUNCH.md). This document is the day-to-day operational reference.

---

## Prerequisites (both paths)

- Python 3.11+
- `gcloud` CLI authenticated (`gcloud auth login` and `gcloud auth application-default login`)
- MongoDB Atlas cluster M10+ in a GCP region of your choice, with a Voyage model API key configured in **Atlas Project Settings → AI Models → Model API Keys**
- Atlas autoEmbed indexes created (`python -m scripts.create_index`) and data ingested (`python -m scripts.ingest`)
- A `.env` file at the repo root (copy from `.env.example`); the only required values are `GOOGLE_CLOUD_PROJECT` and `MONGODB_URI`

---

## Run locally

### One-time setup

```bash
cd <path-to-cloned-repo>
python3.11 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # then edit GOOGLE_CLOUD_PROJECT and MONGODB_URI
```

### Option A — FastAPI server (recommended)

```bash
source .venv/bin/activate
uvicorn agent.server:app --reload --port 8080
```

- UI: http://localhost:8080
- Health: http://localhost:8080/healthz
- Chat endpoint:

```bash
curl -s -X POST http://localhost:8080/chat \
  -H 'content-type: application/json' \
  -d '{"user_id":"alice","message":"what should I put in a healthy school lunchbox?"}' | jq
```

The response includes `tool_calls`, `tool_results`, and `memory_recalled` — useful for confirming vector search and memory are wired up.

### Option B — Interactive CLI

```bash
source .venv/bin/activate
python -m agent.main alice    # username arg is optional; auto-generated if omitted
```

Type messages, watch for `[tool: search_products(...)]` lines confirming the agent is hitting MongoDB. `exit` flushes a session summary to long-term memory and quits.

### Verify state landed in MongoDB

```bash
mongosh "$MONGODB_URI"
> use adk_demo
> db.sessions.find().sort({_id:-1}).limit(1).pretty()
> db.memory.find().pretty()
> db.products.countDocuments()
```

### Common local issues

| Symptom | Likely cause | Fix |
|---|---|---|
| `pymongo.errors.ServerSelectionTimeoutError` | Atlas IP allowlist | Add your current IP (or `0.0.0.0/0` for development) under Atlas → Network Access |
| `Reauthentication required` from Vertex AI | ADC expired | `gcloud auth application-default login` |
| `$vectorSearch` returns 0 hits | autoEmbed still indexing | Wait 1–2 min after `scripts.ingest`, then retry |
| `Can't instantiate abstract class MongoSessionService` | google-adk version drift | See [LAUNCH.md Phase 2](LAUNCH.md#phase-2--verify-adk-api-compatibility-danger-zone) |

---

## Launch in GCP (Cloud Run)

Same code, deployed as a container. Region: pick the same one your Atlas cluster sits in (e.g. `us-central1`) for colocated traffic with Vertex AI.

### One-time GCP setup

```bash
gcloud config set project "$GOOGLE_CLOUD_PROJECT"

gcloud services enable \
  aiplatform.googleapis.com \
  run.googleapis.com \
  secretmanager.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com

# Mongo URI in Secret Manager (the only secret — Voyage key lives in Atlas)
printf '%s' "$MONGODB_URI" | gcloud secrets create MONGODB_URI --data-file=-
# (or `gcloud secrets versions add MONGODB_URI --data-file=-` to update)

# Artifact Registry repo
gcloud artifacts repositories create adk-demo \
  --repository-format=docker \
  --location=us-central1
```

### Cloud Run service account

```bash
SA="adk-agent-sa@${GOOGLE_CLOUD_PROJECT}.iam.gserviceaccount.com"

gcloud iam service-accounts create adk-agent-sa \
  --display-name "ADK demo runtime"

# Read the secret
gcloud secrets add-iam-policy-binding MONGODB_URI \
  --member="serviceAccount:${SA}" \
  --role="roles/secretmanager.secretAccessor"

# Call Vertex AI / Gemini
gcloud projects add-iam-policy-binding "$GOOGLE_CLOUD_PROJECT" \
  --member="serviceAccount:${SA}" \
  --role="roles/aiplatform.user"
```

### Build and deploy

```bash
IMAGE="us-central1-docker.pkg.dev/${GOOGLE_CLOUD_PROJECT}/adk-demo/agent:latest"

gcloud builds submit --tag "$IMAGE"

gcloud run deploy adk-agent \
  --image "$IMAGE" \
  --region us-central1 \
  --service-account "$SA" \
  --set-env-vars GOOGLE_CLOUD_PROJECT="$GOOGLE_CLOUD_PROJECT",GOOGLE_CLOUD_LOCATION=us-central1,GOOGLE_GENAI_USE_VERTEXAI=true,MONGODB_DB=adk_demo \
  --set-secrets MONGODB_URI=MONGODB_URI:latest \
  --allow-unauthenticated \
  --port 8080 \
  --cpu 1 --memory 512Mi --min-instances 0
```

### Verify

```bash
URL=$(gcloud run services describe adk-agent --region us-central1 --format='value(status.url)')
curl -s "$URL/healthz"
curl -s -X POST "$URL/chat" \
  -H 'content-type: application/json' \
  -d '{"user_id":"alice","message":"what should I put in a healthy school lunchbox?"}' | jq
open "$URL"
```

### Tail logs

```bash
gcloud run services logs tail adk-agent --region us-central1
```

### Update the deployment

```bash
gcloud builds submit --tag "$IMAGE"
gcloud run deploy adk-agent --image "$IMAGE" --region us-central1
```

### Common Cloud Run issues

| Symptom | Likely cause | Fix |
|---|---|---|
| Container starts then 503s | Atlas blocking Cloud Run egress | Atlas → Network Access → add `0.0.0.0/0` for development, or set up Private Service Connect for production |
| `403 PERMISSION_DENIED` on Vertex AI | Service account missing `roles/aiplatform.user` | Re-run the IAM binding above |
| `MONGODB_URI` not set inside container | Secret not bound | Re-run `gcloud run deploy` with `--set-secrets` |
| Cold start > 5s | Min instances = 0 | Set `--min-instances 1` for live windows where latency matters |

---

## Pre-launch checklist

- [ ] `curl /healthz` returns `{"status":"ok"}` from both local and Cloud Run URL
- [ ] One full chat turn succeeds and `tool_calls` includes `search_products` (or whatever tools your fork uses)
- [ ] `db.sessions.countDocuments()` increments after a turn
- [ ] Atlas Network Access allows the runtime IP (or `0.0.0.0/0` if you accept the looser rule)
- [ ] Vertex AI Gemini quota warmed (5–10 calls before going live)
