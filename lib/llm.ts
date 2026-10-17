import { GoogleGenAI } from "@google/genai";
import { SYSTEM_INSTRUCTION } from "./prompt";

export const CHAT_MODEL = process.env.GEMINI_CHAT_MODEL ?? "gemini-3.8-flash";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function* streamAnswer(userPrompt: string, maxAttempts = 4): AsyncGenerator<string> {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  for (let attempt = 1; ; attempt++) {
    let started = false;
    try {
      const stream = await ai.models.generateContentStream({
        model: CHAT_MODEL,
        contents: userPrompt,
        config: { systemInstruction: SYSTEM_INSTRUCTION, temperature: 0.2 },
      });

      for await (const chunk of stream) {
        if (chunk.text) {
          started = true;
          yield chunk.text;
        }
      }
      return;
    } catch (err) {
      const status = (err as { status?: number }).status;
      const retryable = status === 503 || status === 429;
      if (started || !retryable || attempt >= maxAttempts) throw err;

      const delay = 1000 * 2 ** (attempt - 1) + Math.random() * 500; // about 1s, 2s, 4s
      console.error(`Model returned ${status}, retrying in ${Math.round(delay / 1000)}s (attempt ${attempt}/${maxAttempts})...`);
      await sleep(delay);
    }
  }
}