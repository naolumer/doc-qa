import "dotenv/config";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { GoogleGenAI } from "@google/genai";
import { hybridSearch } from "../lib/search";
import { buildUserPrompt, PROMPT_VARIANT } from "../lib/prompt";
import { streamAnswer, CHAT_MODEL } from "../lib/llm";
import { extractCitations } from "../lib/citations";
import { cases as mainCases, type EvalCase } from "./dataset";
import { holdout } from "./holdout";

const cases: EvalCase[] = process.argv.includes("--holdout") ? holdout : mainCases;
const RETRIEVE_K = Number(process.env.RETRIEVE_K ?? 6);
const JUDGE_MODEL = process.env.GEMINI_JUDGE_MODEL ?? CHAT_MODEL;
const NOT_FOUND = "I couldn't find anything relevant to that in your documents.";

const norm = (s: string) => s.normalize("NFKD").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${Math.round((100 * n) / d)}%`);
const oneLine = (s: string, max: number) => s.replace(/\s+/g, " ").slice(0, max);

type Level = "yes" | "partial" | "no";
type Source = { n: number; title: string; page: number; chunkIndex: number; text: string };
type Judgement =
  | { kind: "answerable"; correct: Level; supported: Level; reason: string }
  | { kind: "unanswerable"; refused: boolean; invented: boolean; reason: string };
type CaseRun = {
  id: string;
  kind: EvalCase["kind"];
  question: string;
  gated: boolean;
  answer: string;
  sources: Source[];
  cited: number[];
  invalid: number[];
  evidenceRetrieved: boolean | null;
  evidenceCited: boolean | null;
  genMs: number;
  judgement: Judgement | null;
};
type Store = { label: string; model: string; judgeModel: string; runs: Record<string, CaseRun> };

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error("timeout"), { status: 503 })), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

async function withRetry<T>(fn: () => Promise<T>, tries = 4): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= tries) throw err;
      await sleep(1500 * 2 ** (attempt - 1));
    }
  }
}

const JUDGE_SYSTEM =
  "You grade answers from a document question-answering system. Be strict and literal. Reply with JSON only.";

async function judge(prompt: string): Promise<Record<string, unknown>> {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return withRetry(async () => {
    const res = await withTimeout(
      ai.models.generateContent({
        model: JUDGE_MODEL,
        contents: prompt,
        config: { systemInstruction: JUDGE_SYSTEM, temperature: 0, responseMimeType: "application/json" },
      }),
      60_000,
    );
    const text = (res.text ?? "").replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    return JSON.parse(text) as Record<string, unknown>;
  }, 5);
}

const asLevel = (v: unknown): Level => (v === "yes" || v === "partial" || v === "no" ? v : "no");

async function judgeRun(c: EvalCase, run: CaseRun): Promise<Judgement> {
  if (c.kind === "unanswerable") {
    const raw = await judge(
      `Question: ${c.question}\n\n` +
        `The documents do NOT contain the answer to this question.\n\n` +
        `System answer:\n${run.answer}\n\n` +
        `Grade the system answer.\n` +
        `- refused: true if it says the information is not in the documents or cannot be found.\n` +
        `- invented: true if it nevertheless states a specific answer to the question (a name, number, date, or other concrete fact).\n` +
        `Return JSON: {"refused": true or false, "invented": true or false, "reason": "one short sentence"}`,
    );
    return {
      kind: "unanswerable",
      refused: raw.refused === true,
      invented: raw.invented === true,
      reason: String(raw.reason ?? ""),
    };
  }

  const passages = run.cited.length
    ? run.cited
        .map((n) => `[S${n}] (page ${run.sources[n - 1]?.page})\n${run.sources[n - 1]?.text ?? ""}`)
        .join("\n\n")
    : "(none)";

  const raw = await judge(
    `Question: ${c.question}\n\n` +
      `Reference answer (ground truth): ${c.expected}\n\n` +
      `System answer:\n${run.answer}\n\n` +
      `Passages the system answer cited:\n${passages}\n\n` +
      `Grade the system answer.\n` +
      `- correct: "yes" if it agrees with the reference answer on the key facts, "partial" if it is incomplete or partly wrong, "no" if it contradicts the reference or fails to answer.\n` +
      `- supported: "yes" if every factual claim in it is backed by the cited passages, "partial" if some claims are not, "no" if most claims are not backed or no passages were cited.\n` +
      `Return JSON: {"correct": "yes|partial|no", "supported": "yes|partial|no", "reason": "one short sentence"}`,
  );
  return {
    kind: "answerable",
    correct: asLevel(raw.correct),
    supported: asLevel(raw.supported),
    reason: String(raw.reason ?? ""),
  };
}

async function generate(c: EvalCase): Promise<CaseRun> {
  const t0 = Date.now();
  const answerable = c.kind !== "unanswerable";
  const needles = c.evidence.map(norm);
  const hasEvidence = (text: string) => needles.length > 0 && needles.some((n) => norm(text).includes(n));

  const found = await hybridSearch(c.question, RETRIEVE_K);
  const sources: Source[] = found.map((s, i) => ({
    n: i + 1,
    title: s.title,
    page: s.page,
    chunkIndex: s.chunkIndex,
    text: s.text,
  }));

  if (found.length === 0) {
    return {
      id: c.id,
      kind: c.kind,
      question: c.question,
      gated: true,
      answer: NOT_FOUND,
      sources,
      cited: [],
      invalid: [],
      evidenceRetrieved: answerable ? false : null,
      evidenceCited: answerable ? false : null,
      genMs: Date.now() - t0,
      judgement: null,
    };
  }

  let answer = "";
  for await (const piece of streamAnswer(buildUserPrompt(c.question, found))) answer += piece;

  const { cited, invalid } = extractCitations(answer, found.length);
  return {
    id: c.id,
    kind: c.kind,
    question: c.question,
    gated: false,
    answer,
    sources,
    cited,
    invalid,
    evidenceRetrieved: answerable ? sources.some((s) => hasEvidence(s.text)) : null,
    evidenceCited: answerable ? cited.some((n) => hasEvidence(sources[n - 1].text)) : null,
    genMs: Date.now() - t0,
    judgement: null,
  };
}

function printSummary(store: Store) {
  const runs = cases.map((c) => store.runs[c.id]).filter((r): r is CaseRun => Boolean(r));
  const answerable = runs.filter((r) => r.kind !== "unanswerable");
  const unanswerable = runs.filter((r) => r.kind === "unanswerable");

  const level = (r: CaseRun, key: "correct" | "supported"): Level => {
    if (r.gated) return "no";
    return r.judgement?.kind === "answerable" ? r.judgement[key] : "no";
  };
  const count = (key: "correct" | "supported", want: Level) =>
    answerable.filter((r) => level(r, key) === want).length;

  console.log(`\nAnswer quality on ${answerable.length} answerable questions (judge: ${store.judgeModel})`);
  console.table(
    (["correct", "supported"] as const).map((key) => ({
      measure: key === "correct" ? "answer is correct" : "claims backed by cited passages",
      yes: pct(count(key, "yes"), answerable.length),
      partial: pct(count(key, "partial"), answerable.length),
      no: pct(count(key, "no"), answerable.length),
    })),
  );

  const retrieved = answerable.filter((r) => r.evidenceRetrieved).length;
  const citedRight = answerable.filter((r) => r.evidenceCited).length;
  const noCites = answerable.filter((r) => !r.gated && r.cited.length === 0).length;
  const invalidAnswers = runs.filter((r) => r.invalid.length > 0).length;
  const times = runs.filter((r) => !r.gated).map((r) => r.genMs).sort((a, b) => a - b);
  const median = times.length ? times[Math.floor(times.length / 2)] : 0;

  console.log("Checks done by code");
  console.table([
    { check: "evidence in the retrieved sources", result: pct(retrieved, answerable.length) },
    { check: "answer cites a source with the evidence", result: pct(citedRight, answerable.length) },
    { check: "answerable questions answered with no citation", result: `${noCites}` },
    { check: "answers citing a source that doesn't exist", result: `${invalidAnswers}` },
    { check: "median time per answer (search + model)", result: `${(median / 1000).toFixed(1)}s` },
  ]);

  const judged = unanswerable.filter((r) => r.gated || r.judgement?.kind === "unanswerable");
  const refused = judged.filter((r) => r.gated || (r.judgement?.kind === "unanswerable" && r.judgement.refused)).length;
  const invented = judged.filter((r) => r.judgement?.kind === "unanswerable" && r.judgement.invented).length;
  console.log(
    `Unanswerable questions: refused ${refused}/${unanswerable.length}, made up an answer ${invented}/${unanswerable.length}`,
  );

  console.log("\n--- Unanswerable questions: read each answer yourself ---");
  for (const r of unanswerable) {
    const j = r.judgement?.kind === "unanswerable" ? r.judgement : null;
    const verdict = r.gated ? "refused at retrieval" : j ? `refused=${j.refused} invented=${j.invented}` : "not judged";
    console.log(`${r.id} ${r.question}\n   ${verdict}${j ? ` (${j.reason})` : ""}\n   answer: ${oneLine(r.answer, 350)}`);
  }

  const bad = answerable.filter(
    (r) => level(r, "correct") !== "yes" || level(r, "supported") !== "yes" || r.evidenceCited === false,
  );
  console.log(`\n--- Answerable questions to inspect (${bad.length}) ---`);
  for (const r of bad) {
    const j = r.judgement?.kind === "answerable" ? r.judgement : null;
    console.log(
      `${r.id} [${r.kind}] ${r.question}\n` +
        `   correct=${level(r, "correct")} supported=${level(r, "supported")} ` +
        `evidenceRetrieved=${r.evidenceRetrieved} evidenceCited=${r.evidenceCited} cited=[${r.cited.join(",")}]\n` +
        `   judge: ${j?.reason ?? "(none)"}\n   answer: ${oneLine(r.answer, 300)}`,
    );
  }
}

async function main() {
  const args = process.argv.slice(2);
  const flag = args.indexOf("--label");
  const label = flag >= 0 && args[flag + 1] ? args[flag + 1] : "answers";
  const fresh = args.includes("--fresh");

  mkdirSync("evals/results", { recursive: true });
  const file = `evals/results/answers-${label}.json`;

  let store: Store = { label, model: CHAT_MODEL, judgeModel: JUDGE_MODEL, runs: {} };
  if (!fresh && existsSync(file)) {
    store = JSON.parse(readFileSync(file, "utf8")) as Store;
    console.log(`Resuming from ${file} (${Object.keys(store.runs).length} cases already done)`);
  }
  const save = () => writeFileSync(file, JSON.stringify(store, null, 2));

  console.log(
    `Answer model: ${CHAT_MODEL}. Judge model: ${JUDGE_MODEL}. Prompt: ${PROMPT_VARIANT}. Sources: ${RETRIEVE_K}. ${cases.length} cases.\n`,
  );

  let incomplete = 0;
  for (const [i, c] of cases.entries()) {
    const progress = `[${i + 1}/${cases.length}] ${c.id}`;
    try {
      let run = store.runs[c.id];
      if (!run) {
        run = await withRetry(() => generate(c), 3);
        store.runs[c.id] = run;
        save();
      }
      if (!run.judgement && !run.gated) {
        run.judgement = await judgeRun(c, run);
        save();
      }
      console.log(`${progress} done`);
    } catch (err) {
      incomplete++;
      const message = err instanceof Error ? err.message.slice(0, 120) : String(err);
      console.log(`${progress} FAILED: ${message}`);
    }
    await sleep(500);
  }

  printSummary(store);
  if (incomplete > 0) {
    console.log(`\n${incomplete} case(s) did not finish. Run the same command again to resume.`);
  }
  console.log(`\nSaved ${file}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});