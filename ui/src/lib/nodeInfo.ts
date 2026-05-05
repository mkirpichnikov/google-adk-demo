// Long-form descriptions for each node in the agent topology.
// Surfaced in the NodeDetailPanel when the user clicks a node.

export interface NodeDoc {
  title: string;
  category: "Orchestrator" | "Specialist" | "Tool" | "MongoDB collection" | "Server";
  summary: string;
  details: string[];        // bullet points
  files?: string[];          // source-of-truth file references
  collection?: string;       // for tools — which collection they touch
  parent?: string;           // for tools — which agent owns them
}

export const NODE_DOCS: Record<string, NodeDoc> = {
  orchestrator: {
    title: "Orchestrator",
    category: "Orchestrator",
    summary:
      "Top-level routing agent. Receives every user turn and delegates to the right specialist by calling the auto-injected transfer_to_agent tool. Owns no domain tools itself.",
    details: [
      "Model: gemini-2.5-flash on Vertex AI (region configurable via GOOGLE_CLOUD_LOCATION).",
      "Built with LlmAgent(sub_agents=[concierge_agent, catalog_agent, butler_agent, planner_agent]).",
      "ADK auto-injects the transfer_to_agent tool with an enum of valid sub-agent names — preventing hallucinated routes.",
      "Always calls transfer_to_agent; never answers the customer directly.",
    ],
    files: ["agent/core.py"],
  },
  concierge_agent: {
    title: "Concierge specialist",
    category: "Specialist",
    summary:
      "First-line agent for greetings, capability questions, help, and any open-ended chat that doesn't name a specific product, preference, or plan. Owns no tools.",
    details: [
      "No tools — answers from instruction only.",
      "Catches 'what can you do?', 'help', 'g'day', 'tell me about yourself'.",
      "Default route when the orchestrator can't classify the query as catalog/pantry/planner.",
      "Replies in markdown so lists and emphasis render in the UI.",
    ],
    files: ["agent/core.py"],
  },
  catalog_agent: {
    title: "Catalog specialist",
    category: "Specialist",
    summary:
      "Owns the grocery catalog. Given a customer's description, runs vector search over the products collection and returns 3–5 relevant SKUs.",
    details: [
      "Sole tool: search_products (semantic vector search).",
      "Never invents SKUs, names, or prices — quotes them verbatim from $vectorSearch results.",
      "Used for: 'find me X', 'what cheese do you have', 'something for a healthy lunchbox'.",
    ],
    files: ["agent/core.py", "agent/tools.py"],
  },
  butler_agent: {
    title: "Butler specialist",
    category: "Specialist",
    summary:
      "The personal-preferences specialist. Knows the customer — saves durable facts they share and recalls them on demand.",
    details: [
      "Tools: save_preference (write), recall_preferences (read).",
      "save_preference fires when the customer reveals a durable fact (allergy, diet, household size, brand loyalty, budget).",
      "recall_preferences is for explicit lookups — it complements the server-level pass that prepends user memories to every prompt before the agent sees it.",
      "Uses contextvars to read user_id without exposing it to the LLM.",
    ],
    files: ["agent/core.py", "agent/tools.py", "agent/context.py"],
  },
  planner_agent: {
    title: "Planner specialist",
    category: "Specialist",
    summary:
      "Composes multi-item outputs — shopping lists, meal plans, recipes. Calls search_products multiple times, then persists the final list via record_artifact.",
    details: [
      "Tools: search_products (read catalog), record_artifact (persist final output).",
      "Workflow: understand goal → multiple search calls → compose final list → record_artifact → reply.",
      "Honors recalled preferences silently (the server prepends a [Known about this customer] block to every user turn).",
    ],
    files: ["agent/core.py", "agent/tools.py"],
  },
  search_products: {
    title: "search_products",
    category: "Tool",
    summary:
      "Hybrid semantic + structured search over the product catalog. Vector ranks by meaning; optional max_price / min_price / category post-filters enforce hard constraints.",
    details: [
      "Query is a natural-language string. Voyage embeds it client-side via the Atlas Embedding & Reranking API.",
      "Pipeline: $vectorSearch → optional $match (price / category post-filter) → $limit → $project with the relevance score.",
      "When a filter is present, numCandidates is bumped (≥200) and the vector $limit widened so post-filter has enough survivors.",
      "Atlas index: products_vector_index (1024-dim cosine).",
      "Used by both Catalog and Planner agents.",
    ],
    files: ["agent/tools.py", "scripts/create_index.py"],
    collection: "products",
  },
  save_preference: {
    title: "save_preference",
    category: "Tool",
    summary:
      "Persists a durable customer preference into the memory collection. Read user_id from contextvars — never from the LLM.",
    details: [
      "Embeds the preference text with Voyage and stores it alongside user_id, kind='preference', timestamp.",
      "Insert into memory collection — covered by memory_vector_index for later recall.",
      "Used by Butler agent only.",
    ],
    files: ["agent/tools.py", "agent/memory_service.py"],
    collection: "memory",
  },
  recall_preferences: {
    title: "recall_preferences",
    category: "Tool",
    summary:
      "Explicit recall of what we already know about the current customer — vector search over memory scoped by user_id filter.",
    details: [
      "Pipeline: $vectorSearch with filter: { user_id: <current> } → $project.",
      "Index: memory_vector_index (1024-dim cosine + filter on user_id).",
      "Complements the always-on memory recall preface that the server prepends to every turn.",
    ],
    files: ["agent/tools.py", "agent/memory_service.py", "scripts/create_index.py"],
    collection: "memory",
  },
  record_artifact: {
    title: "record_artifact",
    category: "Tool",
    summary:
      "Persists agent-generated artifacts (shopping lists, meal plans, recipes) for audit and replay.",
    details: [
      "Inserts into the artifacts collection with session_id, kind, content, created_at.",
      "session_id read from contextvars — invisible to the LLM.",
      "Used by Planner agent at the end of multi-step compositions.",
    ],
    files: ["agent/tools.py"],
    collection: "artifacts",
  },
  products: {
    title: "products collection",
    category: "MongoDB collection",
    summary:
      "Grocery catalog. Documents carry sku, name, category, price, size, text, plus a 1024-dim Voyage embedding.",
    details: [
      "Atlas Vector Search index: products_vector_index (cosine similarity over `embedding`).",
      "Loaded by scripts/ingest.py from data/products.json (~70 SKUs).",
      "Read by the search_products tool.",
    ],
    files: ["scripts/ingest.py", "scripts/create_index.py", "data/products.json"],
  },
  memory: {
    title: "memory collection",
    category: "MongoDB collection",
    summary:
      "Long-term per-user facts: preferences, dietary needs, household details, session summaries.",
    details: [
      "Atlas Vector Search index: memory_vector_index (vector path 'embedding' + filter on 'user_id').",
      "Filter on user_id is mandatory — prevents cross-customer leakage and partitions retrieval.",
      "Two write sites: save_preference tool (kind='preference'), MemoryService.add_session_to_memory (kind='session_summary').",
      "Read by recall_preferences tool AND by the always-on RAG preface in the server.",
    ],
    files: ["agent/memory_service.py", "scripts/create_index.py"],
  },
  sessions: {
    title: "sessions collection",
    category: "MongoDB collection",
    summary:
      "One document per chat thread. The events array is an append-only log of every user message, model output, function call, and function response.",
    details: [
      "Replaces ADK's in-memory or Firestore session backend — see MongoSessionService.",
      "Replayed verbatim into LlmRequest.contents on every model call.",
      "append_event mutates the in-memory session AND persists to Mongo (via super().append_event() — without the super-call, the runner can't see the new event in the same turn).",
    ],
    files: ["agent/session_service.py"],
  },
  artifacts: {
    title: "artifacts collection",
    category: "MongoDB collection",
    summary:
      "Agent-generated outputs persisted for audit and replay. Currently shopping lists, meal plans, recipes.",
    details: [
      "Written by record_artifact tool (Planner agent only).",
      "Schema: session_id, kind, content, created_at.",
      "Demonstrates the audit-trail story for enterprise customers.",
    ],
    files: ["agent/tools.py"],
  },
  server: {
    title: "Assistant UI (React + FastAPI)",
    category: "Server",
    summary:
      "Single Python process serving both the React SPA (Vite-built static assets) and the live SSE stream. Per-request EventBus fans in agent events and MongoDB command events.",
    details: [
      "Endpoints: GET / (SPA), POST /chat/stream (SSE), GET /sessions, GET /sessions/{id}, GET /artifacts, GET /healthz.",
      "Prepends user memories to every prompt: each turn embeds the user message, runs $vectorSearch on memory, formats hits into a [Known about this customer] block, and prepends them before the agent sees the message.",
      "PyMongo CommandListener registered on the singleton MongoClient — every command surfaces as a db_op event in the live timeline.",
      "Binds contextvars (user_id, session_id, event_queue) once per request before invoking the runner.",
    ],
    files: [
      "agent/server.py",
      "agent/event_bus.py",
      "agent/event_translator.py",
      "agent/db_listener.py",
    ],
  },
};
