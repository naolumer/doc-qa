import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkPages } from "./chunk";

const longText = Array.from({ length: 1000 }, (_, i) => `word${i}`).join(" ");

test("returns no chunks for empty pages", () => {
  assert.deepEqual(chunkPages([{ page: 1, text: "" }, { page: 2, text: "   " }]), []);
});

test("short page becomes one chunk with its page number", () => {
  const chunks = chunkPages([{ page: 3, text: "Hello world." }]);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].page, 3);
  assert.equal(chunks[0].text, "Hello world.");
});

test("long page is split into multiple chunks no longer than size", () => {
  const chunks = chunkPages([{ page: 1, text: longText }], 2000, 300);
  assert.ok(chunks.length > 2);
  for (const c of chunks) assert.ok(c.text.length <= 2000);
});

test("chunk indexes are sequential across pages and pages are not mixed", () => {
  const chunks = chunkPages([
    { page: 1, text: longText },
    { page: 2, text: "Second page text." },
  ]);
  chunks.forEach((c, i) => assert.equal(c.chunkIndex, i));
  assert.equal(chunks[chunks.length - 1].page, 2);
  assert.equal(chunks[chunks.length - 1].text, "Second page text.");
});

test("consecutive chunks overlap", () => {
  const chunks = chunkPages([{ page: 1, text: longText }], 2000, 300);
  assert.ok(chunks[0].text.includes(chunks[1].text.slice(0, 40)));
});

test("throws when overlap is too large", () => {
  assert.throws(() => chunkPages([{ page: 1, text: "x" }], 1000, 900));
});