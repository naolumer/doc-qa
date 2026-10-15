import { PDFParse } from "pdf-parse";

export type PageText = { page: number; text: string };

export async function extractPages(data: Uint8Array): Promise<PageText[]> {
  const parser = new PDFParse({ data });
  const result = await parser.getText();
  return result.pages.map((p) => ({ page: p.num, text: p.text.trim() }));
}

export function hasExtractableText(pages: PageText[]): boolean {
  return pages.some((p) => p.text.length > 0);
}