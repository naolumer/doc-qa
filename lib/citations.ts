export type CitationResult = { cited: number[]; invalid: number[] };

export type Segment =
  | { type: "text"; text: string }
  | { type: "cite"; raw: string; numbers: number[] };

// Matches [S1], [S1, S2], [s3]. A plain [6] copied from a document does not match.
const CITATION = /\[(S\d+(?:\s*[,;]\s*S?\d+)*)\]/gi;

const numbersIn = (inner: string) => (inner.match(/\d+/g) ?? []).map(Number);

export function extractCitations(text: string, sourceCount: number): CitationResult {
  const cited: number[] = [];
  const invalid: number[] = [];

  for (const match of text.matchAll(CITATION)) {
    for (const n of numbersIn(match[1])) {
      const list = n >= 1 && n <= sourceCount ? cited : invalid;
      if (!list.includes(n)) list.push(n);
    }
  }
  return { cited, invalid };
}

export function splitCitations(text: string): Segment[] {
  const segments: Segment[] = [];
  let last = 0;

  for (const match of text.matchAll(CITATION)) {
    const index = match.index ?? 0;
    if (index > last) segments.push({ type: "text", text: text.slice(last, index) });
    segments.push({ type: "cite", raw: match[0], numbers: numbersIn(match[1]) });
    last = index + match[0].length;
  }
  if (last < text.length) segments.push({ type: "text", text: text.slice(last) });
  return segments;
}