// SSE-over-fetch client.
// /chat/stream is POST (request body carries user_id/session_id/message),
// so we can't use the native EventSource (GET-only). Instead we POST and
// parse the SSE format manually from the streaming response body.

import type { ServerEvent } from "./types";

export interface ChatStreamRequest {
  user_id: string;
  session_id?: string | null;
  message: string;
}

export interface ChatStreamHandlers {
  onEvent: (event: ServerEvent) => void;
  onError?: (error: Error) => void;
  onClose?: () => void;
  signal?: AbortSignal;
}

export async function streamChat(
  req: ChatStreamRequest,
  handlers: ChatStreamHandlers,
): Promise<void> {
  const { onEvent, onError, onClose, signal } = handlers;

  let response: Response;
  try {
    response = await fetch("/chat/stream", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify(req),
      signal,
    });
  } catch (err) {
    onError?.(err as Error);
    onClose?.();
    return;
  }

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "");
    onError?.(new Error(`HTTP ${response.status}: ${text || "(empty body)"}`));
    onClose?.();
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE messages are separated by blank lines (\n\n).
      let sepIdx;
      while ((sepIdx = buffer.indexOf("\n\n")) !== -1) {
        const rawMessage = buffer.slice(0, sepIdx);
        buffer = buffer.slice(sepIdx + 2);

        // A single SSE message may have multiple `data:` lines; concatenate.
        const dataLines = rawMessage
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart());

        if (dataLines.length === 0) continue;

        const payload = dataLines.join("\n");
        try {
          const parsed = JSON.parse(payload) as ServerEvent;
          onEvent(parsed);
        } catch (err) {
          onError?.(new Error(`Bad SSE JSON: ${(err as Error).message}`));
        }
      }
    }
  } catch (err) {
    if ((err as Error).name !== "AbortError") {
      onError?.(err as Error);
    }
  } finally {
    onClose?.();
  }
}
