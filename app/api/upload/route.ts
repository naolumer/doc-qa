import { NextResponse } from "next/server";
import { prisma } from "../../../lib/prisma";

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

export async function POST(request: Request) {
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

  const document = await prisma.document.create({
    data: {
      title: file.name.replace(/\.pdf$/i, ""),
      fileName: file.name,
    },
  });

  return NextResponse.json({ id: document.id, status: document.status }, { status: 201 });
}