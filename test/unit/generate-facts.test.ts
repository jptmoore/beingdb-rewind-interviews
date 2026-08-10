import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkText } from "../../src/generate-facts.js";

test("chunkText returns a single chunk for short text", () => {
  const chunks = chunkText("hello world", 100);
  assert.deepEqual(chunks, ["hello world"]);
});

test("chunkText splits on paragraph boundaries without exceeding maxChars", () => {
  const paragraphs = ["a".repeat(50), "b".repeat(50), "c".repeat(50)];
  const chunks = chunkText(paragraphs.join("\n\n"), 60);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 60, `chunk length ${chunk.length} exceeds 60`);
  }
  // no content lost
  assert.equal(chunks.join("\n\n").replace(/\n\n+/g, ""), paragraphs.join(""));
});

test("chunkText hard-splits a single paragraph longer than maxChars", () => {
  const longParagraph = "x".repeat(250);
  const chunks = chunkText(longParagraph, 100);
  assert.equal(chunks.length, 3);
  assert.equal(chunks.join(""), longParagraph);
});
