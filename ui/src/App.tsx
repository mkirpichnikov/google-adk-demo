import { Chat } from "./components/Chat";
import { AgentGraph } from "./components/AgentGraph";
import { EventTimeline } from "./components/EventTimeline";
import { LibrarySidebar } from "./components/LibrarySidebar";
import { ArtifactModal } from "./components/SavedArtifacts";
import { useDemoStore } from "./lib/store";

export default function App() {
  const userId = useDemoStore((s) => s.userId);
  const sessionId = useDemoStore((s) => s.sessionId);
  const isStreaming = useDemoStore((s) => s.isStreaming);
  const timelineCount = useDemoStore((s) => s.timeline.length);

  return (
    <div className="h-full flex flex-col">
      <Header userId={userId} sessionId={sessionId} isStreaming={isStreaming} />
      <main className="flex-1 grid grid-cols-1 lg:grid-cols-[220px_1fr_440px_360px] overflow-hidden min-h-0">
        <aside className="hidden lg:flex flex-col min-h-0">
          <SectionLabel>Library</SectionLabel>
          <div className="flex-1 min-h-0">
            <LibrarySidebar />
          </div>
        </aside>
        <section className="border-r border-neutral-200 bg-white flex flex-col min-h-0">
          <SectionLabel>
            Live agent graph
            {isStreaming && <ActivityDot />}
          </SectionLabel>
          <div className="flex-1 min-h-0">
            <AgentGraph />
          </div>
        </section>
        <section className="border-r border-neutral-200 flex flex-col min-h-0 bg-neutral-50">
          <SectionLabel>Conversation</SectionLabel>
          <div className="flex-1 min-h-0">
            <Chat />
          </div>
        </section>
        <section className="hidden lg:flex flex-col min-h-0 bg-white">
          <SectionLabel>
            Event timeline
            <span className="ml-2 text-neutral-400 normal-case font-normal">
              {timelineCount} events
            </span>
          </SectionLabel>
          <div className="flex-1 min-h-0">
            <EventTimeline />
          </div>
        </section>
      </main>
      <ArtifactModal />
    </div>
  );
}

function Header({
  userId,
  sessionId,
  isStreaming,
}: {
  userId: string;
  sessionId: string | null;
  isStreaming: boolean;
}) {
  return (
    <header className="bg-woolies text-white px-6 py-3 flex items-center justify-between flex-shrink-0">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">Grocery Assistant</h1>
        <span className="text-xs px-2 py-0.5 rounded-full bg-white/20 font-medium">
          ADK + MongoDB Atlas
        </span>
        {isStreaming && (
          <span className="text-xs px-2 py-0.5 rounded-full bg-white/30 font-medium animate-pulse">
            agents working…
          </span>
        )}
      </div>
      <div className="text-xs opacity-80 font-mono">
        <span>{userId}</span>
        {sessionId && <span className="ml-3">· {sessionId.slice(0, 8)}…</span>}
      </div>
    </header>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-4 py-2 text-[11px] uppercase tracking-wider font-semibold text-neutral-500 border-b border-neutral-200 bg-white flex-shrink-0 flex items-center">
      {children}
    </div>
  );
}

function ActivityDot() {
  return (
    <span className="ml-2 inline-block w-2 h-2 rounded-full bg-woolies animate-pulse" />
  );
}
