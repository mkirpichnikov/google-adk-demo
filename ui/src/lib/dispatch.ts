// Reduce backend events into the zustand store. Centralises the protocol
// → state mapping so components stay declarative.

import { useDemoStore, edgeKey, edgesForToolCall, collectionForTool } from "./store";
import type { ServerEvent } from "./types";

// Track the agent currently emitting tokens (so we can append to the right bubble).
let activeAgentMsgId: string | null = null;
let activeAgentName: string | null = null;
const callIdToProducts = new Map<string, string>(); // call_id → message id (so search results land on the right bubble)

export function dispatchEvent(event: ServerEvent) {
  const store = useDemoStore.getState();
  store.pushTimelineEntry(event);

  switch (event.kind) {
    case "turn_start": {
      store.setSessionId(event.session_id);
      store.addUserMessage(event.message, event.turn_id);
      activeAgentMsgId = null;
      activeAgentName = null;
      break;
    }

    case "memory_recalled": {
      if (!event.hits?.length) break;
      const lastUser = [...store.messages].reverse().find((m) => m.role === "user");
      if (lastUser) {
        store.attachMemoryRecall(lastUser.id, event.hits);
      }
      // Also pulse the memory edge so the graph reflects recall visually.
      store.triggerEdge(edgeKey("server", "memory"));
      break;
    }

    case "agent_active": {
      store.setAgentActive(event.agent, true);
      // Highlight orchestrator → specialist path on first activation.
      if (event.agent !== "orchestrator") {
        store.triggerEdge(edgeKey("orchestrator", event.agent));
      }
      // Open a new agent message bubble if this is a new "speaker" (not orch).
      if (event.agent !== "orchestrator") {
        const id = `agent-${event.agent}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        store.addAgentMessage(id, event.agent);
        activeAgentMsgId = id;
        activeAgentName = event.agent;
      }
      break;
    }

    case "agent_transfer": {
      store.triggerEdge(edgeKey(event.from, event.to));
      break;
    }

    case "tool_call": {
      // Light up agent→tool and tool→collection edges + pulse the tool node.
      for (const k of edgesForToolCall(event.agent, event.tool)) {
        store.triggerEdge(k);
      }
      store.setAgentActive(event.tool, true); // re-use active set for tools too
      // Attach a badge to the active agent bubble.
      if (activeAgentMsgId && activeAgentName === event.agent) {
        const detail =
          event.tool === "record_artifact"
            ? String(event.args?.kind ?? "")
            : undefined;
        store.attachToolBadge(activeAgentMsgId, {
          tool: event.tool,
          agent: event.agent,
          detail,
        });
        if (event.tool === "search_products") {
          callIdToProducts.set(event.call_id, activeAgentMsgId);
        }
      }
      break;
    }

    case "tool_result": {
      store.setAgentActive(event.tool, false);
      if (event.tool === "search_products" && event.payload && Array.isArray(event.payload)) {
        const msgId = callIdToProducts.get(event.call_id) || activeAgentMsgId;
        if (msgId) {
          store.attachProducts(msgId, event.payload as import("./types").ProductCard[]);
        }
      }
      if (event.tool === "recall_preferences" && event.payload && Array.isArray(event.payload)) {
        const msgId = activeAgentMsgId;
        if (msgId) {
          store.attachMemoryRecall(msgId, event.payload as import("./types").MemoryHit[]);
        }
      }
      break;
    }

    case "text_delta": {
      if (!activeAgentMsgId || activeAgentName !== event.agent) {
        // Defensive: open a bubble if we missed the activation event.
        const id = `agent-${event.agent}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        store.addAgentMessage(id, event.agent);
        activeAgentMsgId = id;
        activeAgentName = event.agent;
      }
      store.appendAgentText(activeAgentMsgId!, event.text);
      break;
    }

    case "agent_done": {
      store.setAgentActive(event.agent, false);
      break;
    }

    case "db_op": {
      if (event.phase === "start") {
        store.beginDbOp(event.collection);
        store.trackDbOpStart({
          request_id: event.request_id,
          op: event.op,
          collection: event.collection,
          vector_search: !!event.vector_search,
          startedAt: performance.now(),
          doc_count: event.doc_count,
        });
      } else {
        store.endDbOp(event.collection);
        store.trackDbOpEnd(event.request_id, {
          duration_ms: event.duration_ms,
          doc_count: event.doc_count,
          ok: event.ok,
          endedAt: performance.now(),
        });
      }
      break;
    }

    case "turn_end": {
      // Clear active agents (best-effort — agent_done should already have fired).
      const store2 = useDemoStore.getState();
      const activeNow = Array.from(store2.activeAgents);
      for (const a of activeNow) store2.setAgentActive(a, false);
      activeAgentMsgId = null;
      activeAgentName = null;
      break;
    }

    case "error": {
      console.error("[stream error]", event.message);
      break;
    }
  }
}

// Re-export helpers for components that need the same lookups.
export { edgeKey, collectionForTool };
