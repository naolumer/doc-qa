import "dotenv/config";
import { vectorSearch, keywordSearch, type SearchResult } from "../lib/search";

function show(label: string, results: SearchResult[]) {
  console.log(`\n=== ${label} ===`);
  if (results.length === 0) console.log("(no results)");
  results.forEach((r, i) => {
    console.log(`#${i + 1}  score=${Number(r.score).toFixed(3)}  ${r.title}  p.${r.page}  [chunk ${r.chunkIndex}]`);
    console.log("    " + r.text.slice(0, 160).replace(/\s+/g, " ") + "...");
  });
}

async function main() {
  const query = process.argv.slice(2).join(" ");
  if (!query) {
    console.log('Usage: npx tsx scripts/search-test.ts "your question"');
    return;
  }
  console.log(`QUERY: ${query}`);
  show("VECTOR", await vectorSearch(query, 5));
  show("KEYWORD", await keywordSearch(query, 5));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});