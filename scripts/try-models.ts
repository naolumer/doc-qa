import "dotenv/config";
import { GoogleGenAI } from "@google/genai";

const candidates = [
  "gemini-3.1-flash-lite", // your current main model, for comparison
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite-preview",
  "gemini-3.5-flash",
  "gemini-3.6-flash",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite", // returned a 404 earlier; this shows the reason
];

async function main() {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  for (const model of candidates) {
    const t0 = Date.now();
    try {
      const res = await ai.models.generateContent({
        model,
        contents: "Reply with the single word: OK",
      });
      console.log(`OK    ${model}   ${Date.now() - t0}ms   ${(res.text ?? "").trim().slice(0, 20)}`);
    } catch (err) {
      const e = err as { status?: number; message?: string };
      const message = (e.message ?? "").replace(/\\n|\s+/g, " ");
      console.log(`FAIL  ${model}   status=${e.status}   ${message.slice(0, 300)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
}

main();