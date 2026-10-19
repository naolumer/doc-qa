import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { prisma } from "../../../lib/prisma";
import { extractPages, hasExtractableText } from "../../../lib/pdf";
import { chunkPages } from "../../../lib/chunk";
import { embedTexts } from "../../../lib/embed";
import { saveChunks } from "../../../lib/store";

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

export async function POST(request: Request) {

    if (process.env.DEMO_MODE === "true") {
    return NextResponse.json(
      { error: "Uploads are turned off in this public demo. Run the project locally to add your own documents." },
      { status: 403 },
    );
  }
  
  const formData = await request.formData();
  const file = formData.get("file");

  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: "No file uploaded. The form field must be named 'file'." },
      { status: 400 },
    );
  }
  if (file.type !== "application/pdf") {
    return NextResponse.json({ error: "Only PDF files are allowed." }, { status: 415 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "File is larger than 10 MB." }, { status: 413 });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const contentHash = createHash("sha256").update(bytes).digest("hex");
  console.log(`[upload] ${file.name} hash=${contentHash.slice(0, 12)}`);

  const existing = await prisma.document.findUnique({ where: { contentHash } });
  if (existing) {
    if (existing.status === "FAILED") {
      // Allow retrying a file whose earlier attempt failed.
      await prisma.document.delete({ where: { id: existing.id } });
    } else {
      return NextResponse.json(
        { id: existing.id, status: existing.status, error: "This file was already uploaded." },
        { status: 409 },
      );
    }
  }

  const document = await prisma.document.create({
    data: {
      title: file.name.replace(/\.pdf$/i, ""),
      fileName: file.name,
      contentHash,
      status: "PROCESSING",
    },
  });

  try {
    const pages = await extractPages(bytes);

    if (!hasExtractableText(pages)) {
      const error = "No extractable text. This looks like a scanned PDF (OCR is not supported yet).";
      await prisma.document.update({
        where: { id: document.id },
        data: { status: "FAILED", error, pageCount: pages.length },
      });
      return NextResponse.json({ id: document.id, status: "FAILED", error }, { status: 422 });
    }

    const chunks = chunkPages(pages);
    const vectors = await embedTexts(chunks.map((c) => c.text));
    await saveChunks(document.id, chunks, vectors);

    await prisma.document.update({
      where: { id: document.id },
      data: { status: "READY", pageCount: pages.length },
    });

    return NextResponse.json(
      { id: document.id, status: "READY", pages: pages.length, chunks: chunks.length },
      { status: 201 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    await prisma.document.update({
      where: { id: document.id },
      data: { status: "FAILED", error: message.slice(0, 500) },
    });
    return NextResponse.json({ id: document.id, status: "FAILED", error: message }, { status: 500 });
  }
}