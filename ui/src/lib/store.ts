// Zustand store for the live demo UI.
// Holds chat messages, the timeline of server events, the set of currently
// active agents (for graph node highlighting), in-flight DB operations,
// and the active edge animations.

import { create } from "zustand";
import type {
  ChatMessage,
  DbOpRecord,
  MemoryHit,
  ProductCard,
  ReplayTurn,
  ServerEvent,
  SessionSummary,
  TimelineEntry,
  ToolBadge,
} from "./types";

type EdgeKey = string; // "from->to" identifying a topology edge to animate

interface DemoState {
  // Identity / session
  userId: string;
  sessionId: string | null;
  setUserId: (id: string) => void;
  setSessionId: (id: string | null) => void;

  // Chat
  messages: ChatMessage[];
  isStreaming: boolean;
  setStreaming: (s: boolean) => void;
  addUserMessage: (text: string, turnId: string) => void;
  addAgentMessage: (id: string, agent: string) => void;
  appendAgentText: (id: string, delta: string) => void;
  attachProducts: (id: string, products: ProductCard[]) => void;
  attachMemoryRecall: (id: string, hits: MemoryHit[]) => void;
  attachToolBadge: (id: string, badge: ToolBadge) => void;

  // Timeline (for the live event panel)
  timeline: TimelineEntry[];
  turnStartedAt: number | null;
  pushTimelineEntry: (event: ServerEvent) => void;

  // Graph state
  activeAgents: Set<string>;        // agents currently active (pulse)
  activeDbCollections: Map<string, number>; // collection name → in-flight count
  pulsingEdges: Map<EdgeKey, number>;       // edge key → ms-since-epoch when last triggered
  setAgentActive: (agent: string, active: boolean) => void;
  beginDbOp: (collection: string) => void;
  endDbOp: (collection: string) => void;
  triggerEdge: (key: EdgeKey) => void;

  // DB ops
  dbOps: DbOpRecord[];
  trackDbOpStart: (op: DbOpRecord) => void;
  trackDbOpEnd: (request_id: number, ended: Partial<DbOpRecord>) => void;

  // Node detail panel
  selectedNodeId: string | null;
  setSelectedNodeId: (id: string | null) => void;

  // Sessions list (sidebar)
  sessionList: SessionSummary[];
  loadingSessions: boolean;
  refreshSessions: () => Promise<void>;
  loadSession: (sessionId: string) => Promise<void>;
  newChat: () => void;

  // Lifecycle
  resetTurn: () => void;
  resetAll: () => void;
}

const PERSISTED_USER_ID_KEY = "adk_demo_user_id";

function persistedUserId(): string {
  if (typeof window === "undefined") return "demo-user";
  const v = window.localStorage.getItem(PERSISTED_USER_ID_KEY);
  if (v) return v;
  const fresh = `customer-${Math.random().toString(36).slice(2, 8)}`;
  window.localStorage.setItem(PERSISTED_USER_ID_KEY, fresh);
  return fresh;
}

