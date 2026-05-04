// Tabbed sidebar: switches between "Chats" (prior sessions) and "Saved"
// (artifacts the Planner has persisted — shopping lists, meal plans,
// recipes). The "+ New chat" button stays on top, always visible, since
// it's a universal action regardless of which tab you're looking at.

import { useDemoStore } from "../lib/store";
import { SessionList } from "./SessionList";
import { SavedArtifacts } from "./SavedArtifacts";
import type { SidebarTab } from "../lib/store";

export function LibrarySidebar() {
  const tab = useDemoStore((s) => s.sidebarTab);
  const setTab = useDemoStore((s) => s.setSidebarTab);
  const newChat = useDemoStore((s) => s.newChat);
  const sessionCount = useDemoStore((s) => s.sessionList.length);
  const artifactCount = useDemoStore((s) => s.artifactList.length);

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

      <div className="flex border-b border-neutral-200 flex-shrink-0">
        <TabButton active={tab === "chats"} onClick={() => setTab("chats")} label="Chats" count={sessionCount} />
        <TabButton active={tab === "saved"} onClick={() => setTab("saved")} label="Saved" count={artifactCount} />
      </div>

      <div className="flex-1 min-h-0">
        {tab === "chats" ? <SessionList /> : <SavedArtifacts />}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
}) {
  return (
    <button
      onClick={onClick}
      className={[
        "flex-1 px-3 py-2 text-xs font-semibold uppercase tracking-wider transition-colors flex items-center justify-center gap-1.5",
        active
          ? "text-woolies border-b-2 border-woolies bg-woolies-light/50"
          : "text-neutral-500 hover:text-neutral-800 hover:bg-neutral-50 border-b-2 border-transparent",
      ].join(" ")}
    >
      {label}
      {count > 0 && (
        <span
          className={[
            "text-[10px] font-mono px-1.5 py-0.5 rounded-full leading-none",
            active ? "bg-woolies text-white" : "bg-neutral-200 text-neutral-600",
          ].join(" ")}
        >
          {count}
        </span>
      )}
    </button>
  );
}

// re-export the types used by parent
export type { SidebarTab };
