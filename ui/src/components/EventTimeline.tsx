// Live chronological log of every server event. Complements the topology
// graph by giving the audience exact ordering, timing, and payload detail.

import { useEffect, useRef } from "react";
import { useDemoStore } from "../lib/store";
import type { ServerEvent, TimelineEntry } from "../lib/types";

const EVENT_STYLES: Record<
  ServerEvent["kind"],
  { label: string; bg: string; fg: string; ring?: string }
> = {
  turn_start:      { label: "TURN START",       bg: "#F5F5F5", fg: "#212121" },
  memory_recalled: { label: "MEMORY RECALLED",  bg: "#F3E5F5", fg: "#7B1FA2" },
  agent_active:    { label: "AGENT ACTIVE",     bg: "#E8F5E9", fg: "#005A1D" },
  agent_transfer:  { label: "AGENT TRANSFER",   bg: "#E3F2FD", fg: "#0D47A1" },
  tool_call:       { label: "TOOL CALL",        bg: "#FFF8E1", fg: "#F57F17" },
  tool_result:     { label: "TOOL RESULT",      bg: "#FFFDE7", fg: "#827717" },
  text_delta:      { label: "TEXT DELTA",       bg: "#FAFAFA", fg: "#616161" },
  agent_done:      { label: "AGENT DONE",       bg: "#F5F5F5", fg: "#424242" },
  db_op:           { label: "DB OP",            bg: "#E5F4EE", fg: "#003D2A" },
  turn_end:        { label: "TURN END",         bg: "#EEEEEE", fg: "#212121" },
  error:           { label: "ERROR",            bg: "#FFEBEE", fg: "#B71C1C" },
};

function formatTimestamp(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function EventTimeline() {
  const timeline = useDemoStore((s) => s.timeline);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [timeline]);

  return (
    <div ref={scrollRef} className="h-full overflow-y-auto px-3 py-3 space-y-1.5 font-mono text-[11px]">
      {timeline.length === 0 && (
        <div className="text-center text-neutral-400 py-6 text-xs">
          No events yet — send a message to start.
        </div>
      )}
      {timeline.map((e) => (
        <TimelineRow key={e.id} entry={e} />
      ))}
    </div>
  );
}

function TimelineRow({ entry }: { entry: TimelineEntry }) {
  const ev = entry.event;
  const style = EVENT_STYLES[ev.kind] || EVENT_STYLES["text_delta"];

  return (
    <div className="flex items-start gap-2 leading-tight">
      <div className="text-neutral-400 w-14 flex-shrink-0 text-right pt-0.5">
        {formatTimestamp(entry.timestamp)}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 mb-0.5">
          <span
            className="px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wide"
            style={{ background: style.bg, color: style.fg }}
          >
            {style.label}
          </span>
          <EventDetail event={ev} />
        </div>
      </div>
    </div>
  );
}

function EventDetail({ event }: { event: ServerEvent }) {
  switch (event.kind) {
    case "turn_start":
      return (
        <span className="text-neutral-700 truncate" title={event.message}>
          “{event.message}”
        </span>
      );
    case "memory_recalled":
      return (
        <span className="text-neutral-600">{event.hits.length} hit(s)</span>
      );
    case "agent_active":
      return (
        <span className="text-neutral-700 font-semibold">{event.agent}</span>
      );
    case "agent_transfer":
      return (
        <span className="text-neutral-700">
          <span className="font-semibold">{event.from}</span>
          <span className="text-neutral-400 mx-1">→</span>
          <span className="font-semibold">{event.to}</span>
        </span>
      );
    case "tool_call": {
      const args = compactArgs(event.args);
      return (
        <span className="text-neutral-700 truncate" title={args}>
          <span className="font-semibold">{event.agent}.{event.tool}</span>
          <span className="text-neutral-500 ml-1">({args})</span>
        </span>
      );
    }
    case "tool_result":
      return (
        <span className="text-neutral-700">
          <span className="font-semibold">{event.tool}</span>
          <span className="text-neutral-500 ml-1">→ {event.summary}</span>
        </span>
      );
    case "text_delta":
      return (
        <span className="text-neutral-500 italic truncate">
          {event.agent}: {previewText(event.text)}
        </span>
      );
    case "agent_done":
      return <span className="text-neutral-600">{event.agent}</span>;
    case "db_op": {
      const isVector = event.vector_search;
      const label = isVector ? "$vectorSearch" : event.op;
      const phase = event.phase === "start" ? "▶" : "✓";
      const dur =
        event.phase === "end" && event.duration_ms !== undefined
          ? ` · ${event.duration_ms.toFixed(0)} ms`
          : "";
      const docs =
        event.doc_count != null && event.phase === "end"
          ? ` · ${event.doc_count} docs`
          : "";
      return (
        <span className="text-neutral-700">
          <span className="text-mongo">{phase}</span>{" "}
          <span className="font-semibold">{label}</span>
          <span className="text-neutral-500"> on {event.collection}</span>
          <span className="text-neutral-500">{dur}{docs}</span>
        </span>
      );
    }
    case "turn_end":
      return (
        <span className="text-neutral-600">
          {event.reply ? `reply: ${previewText(event.reply, 50)}` : ""}
        </span>
      );
    case "error":
      return <span className="text-red-700">{event.message}</span>;
  }
}

function previewText(text: string, max = 60): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}

function compactArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args);
  if (entries.length === 0) return "";
  return entries
    .map(([k, v]) => {
      if (typeof v === "string") return `${k}: "${v.slice(0, 40)}"`;
      return `${k}: ${JSON.stringify(v)}`;
    })
    .join(", ");
}
