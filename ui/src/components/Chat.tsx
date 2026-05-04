import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useDemoStore } from "../lib/store";
import { streamChat } from "../lib/sse";
import { dispatchEvent } from "../lib/dispatch";
import { samplePrompts } from "../lib/prompts";

const AGENT_ACCENT: Record<string, string> = {
  orchestrator: "#1565C0",
  concierge_agent: "#0288D1",
  catalog_agent: "#00852B",
  butler_agent: "#F57F17",
  planner_agent: "#7B1FA2",
};

export function Chat() {
  const userId = useDemoStore((s) => s.userId);
  const sessionId = useDemoStore((s) => s.sessionId);
  const messages = useDemoStore((s) => s.messages);
  const isStreaming = useDemoStore((s) => s.isStreaming);
  const setStreaming = useDemoStore((s) => s.setStreaming);

  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  // Sample fresh prompts when the conversation is empty (page load and
  // after "New chat"). Memoised against `messages.length === 0` so the
  // chips stay stable mid-conversation.
  const isEmpty = messages.length === 0;
  const suggested = useMemo(() => samplePrompts(), [isEmpty]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  async function send(text: string) {
    if (!text.trim() || isStreaming) return;
    setInput("");
    setStreaming(true);
    try {
      await streamChat(
        { user_id: userId, session_id: sessionId, message: text },
        {
          onEvent: dispatchEvent,
          onError: (e) => console.error("[stream]", e),
          onClose: () => setStreaming(false),
        },
      );
    } catch (e) {
      console.error(e);
      setStreaming(false);
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
        {messages.length === 0 && <EmptyState onPick={send} suggested={suggested} />}
        {messages.map((m) => (
          <MessageBubble key={m.id} m={m} />
        ))}
      </div>

      <div className="border-t border-neutral-200 bg-white px-6 py-3">
        <div className="flex flex-wrap gap-2 mb-2">
          {suggested.map((p) => (
            <button
              key={p}
              onClick={() => send(p)}
              disabled={isStreaming}
              className="text-xs px-3 py-1.5 rounded-full border border-neutral-300 text-neutral-700 hover:bg-woolies-light hover:border-woolies disabled:opacity-50"
            >
              {p}
            </button>
          ))}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
          className="flex gap-2"
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={
              isStreaming ? "Agent is working…" : "Ask about products, preferences, or plans"
            }
            disabled={isStreaming}
            className="flex-1 px-4 py-2.5 rounded-full border border-neutral-300 outline-none focus:border-woolies disabled:bg-neutral-50"
          />
          <button
            type="submit"
            disabled={isStreaming || !input.trim()}
            className="px-5 py-2.5 rounded-full bg-woolies text-white font-medium hover:bg-woolies-dark disabled:opacity-50"
          >
            Send
          </button>
        </form>
      </div>
    </div>
  );
}

function EmptyState({ onPick, suggested }: { onPick: (text: string) => void; suggested: string[] }) {
  return (
    <div className="text-center pt-12 pb-6">
      <p className="text-neutral-500 text-sm mb-4">
        Try one of these to see the agents collaborate:
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-w-xl mx-auto">
        {suggested.map((p) => (
          <button
            key={p}
            onClick={() => onPick(p)}
            className="px-4 py-3 rounded-lg border border-neutral-200 bg-white hover:bg-woolies-light hover:border-woolies text-left text-sm"
          >
            {p}
          </button>
        ))}
      </div>
    </div>
  );
}

function MessageBubble({ m }: { m: ReturnType<typeof useDemoStore.getState>["messages"][number] }) {
  if (m.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[70%] bg-woolies text-white rounded-2xl rounded-br-md px-4 py-2.5 text-sm whitespace-pre-wrap">
          {m.text}
        </div>
      </div>
    );
  }

  const accent = AGENT_ACCENT[m.agent || ""] || "#616161";
  const agentLabel = (m.agent || "agent").replace("_agent", "");

  return (
    <div className="flex justify-start">
      <div className="max-w-full w-full">
        <div className="flex items-center gap-2 mb-1.5">
          <span
            className="text-[11px] uppercase tracking-wide font-semibold px-2 py-0.5 rounded"
            style={{ background: `${accent}20`, color: accent }}
          >
            {agentLabel}
          </span>
          {m.toolBadges?.map((b, i) => (
            <span
              key={i}
              className="text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded bg-neutral-100 text-neutral-700"
            >
              {b.tool.replace("_", " ")}
            </span>
          ))}
        </div>

        {m.memoryRecalled && m.memoryRecalled.length > 0 && (
          <div className="bg-purple-bg border border-purple-200 rounded-md px-3 py-2 mb-2 text-xs">
            <div className="text-purple-soft font-semibold uppercase tracking-wide mb-1">
              Memory recalled
            </div>
            <ul className="space-y-0.5 text-neutral-700">
              {m.memoryRecalled.map((h, i) => (
                <li key={i}>· {h.text}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="bg-white border border-neutral-200 rounded-2xl rounded-bl-md px-4 py-2.5 text-sm">
          {m.text ? (
            <div className="markdown-body">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.text}</ReactMarkdown>
            </div>
          ) : (
            <span className="text-neutral-400 italic">…</span>
          )}
        </div>

        {m.productCards && m.productCards.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2">
            {m.productCards.map((p, i) => (
              <ProductCard key={i} p={p} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ProductCard({ p }: { p: import("../lib/types").ProductCard }) {
  const score = p.score != null ? Math.round(p.score * 100) : null;
  return (
    <div className="bg-neutral-50 border border-neutral-200 rounded-lg px-3 py-2">
      <div className="font-semibold text-neutral-900 truncate" title={p.name || p.text}>
        {p.name || p.text || p.sku || "Unknown"}
      </div>
      <div className="flex items-baseline justify-between mt-0.5">
        <span className="text-xs text-neutral-600">
          {p.category}
          {p.size ? ` · ${p.size}` : ""}
        </span>
        <span className="text-sm font-semibold text-woolies">
          {p.price != null ? `$${p.price.toFixed(2)}` : ""}
        </span>
      </div>
      {score != null && (
        <div className="text-[10px] text-neutral-400 mt-1">match {score}%</div>
      )}
    </div>
  );
}
