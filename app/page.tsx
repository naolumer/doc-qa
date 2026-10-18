"use client";

import { useRef, useState } from "react";

type Source = { n: number; title: string; page: number; chunkIndex: number; text: string };
type Message = {
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
  error?: string;
};

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploadStatus, setUploadStatus] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  async function upload(file: File) {
    setUploadStatus(`Uploading ${file.name}... this can take up to 30 seconds`);
    const form = new FormData();
    form.append("file", file);
    try {
      const res = await fetch("/api/upload", { method: "POST", body: form });
      const data = await res.json();
      setUploadStatus(
        res.ok ? `Ready: ${file.name} (${data.chunks} chunks)` : `Failed: ${data.error ?? "unknown error"}`,
      );
    } catch {
      setUploadStatus("Upload failed. Please try again.");
    }
  }

  async function ask() {
    const question = input.trim();
    if (!question || busy) return;

    setInput("");
    setBusy(true);
    setMessages((m) => [
      ...m,
      { role: "user", content: question },
      { role: "assistant", content: "" },
    ]);

    // Update the newest (assistant) message
    const update = (fn: (msg: Message) => Message) =>
      setMessages((m) => m.map((msg, i) => (i === m.length - 1 ? fn(msg) : msg)));

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) throw new Error(`Request failed (${res.status})`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? ""; // keep the incomplete last line for the next read

        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line);
          if (event.type === "sources") update((msg) => ({ ...msg, sources: event.sources }));
          else if (event.type === "token") update((msg) => ({ ...msg, content: msg.content + event.text }));
          else if (event.type === "error") update((msg) => ({ ...msg, error: event.message }));
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        update((msg) => ({ ...msg, error: "Could not get an answer. Please try again." }));
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold">Document Q&amp;A</h1>
        <p className="text-sm text-gray-500">Upload a PDF, then ask questions about it.</p>
      </header>

      <section className="rounded border p-4">
        <label className="block text-sm font-medium">Upload a text-based PDF (max 10 MB)</label>
        <input
          type="file"
          accept="application/pdf"
          className="mt-2 block text-sm"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) upload(file);
            e.target.value = "";
          }}
        />
        {uploadStatus && <p className="mt-2 text-sm text-gray-600">{uploadStatus}</p>}
      </section>

      <section className="flex flex-1 flex-col gap-4">
        {messages.map((msg, i) => (
          <div key={i} className={msg.role === "user" ? "self-end rounded bg-blue-600 px-3 py-2 text-white" : ""}>
            {msg.role === "user" ? (
              msg.content
            ) : (
              <div>
                <p className="whitespace-pre-wrap">
                  {msg.content || (busy && i === messages.length - 1 && !msg.error ? "Thinking..." : "")}
                </p>
                {msg.error && <p className="text-sm text-red-600">{msg.error}</p>}
                {msg.sources && msg.sources.length > 0 && (
                  <details className="mt-2 text-sm text-gray-600">
                    <summary className="cursor-pointer">Sources ({msg.sources.length})</summary>
                    <ul className="mt-1 space-y-2">
                      {msg.sources.map((s) => (
                        <li key={s.n}>
                          <strong>
                            [{s.n}] {s.title}, p.{s.page}
                          </strong>
                          <div className="text-gray-500">{s.text.slice(0, 300)}...</div>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}
          </div>
        ))}
      </section>

      <div className="flex gap-2">
        <input
          className="flex-1 rounded border px-3 py-2"
          placeholder="Ask a question about your documents..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && ask()}
          disabled={busy}
        />
        {busy ? (
          <button className="rounded border px-4 py-2" onClick={() => abortRef.current?.abort()}>
            Stop
          </button>
        ) : (
          <button className="rounded bg-blue-600 px-4 py-2 text-white" onClick={ask}>
            Ask
          </button>
        )}
      </div>
    </main>
  );
}