import { hybridSearch, type HybridResult } from "../../../lib/search";
import { buildUserPrompt } from "../../../lib/prompt";
import { streamAnswer } from "../../../lib/llm";
import { extractCitations } from "../../../lib/citations";
import { prisma } from "../../../lib/prisma";
import { hit, clientIp } from "../../../lib/rate-limit";

const NOT_FOUND = "I couldn't find anything relevant to that in your documents.";
const GENERIC_ERROR = "Something went wrong while answering. Please try again.";

const PER_VISITOR_PER_HOUR = Number(process.env.CHAT_LIMIT_PER_HOUR ?? 20);
const GLOBAL_PER_DAY = Number(process.env.CHAT_LIMIT_PER_DAY ?? 300);

async function resolveConversation(id: string | null, question: string): Promise<string | null> {
  try {
    if (id) {
      const found = await prisma.conversation.findUnique({ where: { id }, select: { id: true } });
      if (found) return found.id;
    }
    const created = await prisma.conversation.create({
      data: { title: question.slice(0, 80) },
      select: { id: true },
    });
    return created.id;
  } catch (err) {
    console.error("[chat] could not load or create the conversation", err);
    return null; // answering still works, it just won't be saved
  }
}

type Turn = {
  conversationId: string;
  question: string;
  askedAt: Date;
  answer: string;
  error: string | null;
  sources: HybridResult[];
  cited: number[];
};

async function saveTurn(t: Turn) {
  // Explicit timestamps keep the question before its answer; inside one
  // transaction the database's now() would give both the same value.
  const answeredAt = new Date(Math.max(Date.now(), t.askedAt.getTime() + 1));
  const citedSet = new Set(t.cited);

  await prisma.$transaction(
    async (tx) => {
      await tx.message.create({
        data: { conversationId: t.conversationId, role: "USER", content: t.question, createdAt: t.askedAt },
      });
      await tx.message.create({
        data: {
          conversationId: t.conversationId,
          role: "ASSISTANT",
          content: t.answer,
          error: t.error,
          createdAt: answeredAt,
          sources: {
            create: t.sources.map((s, i) => ({
              chunkId: s.id,
              n: i + 1,
              title: s.title,
              page: s.page,
              chunkIndex: s.chunkIndex,
              text: s.text,
              cited: citedSet.has(i + 1),
            })),
          },
        },
      });
      await tx.conversation.update({ where: { id: t.conversationId }, data: { updatedAt: answeredAt } });
    },
    { timeout: 20_000 },
  );
}

/** A normal (200) stream carrying one error event, so the page shows the message as it does any chat error. */
function limitedResponse(message: string) {
  const body = JSON.stringify({ type: "error", message }) + "\n" + JSON.stringify({ type: "done" }) + "\n";
  return new Response(body, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export async function POST(request: Request) {
  let question = "";
  let conversationInput: string | null = null;
  try {
    const body = await request.json();
    question = typeof body.question === "string" ? body.question.trim() : "";
    conversationInput = typeof body.conversationId === "string" ? body.conversationId : null;
  } catch {
    // fall through to the validation below
  }

  if (!question || question.length > 1000) {
    return Response.json(
      { error: 'Send JSON like {"question": "..."} (max 1000 characters).' },
      { status: 400 },
    );
  }

  // Rate limits: per visitor per hour, and a global daily cap that protects the model quota.
  try {
    const visitor = await hit(`chat:ip:${clientIp(request)}`, PER_VISITOR_PER_HOUR, 3600);
    if (!visitor.allowed) {
      return limitedResponse(
        `You’ve reached the limit of ${PER_VISITOR_PER_HOUR} questions per hour in this demo. Please try again later.`,
      );
    }
    const day = new Date().toISOString().slice(0, 10);
    const global = await hit(`chat:global:${day}`, GLOBAL_PER_DAY, 86400);
    if (!global.allowed) {
      return limitedResponse("This demo has reached its daily question limit. Please try again tomorrow.");
    }
  } catch (err) {
    console.error("[chat] rate limiter failed, allowing the request", err);
  }

  const conversationId = await resolveConversation(conversationInput, question);

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
      const askedAt = new Date(t0);
      let sources: HybridResult[] = [];
      let answer = "";
      let errorMessage: string | null = null;
      let cited: number[] = [];

      if (conversationId) send({ type: "conversation", id: conversationId });

      try {
        try {
          sources = await hybridSearch(question, 6);
          console.log(`[chat] retrieval took ${Date.now() - t0}ms (${sources.length} sources)`);

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
            answer = NOT_FOUND;
            send({ type: "token", text: NOT_FOUND });
          } else {
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
          }

          if (!closed) {
            const citations = extractCitations(answer, sources.length);
            cited = citations.cited;
            if (citations.invalid.length > 0) {
              console.warn(`[chat] answer cited unknown sources: ${citations.invalid.join(", ")}`);
            }
            send({ type: "citations", cited: citations.cited, invalid: citations.invalid });
          }
        } catch (err) {
          if (!closed) console.error(err);
          errorMessage = GENERIC_ERROR;
          send({ type: "error", message: errorMessage });
        }

        // Save the turn unless the reader left mid-answer.
        if (!closed && conversationId) {
          try {
            await saveTurn({ conversationId, question, askedAt, answer, error: errorMessage, sources, cited });
          } catch (err) {
            console.error("[chat] could not save the conversation turn", err);
          }
        }

        send({ type: "done" });
        console.log(`[chat] finished in ${Date.now() - t0}ms${closed ? " (client disconnected)" : ""}`);
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