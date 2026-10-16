import { prisma } from "./prisma";
import { embedTexts } from "./embed";

export type SearchResult = {
  id: string;
  documentId: string;
  title: string;
  page: number;
  chunkIndex: number;
  text: string;
  score: number;
};

const toVectorLiteral = (v: number[]) => `[${v.join(",")}]`;

export async function vectorSearch(query: string, limit = 8): Promise<SearchResult[]> {
  const [vector] = await embedTexts([query], "RETRIEVAL_QUERY");
  const literal = toVectorLiteral(vector);

  return prisma.$queryRaw<SearchResult[]>`
    SELECT c."id", c."documentId", d."title", c."page", c."chunkIndex", c."text",
           1 - (c."embedding" <=> ${literal}::vector) AS score
    FROM "Chunk" c
    JOIN "Document" d ON d."id" = c."documentId"
    WHERE d."status" = 'READY' AND c."embedding" IS NOT NULL
    ORDER BY c."embedding" <=> ${literal}::vector
    LIMIT ${limit}
  `;
}

export async function keywordSearch(query: string, limit = 8): Promise<SearchResult[]> {
  // Keep letters/numbers only, drop the word "or", and join terms with OR so that
  // a natural-language question matches chunks containing ANY of its meaningful words.
  const terms = query
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t && t.toLowerCase() !== "or");
  if (terms.length === 0) return [];
  const tsQuery = terms.join(" or ");

  return prisma.$queryRaw<SearchResult[]>`
    WITH q AS (SELECT websearch_to_tsquery('english', ${tsQuery}) AS query)
    SELECT c."id", c."documentId", d."title", c."page", c."chunkIndex", c."text",
           ts_rank(to_tsvector('english', c."text"), q.query) AS score
    FROM "Chunk" c
    JOIN "Document" d ON d."id" = c."documentId"
    CROSS JOIN q
    WHERE d."status" = 'READY'
      AND to_tsvector('english', c."text") @@ q.query
    ORDER BY score DESC
    LIMIT ${limit}
  `;
}