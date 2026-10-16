import "dotenv/config";
import { hybridSearch } from "../lib/search";

async function main() {
  const query = process.argv.slice(2).join(" ");
  if (!query) {
    console.log('Usage: npx tsx scripts/hybrid-test.ts "your question"');
    return;
  }

  const results = await hybridSearch(query, 6);
  console.log(`QUERY: ${query}`);
  if (results.length === 0) {
    console.log("No relevant results found in your documents.");
  }
  results.forEach((r, i) => {
    const v = r.vectorRank ? `vec#${r.vectorRank}` : "vec -";
    const k = r.keywordRank ? `kw#${r.keywordRank}` : "kw -";
    console.log(
      `#${i + 1}  rrf=${r.score.toFixed(4)}  ${v}  ${k}  ${r.title}  p.${r.page}  [chunk ${r.chunkIndex}]`,
    );
    console.log("    " + r.text.slice(0, 140).replace(/\s+/g, " ") + "...");
  });
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});