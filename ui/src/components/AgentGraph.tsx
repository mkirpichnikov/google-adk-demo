import { useMemo, useEffect, useState } from "react";
import ReactFlow, {
  Background,
  type Edge,
  type Node,
  type EdgeMarker,
  MarkerType,
} from "reactflow";

import { useDemoStore, edgeKey } from "../lib/store";
import { AgentNode, type AgentNodeData } from "./AgentNode";
import { BoundaryNode, type BoundaryNodeData } from "./BoundaryNode";
import { NodeDetailPanel } from "./NodeDetailPanel";

const nodeTypes = { agent: AgentNode, boundary: BoundaryNode };

// Topology — kept in sync with the backend's actual capabilities.
// Layout uses absolute coordinates because we want the visual to be stable
// across runs (no surprise auto-layout shifts mid-demo).
//
// Boundary nodes (variant: boundary) are pure visual frames and live FIRST
// in the array so they render behind the interactive agent nodes.
type AnyNodeData = AgentNodeData | BoundaryNodeData;

const NODES: Node<AnyNodeData>[] = [
  // Boundary: ADK runtime — wraps the orchestrator + sub-agents + tools.
  // Sized to encompass row 0 (orchestrator at y=0) through row 2 (tools at
  // y=260, ~60px tall) with breathing room. NOT around MongoDB collections
  // or the FastAPI server — those are external to the ADK code.
  {
    id: "adk_boundary",
    type: "boundary",
    position: { x: -40, y: -30 },
    data: {
      label: "Custom Python ADK runtime",
      sublabel: "orchestrator + sub-agents + tools",
      width: 900,
      height: 380,
      tint: "rgba(21, 101, 192, 0.55)",
      fill: "rgba(21, 101, 192, 0.05)",
    } as BoundaryNodeData,
    draggable: false,
    selectable: false,
    focusable: false,
    zIndex: -1,
  },

  // Row 0: orchestrator
  { id: "orchestrator", type: "agent", position: { x: 380, y: 0 },
    data: { label: "Orchestrator", sublabel: "gemini-2.5-flash", variant: "orchestrator", active: false } },

  // Row 1: specialists (4 across)
  { id: "concierge_agent", type: "agent", position: { x: 0, y: 130 },
    data: { label: "Concierge", sublabel: "help / general", variant: "specialist", active: false } },
  { id: "catalog_agent", type: "agent", position: { x: 200, y: 130 },
    data: { label: "Catalog", sublabel: "specialist", variant: "specialist", active: false } },
  { id: "butler_agent", type: "agent", position: { x: 400, y: 130 },
    data: { label: "Butler", sublabel: "specialist", variant: "specialist", active: false } },
  { id: "planner_agent", type: "agent", position: { x: 620, y: 130 },
    data: { label: "Planner", sublabel: "specialist", variant: "specialist", active: false } },

  // Row 2: tools
  { id: "search_products", type: "agent", position: { x: 200, y: 260 },
    data: { label: "search_products", sublabel: "tool", variant: "tool", active: false } },
  { id: "save_preference", type: "agent", position: { x: 360, y: 260 },
    data: { label: "save_preference", sublabel: "tool", variant: "tool", active: false } },
  { id: "recall_preferences", type: "agent", position: { x: 520, y: 260 },
    data: { label: "recall_preferences", sublabel: "tool", variant: "tool", active: false } },
  { id: "record_artifact", type: "agent", position: { x: 680, y: 260 },
    data: { label: "record_artifact", sublabel: "tool", variant: "tool", active: false } },

  // Row 3: MongoDB collections
  { id: "products", type: "agent", position: { x: 200, y: 390 },
    data: { label: "products", sublabel: "MongoDB", variant: "db", active: false } },
  { id: "memory", type: "agent", position: { x: 440, y: 390 },
    data: { label: "memory", sublabel: "MongoDB", variant: "db", active: false } },
  { id: "artifacts", type: "agent", position: { x: 680, y: 390 },
    data: { label: "artifacts", sublabel: "MongoDB", variant: "db", active: false } },

  // Server-side recall arrow source (memory always-on RAG happens at server, not via a tool)
  { id: "server", type: "agent", position: { x: 380, y: -90 },
    data: { label: "FastAPI server", sublabel: "prepends user memories to every prompt", variant: "server", active: false } },

  // sessions sits next to the FastAPI server, OUTSIDE the ADK boundary's
  // right edge (boundary spans x=-40..860; sessions at x=900). No agent
  // tool reads or writes it — only the MongoSessionService at the server
  // level — so the short server→sessions edge keeps the data flow legible
  // without crossing through the boundary frame.
  { id: "sessions", type: "agent", position: { x: 900, y: -90 },
    data: { label: "sessions", sublabel: "MongoDB", variant: "db", active: false } },
];

