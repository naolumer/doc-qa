import { readFileSync } from "node:fs";
import { extractPages, hasExtractableText } from "../lib/pdf";
import { chunkPages } from "../lib/chunk";

async function main() {
  const pages = await extractPages(readFileSync(process.argv[2]));
  if (!hasExtractableText(pages)) {
    console.log("No extractable text (probably a scanned PDF).");
    return;
  }
  const chunks = chunkPages(pages);
  console.log(`${pages.length} pages -> ${chunks.length} chunks`);
  console.log("--- chunk 0 ---\n" + chunks[0].text);
  console.log("--- chunk 1 (page " + chunks[1].page + ") ---\n" + chunks[1].text.slice(0, 300));
}

main();