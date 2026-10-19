import "dotenv/config";
import { GoogleGenAI } from "@google/genai";

async function main() {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const pager = await ai.models.list();

  let total = 0;
  for await (const m of pager) {
    total++;
    const actions = (m as { supportedActions?: string[] }).supportedActions;
    console.log(`${m.name}${actions ? `   [${actions.join(", ")}]` : ""}`);
  }
  console.log(`\n${total} models listed.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});