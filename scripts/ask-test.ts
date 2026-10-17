import "dotenv/config";
import { hybridSearch } from "../lib/search";
import { buildUserPrompt } from "../lib/prompt";
import { streamAnswer } from "../lib/llm";

async function main() {
  const question = process.argv.slice(2).join(" ");
  if (!question) {
    console.log('Usage: npx tsx scripts/ask-test.ts "your question"');
    return;
  }

  const sources = await hybridSearch(question, 6);
  if (sources.length === 0) {
    console.log("I couldn't find anything relevant to that in your documents.");
    process.exit(0);
  }

  for await (const piece of streamAnswer(buildUserPrompt(question, sources))) {
    process.stdout.write(piece);
  }

  console.log("\n\nSources:");
  sources.forEach((s, i) => console.log(`[${i + 1}] ${s.title}, p.${s.page} (chunk ${s.chunkIndex})`));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});