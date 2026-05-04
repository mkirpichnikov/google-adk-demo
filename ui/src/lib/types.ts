// Wire-protocol mirror of agent/event_translator.py + agent/db_listener.py.
// Keep this in sync when the backend's event protocol changes.

export type AgentName =
  | "orchestrator"
  | "concierge_agent"
  | "catalog_agent"
  | "butler_agent"
  | "planner_agent";

export type ToolName =
  | "search_products"
  | "save_preference"
  | "recall_preferences"
  | "record_artifact";

export type CollectionName =
  | "products"
  | "memory"
  | "sessions"
  | "artifacts"
  | string; // listener captures any collection name; treat as open

export interface MemoryHit {
  text: string;
  kind: string;
  score?: number;
  created_at?: string;
}

export type ServerEvent =
  | {
      kind: "turn_start";
      turn_id: string;
      user_id: string;
      session_id: string;
      message: string;
    }
  | { kind: "memory_recalled"; hits: MemoryHit[] }
  | { kind: "agent_active"; agent: string; branch: string }
  | { kind: "agent_transfer"; from: string; to: string }
  | {
      kind: "tool_call";
      agent: string;
      tool: string;
      args: Record<string, unknown>;
      call_id: string;
    }
  | {
      kind: "tool_result";
      agent: string;
      tool: string;
      call_id: string;
      summary: string;
      payload?: ProductCard[] | MemoryHit[] | null;
    }
  | { kind: "text_delta"; agent: string; text: string }
  | { kind: "agent_done"; agent: string }
  | {
      kind: "db_op";
      phase: "start" | "end";
      request_id: number;
      op: string;
      collection: string;
      vector_search?: boolean;
      doc_count?: number | null;
      duration_ms?: number;
      ok?: boolean;
      error?: string;
    }
  | { kind: "turn_end"; turn_id: string; reply: string }
  | { kind: "error"; message: string };

export type EventKind = ServerEvent["kind"];

export interface ChatMessage {
  id: string;          // turn_id (user) or unique id (agent)
  role: "user" | "agent";
  agent?: string;      // which specialist authored the agent message
  text: string;
  productCards?: ProductCard[];
  memoryRecalled?: MemoryHit[];
  toolBadges?: ToolBadge[];
}

export interface ProductCard {
  sku?: string;
  name?: string;
  text?: string;
  category?: string;
  price?: number;
  size?: string;
  score?: number;
}

export interface ToolBadge {
  tool: string;
  agent: string;
  ok?: boolean;
}

export interface SessionSummary {
  session_id: string;
  title: string;
  turn_count: number;
  updated_at: string | null;
}

export interface ReplayTurn {
  role: "user" | "agent";
  text: string;
  tool_calls: { name: string; args: Record<string, unknown> }[];
  tool_results: { name: string; result: unknown }[];
}

export interface DbOpRecord {
  request_id: number;
  op: string;
  collection: string;
  vector_search: boolean;
  startedAt: number;       // browser ms
  endedAt?: number;
  duration_ms?: number;
  doc_count?: number | null;
  ok?: boolean;
}

export interface TimelineEntry {
  id: string;
  timestamp: number;       // browser ms relative to turn_start
  event: ServerEvent;
}
