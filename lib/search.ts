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

const RRF_K = 60;
const MIN_VECTOR_SCORE = 0.58;

export type HybridResult = Omit<SearchResult, "score"> & {
  score: number; // fused RRF score
  vectorRank: number | null;
  keywordRank: number | null;
  vectorScore: number | null;
};

export async function hybridSearch(query: string, limit = 8): Promise<HybridResult[]> {
  const [vec, kw] = await Promise.all([vectorSearch(query, 20), keywordSearch(query, 20)]);

  // Gate: if even the best semantic match is weak, nothing relevant is in the data.
  if (vec.length === 0 || Number(vec[0].score) < MIN_VECTOR_SCORE) return [];

  const merged = new Map<string, HybridResult>();

  const add = (r: SearchResult, rank: number, kind: "vector" | "keyword") => {
    const entry: HybridResult = merged.get(r.id) ?? {
      id: r.id,
      documentId: r.documentId,
      title: r.title,
      page: r.page,
      chunkIndex: r.chunkIndex,
      text: r.text,
      score: 0,
      vectorRank: null,
      keywordRank: null,
      vectorScore: null,
    };
    entry.score += 1 / (RRF_K + rank);
    if (kind === "vector") {
      entry.vectorRank = rank;
      entry.vectorScore = Number(r.score);
    } else {
      entry.keywordRank = rank;
    }
    merged.set(r.id, entry);
  };

  vec.forEach((r, i) => add(r, i + 1, "vector"));
  kw.forEach((r, i) => add(r, i + 1, "keyword"));

  return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}