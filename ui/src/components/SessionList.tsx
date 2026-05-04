// Sidebar listing the current user's prior chat sessions.
// Click a row to replay it; "New chat" clears state for a fresh turn.
// Auto-refreshes when the agent finishes streaming so newly-completed
// sessions surface without a manual reload.

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
  const newChat = useDemoStore((s) => s.newChat);

  // Initial load + reload when user_id changes.
  useEffect(() => {
    refreshSessions();
  }, [userId, refreshSessions]);

  // Refresh when a turn finishes streaming so the latest session bumps to top.
  useEffect(() => {
    if (!isStreaming) {
      const t = setTimeout(() => refreshSessions(), 400);
      return () => clearTimeout(t);
    }
  }, [isStreaming, refreshSessions]);

  return (
    <div className="h-full flex flex-col bg-white border-r border-neutral-200">
      <div className="px-3 py-2 border-b border-neutral-200 flex-shrink-0">
        <button
          onClick={() => newChat()}
          className="w-full text-sm font-medium px-3 py-1.5 rounded-md bg-woolies text-white hover:bg-woolies-dark"
        >
          + New chat
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-2 space-y-1">
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
                <span className="font-mono">{formatTimestamp(s.updated_at)}</span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const now = new Date();
  const diff = (now.getTime() - d.getTime()) / 1000;
  if (diff < 60) return "now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d`;
  return d.toLocaleDateString();
}
