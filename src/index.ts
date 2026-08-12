#!/usr/bin/env node
/**
 * CLI entrypoint: extracts BeingDB facts for one or all configured
 * interviews. Without --artist, already-extracted interviews (those with an
 * entry in metadata/extraction.json) are skipped, so adding one new
 * interview to config/interviews.json and running this again does not
 * re-run the AI over every previously extracted interview.
 *
 *   npm run extract                       -- only interviews not yet extracted
 *   npm run extract -- --artist kevin_atherton   -- (re)process one interview
 *   npm run extract -- --force            -- re-run the AI on every configured interview
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
import { loadExtractionMetadata, upsertExtractionMetadata, writeEvidenceSidecar } from "./metadata.js";
import { establishedKinds, reconcileArgumentKinds } from "./type-consistency.js";
import { loadDotEnv } from "./env.js";
import { PIPELINE_VERSION } from "./version.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CONFIG_DIR = path.join(ROOT, "config");
const SOURCE_DIR = path.join(ROOT, "source");
const PREDICATES_DIR = path.join(ROOT, "predicates");
const METADATA_DIR = path.join(ROOT, "metadata");
const METADATA_FILE = path.join(METADATA_DIR, "extraction.json");
const EVIDENCE_DIR = path.join(METADATA_DIR, "evidence");

function parseArgs(argv: string[]): { artist: string | null; force: boolean } {
  let artist: string | null = null;
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--artist") {
      artist = argv[i + 1] ?? null;
      i++;
    } else if (arg?.startsWith("--artist=")) {
      artist = arg.slice("--artist=".length);
    } else if (arg === "--force") {
      force = true;
    }
  }
  return { artist, force };
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

  // Coerce any string argument that conflicts with an already-established
  // atom-typed position for the same predicate (on disk, or earlier in this
  // same batch), so predicates/*.pl doesn't end up with a silently mixed
  // type at that position (see BeingDB compile's own "mixed types" note).
  const establishedByPredicate = new Map<string, Map<number, Set<FactArgument["kind"]>>>();
  const typeWarnings: string[] = [];
  const reconciled = deduped.map((fact) => {
    let established = establishedByPredicate.get(fact.predicate);
    if (!established) {
      established = establishedKinds(PREDICATES_DIR, fact.predicate);
      establishedByPredicate.set(fact.predicate, established);
    }
    const { arguments: coercedArgs, warnings } = reconcileArgumentKinds(
      fact.predicate,
      fact.arguments,
      established,
      (label) => resolver.resolve(label),
    );
    typeWarnings.push(...warnings);
    coercedArgs.forEach((arg, position) => {
      const kinds = established!.get(position) ?? new Set();
      kinds.add(arg.kind);
      established!.set(position, kinds);
    });
    return { ...fact, arguments: coercedArgs };
  });
  const finalFacts = dedupeFacts(reconciled); // coercion can turn two previously-distinct facts into duplicates

  const warnings = [
    ...resolver.warnings,
    ...shapeWarnings,
    ...typeWarnings,
    ...dropped.map((d) => `dropped ${factToProposition(d.fact.predicate, d.fact.arguments)}: ${d.reason}`),
  ];

  const allFacts = [...provenanceFacts(interview, documentId, personId), ...finalFacts];
  const mergeResults = writeFactsToPredicates(PREDICATES_DIR, allFacts);

  const evidenceEntries: EvidenceEntry[] = finalFacts.map((f) => ({
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
    factCount: finalFacts.length,
    droppedFactCount: dropped.length + shapeWarnings.length,
    warnings,
  };
  upsertExtractionMetadata(METADATA_FILE, metadataEntry);

  console.log(`kept ${finalFacts.length} facts (${dropped.length + shapeWarnings.length} dropped)`);
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
  const { artist, force } = parseArgs(process.argv.slice(2));

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
  const candidates = artist ? interviews.filter((i) => i.id === artist) : interviews;
  if (artist && candidates.length === 0) {
    console.error(`extract: no interview configured with id "${artist}" in config/interviews.json`);
    process.exitCode = 1;
    return;
  }

  // In batch mode (no --artist), never silently re-run the AI on interviews
  // that were already extracted - only new ones. An explicit --artist or
  // --force always (re)processes what was asked for.
  const metadata = loadExtractionMetadata(METADATA_FILE);
  const alreadyExtracted = (id: string) => id in metadata.entries;
  const selected = artist || force ? candidates : candidates.filter((i) => !alreadyExtracted(i.id));
  const skipped = artist || force ? [] : candidates.filter((i) => alreadyExtracted(i.id));

  if (skipped.length > 0) {
    console.log(`Skipping ${skipped.length} already-extracted interview(s) (use --force to regenerate):`);
    for (const s of skipped) console.log(`  - ${s.id}`);
  }
  if (selected.length === 0) {
    console.log(
      "Nothing to extract: every configured interview already has a metadata/extraction.json entry. " +
        "Use --force to regenerate everything, or --artist <id> to regenerate one.",
    );
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
