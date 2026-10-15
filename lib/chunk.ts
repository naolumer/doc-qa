import type { PageText } from "./pdf";

export type Chunk = { page: number; chunkIndex: number; text: string };

// ~2000 characters is roughly 500 tokens of English text.
export function chunkPages(pages: PageText[], size = 2000, overlap = 300): Chunk[] {
  if (overlap >= size * 0.7) throw new Error("overlap must be smaller than 70% of size");

  const chunks: Chunk[] = [];
  let chunkIndex = 0;

  for (const { page, text } of pages) {
    const clean = text.replace(/\s+/g, " ").trim();
    if (!clean) continue;

    let start = 0;
    while (start < clean.length) {
      let end = Math.min(start + size, clean.length);

      if (end < clean.length) {
        // Prefer ending at a sentence boundary, else at a space, within the last 30% of the window.
        const windowStart = start + Math.floor(size * 0.7);
        const slice = clean.slice(windowStart, end);
        const sentenceEnd = Math.max(
          slice.lastIndexOf(". "),
          slice.lastIndexOf("? "),
          slice.lastIndexOf("! "),
        );
        if (sentenceEnd !== -1) {
          end = windowStart + sentenceEnd + 1;
        } else {
          const space = slice.lastIndexOf(" ");
          if (space !== -1) end = windowStart + space;
        }
      }

      const piece = clean.slice(start, end).trim();
      if (piece) chunks.push({ page, chunkIndex: chunkIndex++, text: piece });

      if (end >= clean.length) break;

      start = Math.max(end - overlap, start + 1);
      // Avoid starting a chunk in the middle of a word.
      const nextSpace = clean.indexOf(" ", start);
      if (nextSpace !== -1 && nextSpace - start < 50) start = nextSpace + 1;
    }
  }

  return chunks;
}