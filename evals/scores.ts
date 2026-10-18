import { readdirSync, readFileSync } from "node:fs";

type Row = { id: string; kind: string; question: string; topScore: number | null };

const dir = "evals/results";
const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
const file = files[files.length - 1];
const data = JSON.parse(readFileSync(`${dir}/${file}`, "utf8")) as { rows: Row[] };

console.log(`Top vector score per question (${file})\n`);
data.rows
  .filter((r) => r.topScore !== null)
  .sort((a, b) => (a.topScore as number) - (b.topScore as number))
  .forEach((r) => {
    const tag = r.kind === "unanswerable" ? "UNANSWERABLE" : "answerable  ";
    console.log(`${(r.topScore as number).toFixed(3)}  ${tag}  ${r.id}  ${r.question}`);
  });