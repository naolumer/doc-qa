import { test } from "node:test";
import assert from "node:assert/strict";
import { extractCitations, splitCitations } from "./citations";

test("collects citations in order of first use", () => {
  assert.deepEqual(extractCitations("A [S2]. B [S1][S3].", 3), { cited: [2, 1, 3], invalid: [] });
});

test("handles comma lists and repeats", () => {
  assert.deepEqual(extractCitations("A [S1, S2]. B [S2].", 2), { cited: [1, 2], invalid: [] });
});

test("flags citations to sources that don't exist", () => {
  assert.deepEqual(extractCitations("A [S1]. B [S7]. C [S0].", 2), { cited: [1], invalid: [7, 0] });
});

test("ignores reference numbers copied from the documents", () => {
  assert.deepEqual(extractCitations("It uses Hashcash [6], see [S1].", 2), { cited: [1], invalid: [] });
});

test("returns nothing when there are no citations", () => {
  assert.deepEqual(extractCitations("I could not find that.", 5), { cited: [], invalid: [] });
});

test("splits text around citations", () => {
  const segments = splitCitations("Hi [S1] there");
  assert.equal(segments.length, 3);
  assert.deepEqual(segments[1], { type: "cite", raw: "[S1]", numbers: [1] });
});