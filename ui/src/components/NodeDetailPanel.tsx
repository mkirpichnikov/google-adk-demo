// Floating side panel that opens when a topology node is clicked.
// Shows the node's purpose, implementation notes, and source-of-truth files.

import { useDemoStore } from "../lib/store";
import { NODE_DOCS } from "../lib/nodeInfo";

const CATEGORY_STYLES: Record<string, { bg: string; fg: string }> = {
  Orchestrator:          { bg: "#E3F2FD", fg: "#0D47A1" },
  Specialist:            { bg: "#E8F5E9", fg: "#005A1D" },
  Tool:                  { bg: "#FFF8E1", fg: "#F57F17" },
  "MongoDB collection":  { bg: "#E5F4EE", fg: "#003D2A" },
  Server:                { bg: "#F3E5F5", fg: "#7B1FA2" },
};

export function NodeDetailPanel() {
  const selectedNodeId = useDemoStore((s) => s.selectedNodeId);
  const setSelectedNodeId = useDemoStore((s) => s.setSelectedNodeId);

  if (!selectedNodeId) return null;
  const doc = NODE_DOCS[selectedNodeId];
  if (!doc) return null;

  const cs = CATEGORY_STYLES[doc.category] || CATEGORY_STYLES.Tool;

  return (
    <div className="absolute top-3 right-3 bottom-3 w-[340px] bg-white rounded-lg shadow-2xl border border-neutral-200 flex flex-col z-50 overflow-hidden">
      <div
        className="px-4 py-3 flex items-start justify-between gap-2 border-b border-neutral-200"
        style={{ background: cs.bg }}
      >
        <div className="min-w-0">
          <div
            className="text-[10px] uppercase tracking-wider font-bold mb-0.5"
            style={{ color: cs.fg }}
          >
            {doc.category}
          </div>
          <div className="text-base font-semibold text-neutral-900 truncate">
            {doc.title}
          </div>
        </div>
        <button
          onClick={() => setSelectedNodeId(null)}
          className="text-neutral-500 hover:text-neutral-900 text-xl leading-none w-6 h-6 flex items-center justify-center rounded-full hover:bg-white/60"
          aria-label="Close"
        >
          ×
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 text-sm">
        <p className="text-neutral-800 leading-relaxed">{doc.summary}</p>

        {doc.details.length > 0 && (
          <div>
            <div className="text-[10px] uppercase tracking-wider font-semibold text-neutral-500 mb-1.5">
              How it works
            </div>
            <ul className="space-y-1.5 text-neutral-700">
              {doc.details.map((d, i) => (
                <li key={i} className="leading-relaxed">
                  <span className="text-neutral-400 mr-1.5">·</span>
                  {d}
                </li>
              ))}
            </ul>
          </div>
        )}

        {doc.files && doc.files.length > 0 && (
          <div>
            <div className="text-[10px] uppercase tracking-wider font-semibold text-neutral-500 mb-1.5">
              Source
            </div>
            <ul className="space-y-1 font-mono text-[12px] text-neutral-700">
              {doc.files.map((f) => (
                <li key={f} className="bg-neutral-50 px-2 py-1 rounded">{f}</li>
              ))}
            </ul>
          </div>
        )}

        {doc.collection && (
          <div className="pt-1">
            <div className="text-[10px] uppercase tracking-wider font-semibold text-neutral-500 mb-1.5">
              Touches collection
            </div>
            <button
              onClick={() => useDemoStore.getState().setSelectedNodeId(doc.collection!)}
              className="text-[13px] font-mono px-2.5 py-1 rounded bg-mongo-light text-mongo border border-mongo/20 hover:bg-mongo hover:text-white transition-colors"
            >
              {doc.collection}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
