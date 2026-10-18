import { hybridSearch } from "../../../lib/search";
import { buildUserPrompt } from "../../../lib/prompt";
import { streamAnswer } from "../../../lib/llm";
import { extractCitations } from "../../../lib/citations";

const NOT_FOUND = "I couldn't find anything relevant to that in your documents.";

export async function POST(request: Request) {
  let question = "";
  try {
    const body = await request.json();
    question = typeof body.question === "string" ? body.question.trim() : "";
  } catch {
    // fall through to the validation below
  }

  if (!question || question.length > 1000) {
    return Response.json(
      { error: 'Send JSON like {"question": "..."} (max 1000 characters).' },
      { status: 400 },
    );
  }

  const encoder = new TextEncoder();
  let closed = false; // set when the browser disconnects

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: object) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
        } catch {
          closed = true;
        }
      };

      const t0 = Date.now();

      try {
        const sources = await hybridSearch(question, 6);
        console.log(`[chat] retrieval took ${Date.now() - t0}ms (${sources.length} sources)`);
        if (closed) return;

        send({
          type: "sources",
          sources: sources.map((s, i) => ({
            n: i + 1,
            title: s.title,
            page: s.page,
            chunkIndex: s.chunkIndex,
            text: s.text,
          })),
        });

        if (sources.length === 0) {
          send({ type: "token", text: NOT_FOUND });
          send({ type: "done" });
          return;
        }

        let answer = "";
        let first = true;
        for await (const piece of streamAnswer(buildUserPrompt(question, sources))) {
          if (closed) break; // client left: stop generating
          if (first) {
            console.log(`[chat] first token after ${Date.now() - t0}ms`);
            first = false;
          }
          answer += piece;
          send({ type: "token", text: piece });
        }

        if (!closed) {
          const citations = extractCitations(answer, sources.length);
          if (citations.invalid.length > 0) {
            console.warn(`[chat] answer cited unknown sources: ${citations.invalid.join(", ")}`);
          }
          send({ type: "citations", cited: citations.cited, invalid: citations.invalid });
        }

        send({ type: "done" });
        console.log(`[chat] finished in ${Date.now() - t0}ms${closed ? " (client disconnected)" : ""}`);
      } catch (err) {
        if (!closed) console.error(err);
        send({ type: "error", message: "Something went wrong while answering. Please try again." });
      } finally {
        if (!closed) {
          try {
            controller.close();
          } catch {
            // already closed
          }
        }
      }
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}