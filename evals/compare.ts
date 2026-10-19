import { readFileSync } from "node:fs";
import { cases } from "./dataset";
import { holdout } from "./holdout";

type Run = {
  gated: boolean;
  judgement:
    | { kind: "answerable"; correct: string; supported: string }
    | { kind: "unanswerable"; refused: boolean; invented: boolean }
    | null;
};

const load = (label: string): Record<string, Run> =>
  JSON.parse(readFileSync(`evals/results/answers-${label}.json`, "utf8")).runs;

function passed(kind: string, r: Run): boolean | null {
  if (kind === "unanswerable") {
    if (r.gated) return true;
    return r.judgement?.kind === "unanswerable" ? r.judgement.refused && !r.judgement.invented : null;
  }
  if (r.gated) return false;
  return r.judgement?.kind === "answerable"
    ? r.judgement.correct === "yes" && r.judgement.supported === "yes"
    : null;
}

const [labelA, labelB] = process.argv.slice(2);
if (!labelA || !labelB) {
  console.log("Usage: npx tsx evals/compare.ts <labelA> <labelB>");
  process.exit(1);
}

const A = load(labelA);
const B = load(labelB);

type Row = { c: (typeof cases)[number]; a: boolean; b: boolean };
const rows: Row[] = [];
for (const c of [...cases, ...holdout]) {
  if (!A[c.id] || !B[c.id]) continue;
  const a = passed(c.kind, A[c.id]);
  const b = passed(c.kind, B[c.id]);
  if (a !== null && b !== null) rows.push({ c, a, b });
}

const split = (answerable: boolean) => rows.filter((x) => (x.c.kind !== "unanswerable") === answerable);
const count = (list: Row[], pick: "a" | "b") => list.filter((x) => x[pick]).length;

console.log(`Compared ${rows.length} cases judged in both runs.\n`);
console.table(
  [labelA, labelB].map((label, i) => {
    const pick = i === 0 ? "a" : "b";
    return {
      run: label,
      "answerable passed": `${count(split(true), pick)}/${split(true).length}`,
      "unanswerable passed": `${count(split(false), pick)}/${split(false).length}`,
      "all passed": `${count(rows, pick)}/${rows.length}`,
    };
  }),
);

const flips = rows.filter((x) => x.a !== x.b);
console.log(`${flips.length} case(s) changed result:`);
flips.forEach((x) =>
  console.log(`  ${x.c.id} [${x.c.kind}] ${x.a ? "pass -> FAIL" : "fail -> PASS"}   ${x.c.question}`),
);