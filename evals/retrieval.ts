import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { prisma } from "../lib/prisma";
import { vectorSearch, keywordSearch, fuseResults, MIN_VECTOR_SCORE } from "../lib/search";
import { cases } from "./dataset";

const K = 6; // the app sends this many sources to the model

// Compare text ignoring case, punctuation, and spaces (PDF extraction glues or splits words).
const norm = (s: string) => s.normalize("NFKD").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${Math.round((100 * n) / d)}%`);

async function withRetry<T>(fn: () => Promise<T>, tries = 4): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= tries) throw err;
      await sleep(1000 * 2 ** (attempt - 1));
    }
  }
}

type Method = "vector" | "keyword" | "hybrid";
type Row = {
  id: string;
  kind: string;
  question: string;
  labelOk: boolean;
  gated: boolean;
  topScore: number | null;
  ranks: Record<Method, number | null>;
  top: string;
};

function rankOf(list: { text: string }[], evidence: string[]): number | null {
  const needles = evidence.map(norm);
  const index = list.findIndex((chunk) => {
    const text = norm(chunk.text);
    return needles.some((n) => text.includes(n));
  });
  return index === -1 ? null : index + 1;
}

async function main() {
  const flag = process.argv.indexOf("--label");
  const label = flag >= 0 && process.argv[flag + 1] ? process.argv[flag + 1] : "baseline";

  const stored = await prisma.chunk.findMany({
    where: { document: { status: "READY" } },
    select: { text: true },
  });
  const corpus = stored.map((c) => norm(c.text));
  if (corpus.length === 0) {
    console.log("No chunks found. Upload your documents first.");
    process.exit(1);
  }
  console.log(`Corpus: ${corpus.length} chunks. Running ${cases.length} cases (label: ${label}).\n`);

  const rows: Row[] = [];
  for (const c of cases) {
    const needles = c.evidence.map(norm);
    const labelOk =
      c.kind === "unanswerable" || needles.some((n) => corpus.some((text) => text.includes(n)));
    if (!labelOk) {
      console.warn(`! ${c.id}: evidence not found in any chunk (typo, or it spans a chunk boundary). Excluded.`);
    }

    const vec = await withRetry(() => vectorSearch(c.question, 20));
    const kw = await keywordSearch(c.question, 20);
    const topScore = vec.length > 0 ? Number(vec[0].score) : null;
    const gated = topScore === null || topScore < MIN_VECTOR_SCORE;
    const hybrid = gated ? [] : fuseResults(vec, kw, K);

    rows.push({
      id: c.id,
      kind: c.kind,
      question: c.question,
      labelOk,
      gated,
      topScore,
      ranks: {
        vector: rankOf(vec.slice(0, K), c.evidence),
        keyword: rankOf(kw.slice(0, K), c.evidence),
        hybrid: rankOf(hybrid, c.evidence),
      },
      top: hybrid[0] ? `${hybrid[0].title} p.${hybrid[0].page}` : "(rejected by gate)",
    });
    process.stdout.write(".");
    await sleep(300);
  }
  console.log("\n");

  const answerable = rows.filter((r) => r.kind !== "unanswerable" && r.labelOk);
  const methods: Method[] = ["vector", "keyword", "hybrid"];

  const summary = methods.map((m) => {
    const ranks = answerable.map((r) => r.ranks[m]);
    const hit = (k: number) => ranks.filter((x) => x !== null && x <= k).length;
    const mrr = ranks.reduce<number>((sum, x) => sum + (x ? 1 / x : 0), 0) / (answerable.length || 1);
    return {
      method: m,
      "hit@1": pct(hit(1), answerable.length),
      "hit@3": pct(hit(3), answerable.length),
      "hit@6": pct(hit(6), answerable.length),
      MRR: mrr.toFixed(2),
    };
  });
  console.log(`Retrieval on ${answerable.length} answerable questions`);
  console.table(summary);

  const kinds = [...new Set(answerable.map((r) => r.kind))];
  console.log("Hybrid hit@6 by question type");
  console.table(
    kinds.map((k) => {
      const group = answerable.filter((r) => r.kind === k);
      const hits = group.filter((r) => r.ranks.hybrid !== null).length;
      return { type: k, cases: group.length, "hit@6": pct(hits, group.length) };
    }),
  );

  const wronglyGated = answerable.filter((r) => r.gated);
  console.log(`Answerable questions wrongly rejected by the relevance gate: ${wronglyGated.length}`);
  wronglyGated.forEach((r) => console.log(`  ${r.id} (top score ${r.topScore?.toFixed(3)}): ${r.question}`));

  const unanswerable = rows.filter((r) => r.kind === "unanswerable");
  const rejected = unanswerable.filter((r) => r.gated).length;
  console.log(`\nUnanswerable questions rejected at retrieval: ${rejected}/${unanswerable.length}`);
  console.log("The rest reach the model, which must refuse (measured in step 5b):");
  unanswerable
    .filter((r) => !r.gated)
    .forEach((r) => console.log(`  ${r.id} (top score ${r.topScore?.toFixed(3)}): ${r.question}`));

  const misses = answerable.filter((r) => r.ranks.hybrid === null);
  console.log(`\nHybrid misses (evidence not in the top ${K}): ${misses.length}`);
  misses.forEach((r) => console.log(`  ${r.id} [${r.kind}] ${r.question}\n      top result: ${r.top}`));

  mkdirSync("evals/results", { recursive: true });
  const file = `evals/results/${new Date().toISOString().replace(/[:.]/g, "-")}-${label}.json`;
  writeFileSync(
    file,
    JSON.stringify(
      { label, createdAt: new Date().toISOString(), k: K, minVectorScore: MIN_VECTOR_SCORE, corpusChunks: corpus.length, summary, rows },
      null,
      2,
    ),
  );
  console.log(`\nSaved ${file}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});