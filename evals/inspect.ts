import { readFileSync } from "node:fs";
import { cases } from "./dataset";
import { holdout } from "./holdout";

const norm = (s: string) => s.normalize("NFKD").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

const [id, label = "baseline"] = process.argv.slice(2);
const c = [...cases, ...holdout].find((x) => x.id === id);
if (!c) {
  console.log(`Unknown case id. Try one of: ${[...cases, ...holdout].map((x) => x.id).join(", ")}`);
  process.exit(1);
}

const store = JSON.parse(readFileSync(`evals/results/answers-${label}.json`, "utf8"));
const run = store.runs[id];
if (!run) {
  console.log("That case has not been run yet.");
  process.exit(1);
}

const needles = c.evidence.map(norm);
console.log(`QUESTION: ${c.question}`);
console.log(`EXPECTED: ${c.expected || "(not in the documents)"}`);
console.log(`\nANSWER:\n${run.answer}`);
console.log(`\nCITED: [${run.cited.join(", ")}]   INVALID: [${run.invalid.join(", ")}]`);
console.log(`JUDGE: ${JSON.stringify(run.judgement)}`);
console.log("\nSOURCES (full text only for sources with the evidence or cited by the answer):");

for (const s of run.sources) {
  const hasEvidence = needles.some((n) => norm(s.text).includes(n));
  const cited = run.cited.includes(s.n);
  const tags = `${hasEvidence ? "[evidence]" : ""}${cited ? "[cited]" : ""}`;
  console.log(`\n[S${s.n}] ${tags} ${s.title}, page ${s.page}`);
  console.log(hasEvidence || cited ? s.text : s.text.slice(0, 150) + "...");
}