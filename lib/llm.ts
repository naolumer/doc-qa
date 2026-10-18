import { GoogleGenAI } from "@google/genai";
import { SYSTEM_INSTRUCTION } from "./prompt";

export const CHAT_MODEL = process.env.GEMINI_CHAT_MODEL ?? "gemini-3.1-flash-lite";
const FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL ?? "gemini-2.5-flash-lite";

const MODELS = [CHAT_MODEL, FALLBACK_MODEL, CHAT_MODEL]; // up to 3 attempts
const FIRST_TOKEN_TIMEOUT_MS = 15_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function* streamAnswer(userPrompt: string): AsyncGenerator<string> {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  let lastError: unknown;

  for (let attempt = 0; attempt < MODELS.length; attempt++) {
    const model = MODELS[attempt];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FIRST_TOKEN_TIMEOUT_MS);
    let started = false;

    try {
      const stream = await ai.models.generateContentStream({
        model,
        contents: userPrompt,
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          temperature: 0.2,
          abortSignal: controller.signal,
        },
      });

      for await (const chunk of stream) {
        if (chunk.text) {
          if (!started) {
            started = true;
            clearTimeout(timer); // the timeout only guards the wait for the first token
          }
          yield chunk.text;
        }
      }
      return;
    } catch (err) {
      if (started) throw err; // part of the answer was already sent, so don't retry

      lastError = err;
      const status = (err as { status?: number }).status;
      const timedOut = controller.signal.aborted;
      const retryable = timedOut || status === 503 || status === 429;
      if (!retryable) throw err;

      console.error(`[llm] ${model} failed (${timedOut ? "timeout" : status}), attempt ${attempt + 1}/${MODELS.length}`);
      await sleep(500);
    } finally {
      clearTimeout(timer);
      controller.abort(); // harmless after success; cancels the request if the caller stopped early
    }
  }

  throw lastError;
}