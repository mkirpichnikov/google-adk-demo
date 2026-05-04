// Inner row renderer for the Chats tab in the library sidebar.
// Outer chrome (tab bar, "New chat" button) lives in LibrarySidebar.

import { useEffect } from "react";
import { useDemoStore } from "../lib/store";

export function SessionList() {
  const userId = useDemoStore((s) => s.userId);
  const sessionList = useDemoStore((s) => s.sessionList);
  const loadingSessions = useDemoStore((s) => s.loadingSessions);
  const sessionId = useDemoStore((s) => s.sessionId);
  const isStreaming = useDemoStore((s) => s.isStreaming);
  const refreshSessions = useDemoStore((s) => s.refreshSessions);
  const loadSession = useDemoStore((s) => s.loadSession);

  useEffect(() => {
    refreshSessions();
  }, [userId, refreshSessions]);

  useEffect(() => {
    if (!isStreaming) {
      const t = setTimeout(() => refreshSessions(), 400);
      return () => clearTimeout(t);
    }
  }, [isStreaming, refreshSessions]);

  return (
    <div className="h-full overflow-y-auto px-2 py-2 space-y-1">
      {loadingSessions && sessionList.length === 0 && (
        <div className="text-center text-xs text-neutral-400 py-4">Loading…</div>
      )}
      {!loadingSessions && sessionList.length === 0 && (
        <div className="text-center text-xs text-neutral-400 py-4">No prior chats yet.</div>
      )}
      {sessionList.map((s) => {
        const active = sessionId === s.session_id;
        return (
          <button
            key={s.session_id}
            onClick={() => loadSession(s.session_id)}
            className={[
              "w-full text-left px-3 py-2 rounded-md transition-colors",
              active
                ? "bg-woolies-light border border-woolies"
                : "hover:bg-neutral-50 border border-transparent",
            ].join(" ")}
            title={s.title}
          >
            <div className="text-[13px] font-medium text-neutral-900 truncate">
              {s.title || "Untitled"}
            </div>
            <div className="text-[10px] text-neutral-500 mt-0.5 flex items-center justify-between">
              <span>{s.turn_count} turn{s.turn_count === 1 ? "" : "s"}</span>
              <span className="font-mono">{timeAgo(s.updated_at)}</span>
            </div>
          </button>
        );
      })}
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
