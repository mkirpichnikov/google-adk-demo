// Pure-visual node — renders a soft tinted background panel that frames a
// region of the topology graph. Used to draw the boundary of "everything
// running inside ADK" (orchestrator + sub-agents + tools), so the audience
// can see at a glance what's application code vs. external infrastructure
// (MongoDB, FastAPI host).
//
// Non-interactive: not draggable, not selectable, no edge handles. Placed
// first in the nodes array so it renders behind the agent nodes.

import type { NodeProps } from "reactflow";

export interface BoundaryNodeData {
  label: string;
  sublabel?: string;
  width: number;
  height: number;
  // Single-tone palette — tweakable per boundary.
  tint?: string;     // border + label colour
  fill?: string;     // background fill
}

export function BoundaryNode({ data }: NodeProps<BoundaryNodeData>) {
  const tint = data.tint ?? "rgba(21, 101, 192, 0.55)";
  const fill = data.fill ?? "rgba(21, 101, 192, 0.05)";

  return (
    <div
      style={{
        width: data.width,
        height: data.height,
        background: fill,
        border: `2px dashed ${tint}`,
        borderRadius: 14,
        position: "relative",
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 8,
          left: 14,
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: 1.2,
          color: tint,
          textTransform: "uppercase",
          background: "rgba(255,255,255,0.85)",
          padding: "2px 6px",
          borderRadius: 4,
        }}
      >
        {data.label}
      </div>
      {data.sublabel && (
        <div
          style={{
            position: "absolute",
            top: 30,
            left: 14,
            fontSize: 10,
            color: tint,
            opacity: 0.8,
            background: "rgba(255,255,255,0.6)",
            padding: "1px 5px",
            borderRadius: 3,
          }}
        >
          {data.sublabel}
        </div>
      )}
    </div>
  );
}
