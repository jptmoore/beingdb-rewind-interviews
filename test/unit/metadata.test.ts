import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { loadExtractionMetadata, upsertExtractionMetadata, writeEvidenceSidecar } from "../../src/metadata.js";
import type { ExtractionMetadataEntry } from "../../src/types.js";

function withTempDir(fn: (dir: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "beingdb-metadata-test-"));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function sampleEntry(overrides: Partial<ExtractionMetadataEntry> = {}): ExtractionMetadataEntry {
  return {
    id: "kevin_atherton",
    documentId: "rewind_kevin_atherton_interview",
    sourceUrl: "https://rewind.ac.uk/example.pdf",
    sourceChecksum: "abc123",
    extractedAt: "2026-01-01T00:00:00.000Z",
    model: "gpt-4.1",
    pipelineVersion: "1",
    chunkCount: 3,
    factCount: 10,
    droppedFactCount: 2,
    warnings: [],
    ...overrides,
  };
}

test("loadExtractionMetadata returns an empty shape when the file doesn't exist", () => {
  withTempDir((dir) => {
    const result = loadExtractionMetadata(path.join(dir, "extraction.json"));
    assert.deepEqual(result, { entries: {} });
  });
});

test("upsertExtractionMetadata records source url, checksum, model, timestamp, and pipeline version", () => {
  withTempDir((dir) => {
    const filePath = path.join(dir, "extraction.json");
    upsertExtractionMetadata(filePath, sampleEntry());
    const loaded = loadExtractionMetadata(filePath);
    const entry = loaded.entries["kevin_atherton"];
    assert.ok(entry);
    assert.equal(entry.sourceUrl, "https://rewind.ac.uk/example.pdf");
    assert.equal(entry.sourceChecksum, "abc123");
    assert.equal(entry.model, "gpt-4.1");
    assert.equal(entry.pipelineVersion, "1");
    assert.equal(entry.extractedAt, "2026-01-01T00:00:00.000Z");
  });
});

test("upsertExtractionMetadata updates one entry without disturbing others", () => {
  withTempDir((dir) => {
    const filePath = path.join(dir, "extraction.json");
    upsertExtractionMetadata(filePath, sampleEntry({ id: "artist_a" }));
    upsertExtractionMetadata(filePath, sampleEntry({ id: "artist_b" }));
    upsertExtractionMetadata(filePath, sampleEntry({ id: "artist_a", factCount: 99 }));

    const loaded = loadExtractionMetadata(filePath);
    assert.equal(Object.keys(loaded.entries).length, 2);
    assert.equal(loaded.entries["artist_a"]?.factCount, 99);
    assert.equal(loaded.entries["artist_b"]?.factCount, 10);
  });
});

test("writeEvidenceSidecar writes one JSON array per interview with fact/evidence pairs", () => {
  withTempDir((dir) => {
    const file = writeEvidenceSidecar(dir, "kevin_atherton", [
      { fact: "year_created(tape_tape, @1975).", source: "kevin_atherton", evidence: "I made Tape Tape in 1975", confidence: "explicit", page: 6 },
    ]);
    const contents = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(contents.length, 1);
    assert.equal(contents[0].fact, "year_created(tape_tape, @1975).");
    assert.equal(contents[0].page, 6);
  });
});
