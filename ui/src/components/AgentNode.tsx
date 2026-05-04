import { Handle, Position } from "reactflow";
import type { NodeProps } from "reactflow";

export interface AgentNodeData {
  label: string;
  sublabel?: string;
  active: boolean;
  variant: "orchestrator" | "specialist" | "tool" | "db" | "server";
}

const VARIANTS: Record<AgentNodeData["variant"], { bg: string; ring: string; text: string }> = {
  orchestrator: { bg: "#E3F2FD", ring: "#1565C0", text: "#0D47A1" },
  specialist:   { bg: "#FFF",    ring: "#00852B", text: "#005A1D" },
  tool:         { bg: "#F5F5F5", ring: "#9E9E9E", text: "#424242" },
  db:           { bg: "#E5F4EE", ring: "#00684A", text: "#003D2A" },
  server:       { bg: "#F3E5F5", ring: "#7B1FA2", text: "#4A148C" },
};

export function AgentNode({ data }: NodeProps<AgentNodeData>) {
  const v = VARIANTS[data.variant];
  const active = data.active;

  return (
    <div
      className={[
        "relative px-3 py-2 rounded-lg border-2 min-w-[120px] text-center transition-all",
        active ? "scale-110" : "scale-100",
        active && data.variant === "db" ? "pulse-db" : "",
        active && data.variant !== "db" ? "pulse-active" : "",
      ].join(" ")}
      style={{
        background: v.bg,
        borderColor: v.ring,
        color: v.text,
        boxShadow: active ? `0 4px 12px ${v.ring}55` : "none",
      }}
    >
      <Handle type="target" position={Position.Top} style={{ background: v.ring, opacity: 0 }} />
      <div className="text-[13px] font-semibold leading-tight">{data.label}</div>
      {data.sublabel && (
        <div className="text-[10px] opacity-70 mt-0.5 leading-tight">{data.sublabel}</div>
      )}
      <Handle type="source" position={Position.Bottom} style={{ background: v.ring, opacity: 0 }} />
    </div>
  );
}
