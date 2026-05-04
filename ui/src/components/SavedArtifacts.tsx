// "Saved" tab in the sidebar — lists artifacts (shopping lists, meal
// plans, recipes) the Planner has persisted for the current user.
// Clicking a row opens a modal that renders the full markdown content.

import { useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useDemoStore } from "../lib/store";
import type { ArtifactSummary } from "../lib/types";

const KIND_STYLES: Record<string, { label: string; bg: string; fg: string }> = {
  shopping_list: { label: "Shopping list", bg: "#E8F5E9", fg: "#005A1D" },
  meal_plan:     { label: "Meal plan",     bg: "#F3E5F5", fg: "#7B1FA2" },
  recipe:        { label: "Recipe",        bg: "#FFF8E1", fg: "#F57F17" },
};

function kindStyle(kind: string) {
  return (
    KIND_STYLES[kind] || {
      label: kind.replace(/_/g, " "),
      bg: "#F5F5F5",
      fg: "#424242",
    }
  );
}

export function SavedArtifacts() {
  const userId = useDemoStore((s) => s.userId);
  const artifactList = useDemoStore((s) => s.artifactList);
  const loading = useDemoStore((s) => s.loadingArtifacts);
  const isStreaming = useDemoStore((s) => s.isStreaming);
  const refresh = useDemoStore((s) => s.refreshArtifacts);
  const openArtifact = useDemoStore((s) => s.openArtifact);

  // Initial load + reload when user changes.
  useEffect(() => {
    refresh();
  }, [userId, refresh]);

  // After a turn ends, give dispatch's setTimeout(600ms) a chance to fire
  // its own refresh — but also make sure we settle a bit later in case of
  // slow Atlas read. Cheap insurance against missed updates.
  useEffect(() => {
    if (!isStreaming) {
      const t = setTimeout(() => refresh(), 1200);
      return () => clearTimeout(t);
    }
  }, [isStreaming, refresh]);

  return (
    <div className="h-full overflow-y-auto px-2 py-2 space-y-1">
      {loading && artifactList.length === 0 && (
        <div className="text-center text-xs text-neutral-400 py-4">Loading…</div>
      )}
      {!loading && artifactList.length === 0 && (
        <div className="text-center text-xs text-neutral-400 px-3 py-6 leading-relaxed">
          Nothing saved yet. Ask the Planner to <em>build a shopping list</em>
          {" "}or <em>plan dinner</em> — it'll save the result here.
        </div>
      )}
      {artifactList.map((a) => (
        <ArtifactRow key={a.artifact_id} a={a} onOpen={() => openArtifact(a.artifact_id)} />
      ))}
    </div>
  );
}

function ArtifactRow({ a, onOpen }: { a: ArtifactSummary; onOpen: () => void }) {
  const ks = kindStyle(a.kind);
  return (
    <button
      onClick={onOpen}
      className="w-full text-left px-3 py-2 rounded-md hover:bg-neutral-50 border border-transparent hover:border-neutral-200 transition-colors"
      title={a.title}
    >
      <div className="flex items-center gap-1.5 mb-1">
        <span
          className="text-[9px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded"
          style={{ background: ks.bg, color: ks.fg }}
        >
          {ks.label}
        </span>
        <span className="text-[10px] text-neutral-400 font-mono ml-auto">
          {timeAgo(a.created_at)}
        </span>
      </div>
      <div className="text-[13px] font-medium text-neutral-900 line-clamp-2 leading-snug">
        {a.title}
      </div>
    </button>
  );
}

export function ArtifactModal() {
  const selectedId = useDemoStore((s) => s.selectedArtifactId);
  const close = () => useDemoStore.getState().openArtifact(null);
  const list = useDemoStore((s) => s.artifactList);

  if (!selectedId) return null;
  const a = list.find((x) => x.artifact_id === selectedId);
  if (!a) return null;

  const ks = kindStyle(a.kind);

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/40 flex items-center justify-center p-6"
      onClick={close}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="bg-white rounded-lg shadow-2xl max-w-2xl w-full max-h-[85vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="px-5 py-3 border-b border-neutral-200 flex items-start justify-between gap-3"
          style={{ background: ks.bg }}
        >
          <div className="min-w-0">
            <div
              className="text-[10px] uppercase tracking-wider font-bold mb-1"
              style={{ color: ks.fg }}
            >
              {ks.label} · {fullTimestamp(a.created_at)}
            </div>
            <div className="text-base font-semibold text-neutral-900 truncate">
              {a.title}
            </div>
          </div>
          <button
            onClick={close}
            className="text-neutral-500 hover:text-neutral-900 text-2xl leading-none w-7 h-7 flex items-center justify-center rounded-full hover:bg-white/60 flex-shrink-0"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <div className="markdown-body text-sm">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{a.content}</ReactMarkdown>
          </div>
        </div>

        <div className="px-5 py-2.5 border-t border-neutral-200 flex justify-between items-center text-[11px] text-neutral-500">
          <span className="font-mono">artifact id: {a.artifact_id.slice(0, 12)}…</span>
          <button
            onClick={() => navigator.clipboard?.writeText(a.content)}
            className="px-3 py-1 rounded border border-neutral-300 hover:bg-neutral-50 text-neutral-700 font-medium"
          >
            Copy markdown
          </button>
        </div>
      </div>
    </div>
  );
}

function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return "now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d`;
  return d.toLocaleDateString();
}

function fullTimestamp(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString();
}
