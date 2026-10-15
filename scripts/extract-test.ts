import { readFileSync } from "node:fs";
import { PDFParse } from "pdf-parse";

async function main() {
  const path = process.argv[2];
  const data = readFileSync(path);

  const parser = new PDFParse({ data });
  const result = await parser.getText();

  console.log("keys:", Object.keys(result));
  console.log(JSON.stringify(result, null, 2).slice(0, 1200));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});