export const useDemoStore = create<DemoState>((set) => ({
  userId: persistedUserId(),
  sessionId: null,
  setUserId: (id) => {
    if (typeof window !== "undefined") window.localStorage.setItem(PERSISTED_USER_ID_KEY, id);
    set({ userId: id, sessionId: null, messages: [], timeline: [] });
  },
  setSessionId: (id) => set({ sessionId: id }),

  messages: [],
  isStreaming: false,
  setStreaming: (s) => set({ isStreaming: s }),
  addUserMessage: (text, turnId) =>
    set((s) => ({
      messages: [...s.messages, { id: turnId, role: "user", text }],
    })),
  addAgentMessage: (id, agent) =>
    set((s) => {
      // Avoid creating duplicate agent bubbles for the same id.
      if (s.messages.some((m) => m.id === id)) return s;
      return {
        messages: [...s.messages, { id, role: "agent", agent, text: "", toolBadges: [] }],
      };
    }),
  appendAgentText: (id, delta) =>
    set((s) => ({
      messages: s.messages.map((m) =>
        m.id === id && m.role === "agent" ? { ...m, text: (m.text || "") + delta } : m,
      ),
    })),
  attachProducts: (id, products) =>
    set((s) => ({
      messages: s.messages.map((m) => {
        if (m.id !== id) return m;
        // Dedupe by SKU so multi-search Planner turns and any accidental
        // duplicate tool_result events don't double the card grid.
        const existing = m.productCards || [];
        const seen = new Set<string | undefined>(existing.map((p) => p.sku));
        const additions = products.filter((p) => !seen.has(p.sku));
        if (additions.length === 0) return m;
        return { ...m, productCards: [...existing, ...additions] };
      }),
    })),
  attachMemoryRecall: (id, hits) =>
    set((s) => ({
      messages: s.messages.map((m) =>
        m.id === id ? { ...m, memoryRecalled: hits } : m,
      ),
    })),
  attachToolBadge: (id, badge) =>
    set((s) => ({
      messages: s.messages.map((m) => {
        if (m.id !== id || m.role !== "agent") return m;
        const existing = m.toolBadges || [];
        const merged = [...existing, badge];
        return { ...m, toolBadges: merged };
      }),
    })),

  timeline: [],
  turnStartedAt: null,
  pushTimelineEntry: (event) =>
    set((s) => {
      const now = performance.now();
      const startedAt = s.turnStartedAt ?? (event.kind === "turn_start" ? now : now);
      const id = `t${s.timeline.length}-${event.kind}`;
      return {
        timeline: [...s.timeline, { id, timestamp: now - startedAt, event }],
        turnStartedAt: event.kind === "turn_start" ? now : startedAt,
      };
    }),

  activeAgents: new Set<string>(),
  activeDbCollections: new Map(),
  pulsingEdges: new Map(),

  setAgentActive: (agent, active) =>
    set((s) => {
      const next = new Set(s.activeAgents);
      if (active) next.add(agent);
      else next.delete(agent);
      return { activeAgents: next };
    }),
  beginDbOp: (collection) =>
    set((s) => {
      const next = new Map(s.activeDbCollections);
      next.set(collection, (next.get(collection) ?? 0) + 1);
      return { activeDbCollections: next };
    }),
  endDbOp: (collection) =>
    set((s) => {
      const next = new Map(s.activeDbCollections);
      const cur = next.get(collection) ?? 0;
      if (cur <= 1) next.delete(collection);
      else next.set(collection, cur - 1);
      return { activeDbCollections: next };
    }),
  triggerEdge: (key) =>
    set((s) => {
      const next = new Map(s.pulsingEdges);
      next.set(key, performance.now());
      return { pulsingEdges: next };
    }),

  dbOps: [],
  trackDbOpStart: (op) => set((s) => ({ dbOps: [...s.dbOps, op] })),
  trackDbOpEnd: (request_id, ended) =>
    set((s) => ({
      dbOps: s.dbOps.map((o) => (o.request_id === request_id ? { ...o, ...ended } : o)),
    })),

  selectedNodeId: null,
  setSelectedNodeId: (id) => set({ selectedNodeId: id }),

  sessionList: [],
  loadingSessions: false,

  refreshSessions: async () => {
    const { userId } = useDemoStore.getState();
    set({ loadingSessions: true });
    try {
      const res = await fetch(
        `/sessions?user_id=${encodeURIComponent(userId)}&limit=50`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { sessions: SessionSummary[] };
      set({ sessionList: json.sessions });
    } catch (err) {
      console.error("[refreshSessions]", err);
    } finally {
      set({ loadingSessions: false });
    }
  },

  loadSession: async (sessionId: string) => {
    const { userId } = useDemoStore.getState();
    try {
      const res = await fetch(
        `/sessions/${encodeURIComponent(sessionId)}?user_id=${encodeURIComponent(userId)}`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as {
        session_id: string;
        user_id: string;
        turns: ReplayTurn[];
      };

      // Reset live state and hydrate messages from the replay.
      const messages: ChatMessage[] = json.turns.map((t, i) => {
        if (t.role === "user") {
          return { id: `replay-u-${i}`, role: "user", text: t.text };
        }
        const products: ProductCard[] = [];
        const toolBadges: ToolBadge[] = [];
        for (const tc of t.tool_calls || []) {
          toolBadges.push({ tool: tc.name, agent: "" });
        }
        for (const tr of t.tool_results || []) {
          if (tr.name === "search_products" && tr.result) {
            const r = tr.result as { result?: ProductCard[] } | ProductCard[];
            const arr = Array.isArray(r) ? r : r.result;
            if (Array.isArray(arr)) products.push(...arr.slice(0, 20));
          }
        }
        return {
          id: `replay-a-${i}`,
          role: "agent",
          agent: "",
          text: t.text || "",
          productCards: products.length ? products : undefined,
          toolBadges,
        };
      });

      set({
        sessionId: sessionId,
        messages,
        timeline: [],
        turnStartedAt: null,
        activeAgents: new Set(),
        activeDbCollections: new Map(),
        pulsingEdges: new Map(),
        dbOps: [],
      });
    } catch (err) {
      console.error("[loadSession]", err);
    }
  },

  newChat: () =>
    set({
      sessionId: null,
      messages: [],
      timeline: [],
      turnStartedAt: null,
      activeAgents: new Set(),
      activeDbCollections: new Map(),
      pulsingEdges: new Map(),
      dbOps: [],
    }),

  resetTurn: () => set({ timeline: [], turnStartedAt: null, dbOps: [] }),
  resetAll: () =>
    set({
      messages: [],
      timeline: [],
      turnStartedAt: null,
      activeAgents: new Set(),
      activeDbCollections: new Map(),
      pulsingEdges: new Map(),
      dbOps: [],
      sessionId: null,
    }),
}));

// Edge key helpers — keep in sync with AgentGraph topology.
export function edgeKey(from: string, to: string): EdgeKey {
  return `${from}->${to}`;
}

// Map a tool name to (agent, tool, collection) so we can light up the right edges.
export function edgesForToolCall(agent: string, tool: string): EdgeKey[] {
  const edges: EdgeKey[] = [edgeKey(agent, tool)];
  const collection = collectionForTool(tool);
  if (collection) edges.push(edgeKey(tool, collection));
  return edges;
}

export function collectionForTool(tool: string): string | null {
  switch (tool) {
    case "search_products":
      return "products";
    case "save_preference":
    case "recall_preferences":
      return "memory";
    case "record_artifact":
      return "artifacts";
    default:
      return null;
  }
}
