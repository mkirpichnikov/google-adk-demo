# ---- Stage 1: build the React SPA ----
FROM node:20-alpine AS ui-builder

WORKDIR /ui

# Lockfile-first to maximise layer cache hits.
COPY ui/package.json ui/package-lock.json* ./
RUN npm ci --no-audit --no-fund

COPY ui/. .
RUN npm run build


# ---- Stage 2: Python runtime ----
FROM python:3.11-slim AS runtime

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PORT=8080

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY agent ./agent
COPY scripts ./scripts
COPY data ./data

# Inject the built SPA at the path agent/server.py expects (../ui/dist).
COPY --from=ui-builder /ui/dist ./ui/dist

EXPOSE 8080

CMD ["uvicorn", "agent.server:app", "--host", "0.0.0.0", "--port", "8080"]
