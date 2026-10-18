import { prisma } from "../../../../lib/prisma";
import { extractCitations } from "../../../../lib/citations";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const conversation = await prisma.conversation.findUnique({
    where: { id },
    select: {
      id: true,
      messages: {
        orderBy: { createdAt: "asc" },
        select: {
          role: true,
          content: true,
          error: true,
          sources: {
            orderBy: { n: "asc" },
            select: { n: true, title: true, page: true, chunkIndex: true, text: true },
          },
        },
      },
    },
  });

  if (!conversation) {
    return Response.json({ error: "Conversation not found." }, { status: 404 });
  }

  const messages = conversation.messages.map((m) =>
    m.role === "USER"
      ? { role: "user" as const, content: m.content }
      : {
          role: "assistant" as const,
          content: m.content,
          error: m.error ?? undefined,
          sources: m.sources,
          citations: extractCitations(m.content, m.sources.length),
        },
  );

  return Response.json({ id: conversation.id, messages }, { headers: { "Cache-Control": "no-store" } });
}