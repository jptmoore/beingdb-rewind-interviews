#!/usr/bin/env node
/**
 * CLI entrypoint: extracts BeingDB facts for one or all configured
 * interviews.
 *
 *   npm run extract                       -- all configured interviews
 *   npm run extract -- --artist kevin_atherton   -- a single interview
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";

import type {
  EvidenceEntry,
  ExtractionMetadataEntry,
  FactArgument,
  InterviewConfig,
  RawFact,
  ResolvedFact,
} from "./types.js";
import { fetchSource } from "./fetch-source.js";
import { extractPdfText } from "./extract-text.js";
import { extractFacts } from "./generate-facts.js";
import { AliasMap, EntityResolver, normalizeId } from "./normalize.js";
import { dedupeFacts, filterConservative, validateFactShape } from "./validate.js";
import { factToProposition, writeFactsToPredicates } from "./serialize.js";
import { upsertExtractionMetadata, writeEvidenceSidecar } from "./metadata.js";

const PIPELINE_VERSION = "1";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CONFIG_DIR = path.join(ROOT, "config");
const SOURCE_DIR = path.join(ROOT, "source");
const PREDICATES_DIR = path.join(ROOT, "predicates");
const METADATA_DIR = path.join(ROOT, "metadata");
const METADATA_FILE = path.join(METADATA_DIR, "extraction.json");
const EVIDENCE_DIR = path.join(METADATA_DIR, "evidence");

/**
 * Minimal .env loader (no extra dependency): sets process.env.KEY=VALUE for
 * each uncommented `KEY=VALUE` line, without overriding variables already
 * set in the real environment.
 */
function loadDotEnv(envPath: string): void {
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function parseArgs(argv: string[]): { artist: string | null } {
  let artist: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--artist") {
      artist = argv[i + 1] ?? null;
      i++;
    } else if (arg?.startsWith("--artist=")) {
      artist = arg.slice("--artist=".length);
    }
  }
  return { artist };
}

function loadInterviews(): InterviewConfig[] {
  const raw = fs.readFileSync(path.join(CONFIG_DIR, "interviews.json"), "utf8");
  return JSON.parse(raw) as InterviewConfig[];
}

function loadAliasMap(): AliasMap {
  const raw = fs.readFileSync(path.join(CONFIG_DIR, "entity-aliases.json"), "utf8");
  return new AliasMap(JSON.parse(raw) as Record<string, string>);
}

/** Curated, unconditionally-true provenance facts derived from config - never inferred by the model. */
function provenanceFacts(interview: InterviewConfig, documentId: string, personId: string): ResolvedFact[] {
  const atom = (value: string): FactArgument => ({ kind: "atom", value });
  const str = (value: string): FactArgument => ({ kind: "string", value });
  const base = { evidence: "curated interview configuration", confidence: "explicit" as const, page: null, sourceId: interview.id };
  return [
    { predicate: "document", arguments: [atom(documentId)], ...base },
    { predicate: "source_url", arguments: [atom(documentId), str(interview.url)], ...base },
    { predicate: "interviewee", arguments: [atom(documentId), atom(personId)], ...base },
    { predicate: "person", arguments: [atom(personId)], ...base },
  ];
}

