import { prisma } from "../../../lib/prisma";

export async function GET() {
  const documents = await prisma.document.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      title: true,
      status: true,
      pageCount: true,
      _count: { select: { chunks: true } },
    },
  });

  return Response.json(documents, { headers: { "Cache-Control": "no-store" } });
}