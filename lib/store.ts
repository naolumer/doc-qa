import { randomUUID } from "node:crypto";
import { Prisma } from "../app/generated/prisma/client";
import { prisma } from "./prisma";
import type { Chunk } from "./chunk";

const toVectorLiteral = (v: number[]) => `[${v.join(",")}]`;
const BATCH_SIZE = 50;

export async function saveChunks(documentId: string, chunks: Chunk[], vectors: number[][]) {
  if (chunks.length !== vectors.length) {
    throw new Error("Chunk and embedding counts do not match");
  }

  await prisma.$transaction(
    async (tx) => {
      for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
        const rows = chunks.slice(i, i + BATCH_SIZE).map(
          (c, j) =>
            Prisma.sql`(${randomUUID()}, ${documentId}, ${c.page}, ${c.chunkIndex}, ${c.text}, ${toVectorLiteral(vectors[i + j])}::vector)`,
        );

        await tx.$executeRaw`
          INSERT INTO "Chunk" ("id", "documentId", "page", "chunkIndex", "text", "embedding")
          VALUES ${Prisma.join(rows)}
        `;
      }
    },
    { timeout: 30_000 },
  );
}