async function processInterview(interview: InterviewConfig, aliases: AliasMap, client: OpenAI, model: string) {
  console.log(`\n=== ${interview.name} (${interview.id}) ===`);

  const documentId = interview.documentId ?? `${interview.id}_interview`;
  const personId = interview.personId ?? normalizeId(interview.name);

  console.log(`fetching ${interview.url}`);
  const source = await fetchSource(interview.url, interview.id, SOURCE_DIR);

  console.log(`extracting text from ${source.cachePath}`);
  const extracted = await extractPdfText(source.bytes, interview.id, SOURCE_DIR);
  console.log(`extracted ${extracted.text.length} characters, ${extracted.pageCount} pages`);

  const chunkResults = await extractFacts({
    client,
    model,
    interviewName: interview.name,
    fullText: extracted.text,
    onProgress: (progress) => {
      if (progress.phase === "start") {
        console.log(`  chunk ${progress.chunkIndex + 1}/${progress.chunkCount}: calling ${model}...`);
      } else {
        const seconds = ((progress.elapsedMs ?? 0) / 1000).toFixed(1);
        console.log(
          `  chunk ${progress.chunkIndex + 1}/${progress.chunkCount}: done in ${seconds}s (${progress.factCount} facts)`,
        );
      }
    },
  });
  console.log(`model returned ${chunkResults.length} chunk result(s)`);

  const resolver = new EntityResolver({ aliases, overrides: interview.idOverrides });
  const resolved: ResolvedFact[] = [];
  const shapeWarnings: string[] = [];

  for (const chunkResult of chunkResults) {
    const finalIdByRawId = new Map<string, string>();
    for (const entity of chunkResult.entities) {
      finalIdByRawId.set(entity.id, resolver.resolve(entity.label));
    }

    const resolveAtomValue = (rawValue: string): string => {
      const viaEntityId = finalIdByRawId.get(rawValue);
      if (viaEntityId) return viaEntityId;
      // Fall back to treating the raw value itself as a label (the model
      // sometimes reuses a bare name without registering it as an entity).
      return resolver.resolve(rawValue);
    };

    for (const rawFact of chunkResult.facts) {
      const mappedArguments: FactArgument[] = rawFact.arguments.map((arg) =>
        arg.kind === "atom" ? { kind: "atom", value: resolveAtomValue(arg.value) } : arg,
      );
      const mappedFact: RawFact = { ...rawFact, arguments: mappedArguments };

      const shapeError = validateFactShape(mappedFact);
      if (shapeError) {
        shapeWarnings.push(`dropped malformed fact ${JSON.stringify(rawFact)}: ${shapeError}`);
        continue;
      }
      resolved.push({ ...mappedFact, sourceId: interview.id });
    }
  }

  const { kept, dropped } = filterConservative(resolved);
  const deduped = dedupeFacts(kept);
  const warnings = [
    ...resolver.warnings,
    ...shapeWarnings,
    ...dropped.map((d) => `dropped ${factToProposition(d.fact.predicate, d.fact.arguments)}: ${d.reason}`),
  ];

  const allFacts = [...provenanceFacts(interview, documentId, personId), ...deduped];
  const mergeResults = writeFactsToPredicates(PREDICATES_DIR, allFacts);

  const evidenceEntries: EvidenceEntry[] = deduped.map((f) => ({
    fact: factToProposition(f.predicate, f.arguments),
    source: interview.id,
    evidence: f.evidence,
    confidence: f.confidence,
    page: f.page,
  }));
  const evidencePath = writeEvidenceSidecar(EVIDENCE_DIR, interview.id, evidenceEntries);

  const metadataEntry: ExtractionMetadataEntry = {
    id: interview.id,
    documentId,
    sourceUrl: interview.url,
    sourceChecksum: extracted.checksum,
    extractedAt: new Date().toISOString(),
    model,
    pipelineVersion: PIPELINE_VERSION,
    chunkCount: chunkResults.length,
    factCount: deduped.length,
    droppedFactCount: dropped.length + shapeWarnings.length,
    warnings,
  };
  upsertExtractionMetadata(METADATA_FILE, metadataEntry);

  console.log(`kept ${deduped.length} facts (${dropped.length + shapeWarnings.length} dropped)`);
  for (const result of mergeResults) {
    console.log(`  ${path.relative(ROOT, result.file)}: +${result.addedCount} (total ${result.totalCount})`);
  }
  if (warnings.length > 0) {
    console.log(`  warnings:`);
    for (const w of warnings) console.log(`    - ${w}`);
  }
  console.log(`  evidence: ${path.relative(ROOT, evidencePath)}`);
}

async function main() {
  loadDotEnv(path.join(ROOT, ".env"));
  const { artist } = parseArgs(process.argv.slice(2));

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("extract: OPENAI_API_KEY is not set. Copy .env.example to .env and fill it in.");
    process.exitCode = 1;
    return;
  }
  const model = process.env.OPENAI_MODEL;
  if (!model) {
    console.error("extract: OPENAI_MODEL is not set. Copy .env.example to .env and fill it in.");
    process.exitCode = 1;
    return;
  }

  const interviews = loadInterviews();
  const selected = artist ? interviews.filter((i) => i.id === artist) : interviews;
  if (artist && selected.length === 0) {
    console.error(`extract: no interview configured with id "${artist}" in config/interviews.json`);
    process.exitCode = 1;
    return;
  }

  const aliases = loadAliasMap();
  const client = new OpenAI({ apiKey });

  for (const interview of selected) {
    await processInterview(interview, aliases, client, model);
  }
}

// Only run when invoked directly (not when imported by tests).
if (path.resolve(process.argv[1] ?? "") === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
