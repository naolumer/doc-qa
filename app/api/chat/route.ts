import { hybridSearch } from "../../../lib/search";
import { buildUserPrompt } from "../../../lib/prompt";
import { streamAnswer } from "../../../lib/llm";

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

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: object) =>
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));

      try {
        const sources = await hybridSearch(question, 6);

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

        for await (const piece of streamAnswer(buildUserPrompt(question, sources))) {
          send({ type: "token", text: piece });
        }
        send({ type: "done" });
      } catch (err) {
        console.error(err);
        // Log the real error on the server; never send internal details to the browser.
        send({ type: "error", message: "Something went wrong while answering. Please try again." });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}