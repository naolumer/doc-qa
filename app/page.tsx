"use client";

import { useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";
import { extractCitations, splitCitations, type CitationResult } from "../lib/citations";

type Source = { n: number; title: string; page: number; chunkIndex: number; text: string };
type Message = {
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
  citations?: CitationResult;
  error?: string;
};
type Doc = {
  id: string;
  title: string;
  status: "PENDING" | "PROCESSING" | "READY" | "FAILED";
  pageCount: number | null;
  _count: { chunks: number };
};
type UploadState =
  | { kind: "idle" }
  | { kind: "uploading"; name: string }
  | { kind: "success" | "info" | "error"; text: string };

const MAX_BYTES = 10 * 1024 * 1024;
const CONVERSATION_KEY = "docqa:conversationId";
const focusRing =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600";
const muted = "text-neutral-500 dark:text-neutral-400";
const border = "border-neutral-200 dark:border-neutral-800";
const pill =
  "inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-blue-600/15 px-1.5 text-xs font-medium text-blue-700 dark:text-blue-300";

async function fetchDocs(): Promise<Doc[] | null> {
  try {
    const res = await fetch("/api/documents", { cache: "no-store" });
    return res.ok ? await res.json() : null;
  } catch {
    return null; // keep the current list if the request fails
  }
}

function Spinner() {
  return (
    <span
      aria-hidden
      className="inline-block size-4 shrink-0 rounded-full border-2 border-current border-t-transparent motion-safe:animate-spin"
    />
  );
}

function AnswerText({
  text,
  sourceCount,
  onOpen,
}: {
  text: string;
  sourceCount: number;
  onOpen: (n: number) => void;
}) {
  return (
    <p className="whitespace-pre-wrap wrap-break-words leading-relaxed">
      {splitCitations(text).map((seg, i) =>
        seg.type === "text" ? (
          <span key={i}>{seg.text}</span>
        ) : (
          <span key={i} className="mx-0.5 inline-flex gap-0.5 align-baseline">
            {seg.numbers.map((n, j) =>
              n >= 1 && n <= sourceCount ? (
                <button
                  key={j}
                  type="button"
                  onClick={() => onOpen(n)}
                  aria-label={`Show source ${n}`}
                  className={`${pill} relative hover:bg-blue-600/25 before:absolute before:-inset-x-0.5 before:-inset-y-2.5 ${focusRing}`}
                >
                  {n}
                </button>
              ) : (
                <span
                  key={j}
                  title="This source doesn’t exist"
                  className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-neutral-500/15 px-1.5 text-xs text-neutral-500 line-through"
                >
                  {n}
                </span>
              ),
            )}
          </span>
        ),
      )}
    </p>
  );
}

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [openSource, setOpenSource] = useState<Record<number, number | null>>({});
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [upload, setUpload] = useState<UploadState>({ kind: "idle" });
  const [dragging, setDragging] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const questionRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  const uploading = upload.kind === "uploading";
  const readyCount = docs.filter((d) => d.status === "READY").length;

  async function refreshDocs() {
    const list = await fetchDocs();
    if (list) setDocs(list);
  }

  useEffect(() => {
    let cancelled = false;
    fetchDocs().then((list) => {
      if (!cancelled && list) setDocs(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Reload the saved conversation from the last visit.
  useEffect(() => {
    const saved = window.localStorage.getItem(CONVERSATION_KEY);
    if (!saved) return;

    let cancelled = false;
    fetch(`/api/conversations/${encodeURIComponent(saved)}`, { cache: "no-store" })
      .then(async (res) => {
        if (cancelled) return;
        if (res.ok) {
          const data = await res.json();
          setConversationId(data.id);
          setMessages((current) => (current.length > 0 ? current : data.messages));
        } else if (res.status === 404) {
          window.localStorage.removeItem(CONVERSATION_KEY);
        }
      })
      .catch(() => {
        // offline or server error: start with an empty conversation
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // Follow the newest text only while the reader is already near the bottom.
  useEffect(() => {
    const onScroll = () => {
      stickRef.current =
        window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 160;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (messages.length > 0 && stickRef.current) {
      bottomRef.current?.scrollIntoView({ block: "end" });
    }
  }, [messages]);

  async function uploadFile(file: File) {
    if (file.type !== "application/pdf") {
      setUpload({ kind: "error", text: "Only PDF files are supported. Choose a .pdf file." });
      return;
    }
    if (file.size > MAX_BYTES) {
      setUpload({ kind: "error", text: "That file is over 10 MB. Choose a smaller PDF." });
      return;
    }

    setUpload({ kind: "uploading", name: file.name });
    const form = new FormData();
    form.append("file", file);

    try {
      const res = await fetch("/api/upload", { method: "POST", body: form });
      const data = await res.json().catch(() => ({}));

      if (res.status === 201) {
        setUpload({
          kind: "success",
          text: `Added “${file.name}” (${data.pages} pages, ${data.chunks} sections).`,
        });
      } else if (res.status === 409) {
        setUpload({ kind: "info", text: `“${file.name}” is already in your documents.` });
      } else {
        setUpload({ kind: "error", text: data.error ?? "Upload failed. Try again." });
      }
    } catch {
      setUpload({ kind: "error", text: "Couldn’t reach the server. Check your connection and try again." });
    }
    refreshDocs();
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file && !uploading) uploadFile(file);
  }

  function showSource(messageIndex: number, n: number) {
    setOpenSource((o) => ({ ...o, [messageIndex]: n }));
    requestAnimationFrame(() => {
      document.getElementById(`source-${messageIndex}-${n}`)?.scrollIntoView({ block: "nearest" });
    });
  }

  function newConversation() {
    setMessages([]);
    setOpenSource({});
    setConversationId(null);
    window.localStorage.removeItem(CONVERSATION_KEY);
  }

  async function ask() {
    const question = input.trim();
    if (!question || busy) return;

    stickRef.current = true;
    setInput("");
    setBusy(true);
    setMessages((m) => [...m, { role: "user", content: question }, { role: "assistant", content: "" }]);

    const update = (fn: (msg: Message) => Message) =>
      setMessages((m) => m.map((msg, i) => (i === m.length - 1 ? fn(msg) : msg)));

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, conversationId }),
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
        buffer = lines.pop() ?? ""; // keep the unfinished last line for the next read

        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line);
          if (event.type === "conversation") {
            setConversationId(event.id);
            window.localStorage.setItem(CONVERSATION_KEY, event.id);
          } else if (event.type === "sources") update((msg) => ({ ...msg, sources: event.sources }));
          else if (event.type === "token") update((msg) => ({ ...msg, content: msg.content + event.text }));
          else if (event.type === "citations")
            update((msg) => ({ ...msg, citations: { cited: event.cited, invalid: event.invalid } }));
          else if (event.type === "error") update((msg) => ({ ...msg, error: event.message }));
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        update((msg) => ({ ...msg, error: "Couldn’t get an answer. Check your connection and try again." }));
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
      questionRef.current?.focus();
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    ask();
  }

  const lastIndex = messages.length - 1;

  return (
    <div className="mx-auto min-h-dvh w-full max-w-5xl px-4 md:px-6">
      <header className="py-6">
        <h1 className="text-2xl font-semibold tracking-tight">Document Q&amp;A</h1>
        <p className={`mt-1 text-sm ${muted}`}>
          Add PDFs, then ask questions. Every answer shows the pages it came from.
        </p>
      </header>

      <div className="md:grid md:grid-cols-[17rem_minmax(0,1fr)] md:gap-8">
        {/* Documents */}
        <aside className="md:sticky md:top-6 md:self-start">
          <button
            type="button"
            aria-expanded={panelOpen}
            aria-controls="documents-panel"
            onClick={() => setPanelOpen((o) => !o)}
            className={`flex min-h-11 w-full items-center justify-between rounded-lg border px-3 text-sm font-medium md:hidden ${border} ${focusRing}`}
          >
            <span>Documents ({readyCount})</span>
            <span aria-hidden>{panelOpen ? "−" : "+"}</span>
          </button>

          <div
            id="documents-panel"
            className={`${panelOpen ? "block" : "hidden"} mt-3 space-y-4 md:mt-0 md:block`}
          >
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              className={`rounded-lg border border-dashed p-4 text-center transition-colors ${
                dragging
                  ? "border-blue-600 bg-blue-600/10"
                  : "border-neutral-300 dark:border-neutral-700"
              }`}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept="application/pdf"
                tabIndex={-1}
                className="sr-only"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) uploadFile(file);
                  e.target.value = "";
                }}
              />
              <button
                type="button"
                disabled={uploading}
                onClick={() => fileInputRef.current?.click()}
                className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60 ${focusRing}`}
              >
                {uploading && <Spinner />}
                {uploading ? "Adding…" : "Choose PDF"}
              </button>
              <p className={`mt-2 text-xs ${muted}`}>or drop a file here. Text-based PDFs up to 10 MB.</p>
            </div>

            <p
              role="status"
              className={`text-sm ${
                upload.kind === "error"
                  ? "text-red-600 dark:text-red-400"
                  : upload.kind === "success"
                    ? "text-green-700 dark:text-green-400"
                    : muted
              }`}
            >
              {upload.kind === "uploading" ? (
                <span className="flex items-start gap-2">
                  <Spinner />
                  <span>Reading and indexing “{upload.name}”. This can take up to 30 seconds.</span>
                </span>
              ) : upload.kind === "idle" ? null : (
                upload.text
              )}
            </p>

            {docs.length === 0 ? (
              <p className={`text-sm ${muted}`}>No documents yet. Add a PDF to get started.</p>
            ) : (
              <ul className="space-y-2">
                {docs.map((d) => (
                  <li
                    key={d.id}
                    className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm ${border}`}
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium" title={d.title}>
                        {d.title}
                      </span>
                      {d.pageCount !== null && (
                        <span className={`block text-xs ${muted}`}>{d.pageCount} pages</span>
                      )}
                    </span>
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${
                        d.status === "READY"
                          ? "bg-green-600/15 text-green-700 dark:text-green-400"
                          : d.status === "FAILED"
                            ? "bg-red-600/15 text-red-700 dark:text-red-400"
                            : "bg-neutral-500/15"
                      }`}
                    >
                      {d.status === "READY" ? "Ready" : d.status === "FAILED" ? "Failed" : "Indexing"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>

        {/* Chat */}
        <main className="mt-6 flex min-h-[60dvh] flex-col md:mt-0">
          <div role="log" aria-live="polite" className="flex-1 space-y-6 pb-6">
            {messages.length === 0 && (
              <div className="py-10">
                <p className="text-lg font-medium">Ask about your documents</p>
                <p className={`mt-1 max-w-prose text-sm ${muted}`}>
                  {readyCount === 0
                    ? "Add a PDF first, then ask your question here."
                    : "Try a specific question, like “What does section 3 say about deadlines?”"}
                </p>
              </div>
            )}

            {messages.map((msg, i) => {
              if (msg.role === "user") {
                return (
                  <div
                    key={i}
                    className="ml-auto w-fit max-w-[85%] wrap-break-words rounded-2xl rounded-br-sm bg-blue-600 px-4 py-2 text-white"
                  >
                    {msg.content}
                  </div>
                );
              }

              const done = !(busy && i === lastIndex);
              const sourceCount = msg.sources?.length ?? 0;
              const cites = msg.citations ?? extractCitations(msg.content, sourceCount);
              const citedSources = cites.cited
                .map((n) => msg.sources?.find((s) => s.n === n))
                .filter((s): s is Source => Boolean(s));

              return (
                <div key={i} className="max-w-[68ch]">
                  {msg.content ? (
                    <AnswerText
                      text={msg.content}
                      sourceCount={sourceCount}
                      onOpen={(n) => showSource(i, n)}
                    />
                  ) : busy && i === lastIndex && !msg.error ? (
                    <p className={`flex items-center gap-2 text-sm ${muted}`}>
                      <Spinner />
                      {msg.sources ? "Writing the answer…" : "Searching your documents…"}
                    </p>
                  ) : null}

                  {msg.error && <p className="mt-1 text-sm text-red-600 dark:text-red-400">{msg.error}</p>}

                  {done && citedSources.length > 0 && (
                    <div className="mt-4">
                      <p className="text-sm font-medium">Sources</p>
                      <ul className="mt-2 space-y-2">
                        {citedSources.map((s) => {
                          const isOpen = openSource[i] === s.n;
                          return (
                            <li key={s.n} id={`source-${i}-${s.n}`} className={`rounded-lg border ${border}`}>
                              <button
                                type="button"
                                aria-expanded={isOpen}
                                onClick={() => setOpenSource((o) => ({ ...o, [i]: isOpen ? null : s.n }))}
                                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm ${focusRing}`}
                              >
                                <span className={pill}>{s.n}</span>
                                <span className="min-w-0 flex-1 truncate">
                                  {s.title}, page {s.page}
                                </span>
                                <span aria-hidden className={muted}>
                                  {isOpen ? "−" : "+"}
                                </span>
                              </button>
                              {isOpen && (
                                <blockquote
                                  tabIndex={0}
                                  className={`max-h-60 overflow-auto border-t px-3 py-2 text-sm leading-relaxed dark:scheme-dark ${border} ${muted} ${focusRing}`}
                                >
                                  {s.text}
                                </blockquote>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  )}

                  {done && msg.content && !msg.error && sourceCount > 0 && cites.cited.length === 0 && (
                    <p className="mt-3 text-sm text-amber-700 dark:text-amber-400">
                      This answer cites no sources.
                    </p>
                  )}
                  {done && cites.invalid.length > 0 && (
                    <p className="mt-3 text-sm text-amber-700 dark:text-amber-400">
                      Some references in this answer don’t match any source and were ignored.
                    </p>
                  )}
                </div>
              );
            })}
          </div>

          <form
            onSubmit={onSubmit}
            className={`sticky bottom-0 -mx-4 border-t bg-white/95 px-4 pb-3 pt-3 backdrop-blur md:mx-0 md:px-0 dark:bg-neutral-950/95 ${border}`}
          >
            <label htmlFor="question" className="sr-only">
              Your question
            </label>
            <div className="flex gap-2">
              <input
                id="question"
                ref={questionRef}
                type="text"
                autoComplete="off"
                enterKeyHint="send"
                maxLength={1000}
                placeholder="Ask a question about your documents"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                disabled={busy}
                className={`min-h-11 min-w-0 flex-1 rounded-lg border bg-transparent px-3 text-base disabled:opacity-60 ${border} ${focusRing}`}
              />
              {busy ? (
                <button
                  type="button"
                  onClick={() => abortRef.current?.abort()}
                  className={`min-h-11 shrink-0 rounded-lg border px-4 text-sm font-medium ${border} ${focusRing}`}
                >
                  Stop
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={!input.trim()}
                  className={`min-h-11 shrink-0 rounded-lg bg-blue-600 px-5 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50 ${focusRing}`}
                >
                  Ask
                </button>
              )}
            </div>
            {messages.length > 0 && !busy && (
              <button
                type="button"
                onClick={newConversation}
                className={`mt-2 rounded text-xs underline-offset-2 hover:underline ${muted} ${focusRing}`}
              >
                New conversation
              </button>
            )}
          </form>
          <div ref={bottomRef} />
        </main>
      </div>
    </div>
  );
}