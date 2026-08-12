import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ConsolidationLogFile,
  ConsolidationRun,
  EvidenceEntry,
  ExtractionMetadataEntry,
  ExtractionMetadataFile,
} from "./types.js";

/** Reads metadata/extraction.json, returning an empty file shape if it doesn't exist yet. */
export function loadExtractionMetadata(filePath: string): ExtractionMetadataFile {
  if (!fs.existsSync(filePath)) return { entries: {} };
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw) as ExtractionMetadataFile;
}

/** Writes metadata/extraction.json with one entry updated, keys sorted for a stable diff. */
export function upsertExtractionMetadata(filePath: string, entry: ExtractionMetadataEntry): void {
  const file = loadExtractionMetadata(filePath);
  file.entries[entry.id] = entry;

  const sortedEntries: Record<string, ExtractionMetadataEntry> = {};
  for (const key of Object.keys(file.entries).sort()) {
    sortedEntries[key] = file.entries[key]!;
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ entries: sortedEntries }, null, 2) + "\n", "utf8");
}

/** Writes the per-interview evidence sidecar (never read by BeingDB itself - purely for human/LLM traceability). */
export function writeEvidenceSidecar(evidenceDir: string, id: string, entries: EvidenceEntry[]): string {
  fs.mkdirSync(evidenceDir, { recursive: true });
  const filePath = path.join(evidenceDir, `${id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(entries, null, 2) + "\n", "utf8");
  return filePath;
}

/** Reads metadata/consolidation.json, returning an empty log if it doesn't exist yet. */
export function loadConsolidationLog(filePath: string): ConsolidationLogFile {
  if (!fs.existsSync(filePath)) return { runs: [] };
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as ConsolidationLogFile;
}

/**
 * Appends one `npm run consolidate` run to metadata/consolidation.json - a
 * human-readable record of what was merged and why. The actual ability to
 * restore a removed predicates/<name>.pl file comes from Git history
 * (`git log -- predicates/<name>.pl`, `git show <commit>^:predicates/<name>.pl`),
 * not from this log; this just explains the reasoning behind a given diff.
 */
export function appendConsolidationLog(filePath: string, run: ConsolidationRun): void {
  const log = loadConsolidationLog(filePath);
  log.runs.push(run);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(log, null, 2) + "\n", "utf8");
}
