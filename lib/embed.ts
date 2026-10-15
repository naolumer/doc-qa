import { GoogleGenAI } from "@google/genai";

export const EMBEDDING_DIMENSIONS = 1536; // must match vector(1536) in the schema

type TaskType = "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY";

export async function embedTexts(
  texts: string[],
  taskType: TaskType = "RETRIEVAL_DOCUMENT",
): Promise<number[][]> {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const BATCH_SIZE = 20;
  const vectors: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const res = await ai.models.embedContent({
      model: "gemini-embedding-001",
      contents: batch,
      config: { taskType, outputDimensionality: EMBEDDING_DIMENSIONS },
    });

    const batchVectors = (res.embeddings ?? []).map((e) => e.values ?? []);
    if (batchVectors.length !== batch.length) {
      throw new Error(`Expected ${batch.length} embeddings, got ${batchVectors.length}`);
    }
    vectors.push(...batchVectors);
  }

  return vectors;
}