const STATIC_EDGES: { from: string; to: string }[] = [
  { from: "server", to: "orchestrator" },
  { from: "server", to: "memory" },
  { from: "server", to: "sessions" },

  { from: "orchestrator", to: "concierge_agent" },
  { from: "orchestrator", to: "catalog_agent" },
  { from: "orchestrator", to: "butler_agent" },
  { from: "orchestrator", to: "planner_agent" },

  { from: "catalog_agent", to: "search_products" },
  { from: "butler_agent", to: "save_preference" },
  { from: "butler_agent", to: "recall_preferences" },
  { from: "planner_agent", to: "search_products" },
  { from: "planner_agent", to: "record_artifact" },

  { from: "search_products", to: "products" },
  { from: "save_preference", to: "memory" },
  { from: "recall_preferences", to: "memory" },
  { from: "record_artifact", to: "artifacts" },
];

const EDGE_PULSE_MS = 1200;

export function AgentGraph() {
  const activeAgents = useDemoStore((s) => s.activeAgents);
  const activeDb = useDemoStore((s) => s.activeDbCollections);
  const pulsingEdges = useDemoStore((s) => s.pulsingEdges);

  // Time tick to drive edge pulse decay.
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    const id = setInterval(() => setNow(performance.now()), 100);
    return () => clearInterval(id);
  }, []);

  const nodes = useMemo<Node<AnyNodeData>[]>(() => {
    return NODES.map((n) => {
      // Boundary nodes are static decorations — no active state.
      if (n.type === "boundary") return n;
      const isAgent = activeAgents.has(n.id);
      const isDb = (activeDb.get(n.id) ?? 0) > 0;
      return {
        ...n,
        data: { ...(n.data as AgentNodeData), active: isAgent || isDb },
      };
    });
  }, [activeAgents, activeDb]);

  const edges = useMemo<Edge[]>(() => {
    return STATIC_EDGES.map(({ from, to }) => {
      const k = edgeKey(from, to);
      const lastPulse = pulsingEdges.get(k) ?? 0;
      const since = now - lastPulse;
      const isPulsing = since >= 0 && since <= EDGE_PULSE_MS;
      const intensity = isPulsing ? 1 - since / EDGE_PULSE_MS : 0;

      const baseColor = "#D4D4D4";
      // Edges leading into MongoDB collections animate green when active.
      const isDbEdge = ["products", "memory", "artifacts", "sessions"].includes(to);
      const accent = isDbEdge ? "#00684A" : "#00852B";

      return {
        id: k,
        source: from,
        target: to,
        animated: isPulsing,
        style: {
          stroke: isPulsing
            ? mixColor(baseColor, accent, intensity)
            : baseColor,
          strokeWidth: isPulsing ? 2.5 : 1.2,
          opacity: isPulsing ? 1 : 0.6,
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: isPulsing ? accent : baseColor,
        } as EdgeMarker,
      };
    });
  }, [pulsingEdges, now]);

  const setSelectedNodeId = useDemoStore((s) => s.setSelectedNodeId);
  const selectedNodeId = useDemoStore((s) => s.selectedNodeId);

  const decoratedNodes = useMemo(
    () =>
      nodes.map((n) => ({
        ...n,
        selected: n.id === selectedNodeId,
        className: "cursor-pointer",
      })),
    [nodes, selectedNodeId],
  );

  return (
    <div className="h-full w-full bg-neutral-50 relative">
      <ReactFlow
        nodes={decoratedNodes}
        edges={edges}
        nodeTypes={nodeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        zoomOnScroll={false}
        zoomOnPinch={true}
        panOnScroll={false}
        panOnDrag={true}
        fitView
        fitViewOptions={{ padding: 0.18, minZoom: 0.6, maxZoom: 1.4 }}
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_, node) => setSelectedNodeId(node.id)}
        onPaneClick={() => setSelectedNodeId(null)}
      >
        <Background gap={20} size={1} color="#e5e5e5" />
      </ReactFlow>
      <NodeDetailPanel />
    </div>
  );
}

// Hex colour blend for pulse decay.
function mixColor(a: string, b: string, t: number): string {
  const ah = parseHex(a);
  const bh = parseHex(b);
  const r = Math.round(ah.r + (bh.r - ah.r) * t);
  const g = Math.round(ah.g + (bh.g - ah.g) * t);
  const bl = Math.round(ah.b + (bh.b - ah.b) * t);
  return `rgb(${r}, ${g}, ${bl})`;
}
function parseHex(h: string): { r: number; g: number; b: number } {
  const v = h.replace("#", "");
  const n = v.length === 3
    ? v.split("").map((c) => parseInt(c + c, 16))
    : [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
  return { r: n[0], g: n[1], b: n[2] };
}
