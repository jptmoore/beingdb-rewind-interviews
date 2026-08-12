/** Shared types for the extraction pipeline. */

/** One curated interview source, as configured by a human in config/interviews.json. */
export interface InterviewConfig {
  /** Short, stable identifier for this interview/artist (used for filenames, cache keys). */
  id: string;
  /** Display name of the interviewee, used as a hint for the model and for logging. */
  name: string;
  /** URL of the source document (currently PDF only). */
  url: string;
  /** Atom ID for the generated document() entity. Defaults to `${id}_interview` if omitted. */
  documentId?: string;
  /** Atom ID for the interviewee's person() entity. Defaults to normalize(name) if omitted. */
  personId?: string;
  /** Explicit ID overrides for specific entity labels, scoped to this interview only. */
  idOverrides?: Record<string, string>;
}

/** Supported typed literal kinds, mirroring BeingDB's literal syntax (see docs/query-language.md). */
export type FactArgument =
  | { kind: "atom"; value: string }
  | { kind: "string"; value: string }
  | { kind: "year"; value: number }
  | { kind: "integer"; value: number }
  | { kind: "decimal"; value: string }
  | { kind: "boolean"; value: boolean };

/** How confidently the model believes a fact is an explicit, stated assertion. */
export type FactConfidence = "explicit" | "supported" | "uncertain";

/** One candidate entity mentioned in the source text, as proposed by the model. */
export interface RawEntity {
  /** Model-suggested identifier or slug; re-normalized before use, never trusted verbatim. */
  id: string;
  /** Human-readable label as it appears (or is named) in the source. */
  label: string;
  /** Coarse entity category, used only for bookkeeping - not a fixed ontology. */
  type: string;
}

/** One candidate fact proposed by the model for a single chunk of source text. */
export interface RawFact {
  predicate: string;
  arguments: FactArgument[];
  /** Short verbatim (or near-verbatim) quote from the source text supporting this fact. */
  evidence: string;
  confidence: FactConfidence;
  /** Page number in the source document, if determinable. */
  page: number | null;
}

/** Structured output returned by the model for one chunk of source text. */
export interface ExtractionResult {
  entities: RawEntity[];
  facts: RawFact[];
}

/** A fully resolved, validated fact ready for serialization into a .pl predicate file. */
export interface ResolvedFact {
  predicate: string;
  arguments: FactArgument[];
  evidence: string;
  confidence: FactConfidence;
  page: number | null;
  /** Interview this fact was extracted from, for evidence provenance. */
  sourceId: string;
}

/** Per-interview extraction provenance, recorded outside the .pl fact syntax. */
export interface ExtractionMetadataEntry {
  id: string;
  documentId: string;
  sourceUrl: string;
  /** SHA-256 of the extracted plain text (not the raw PDF bytes). */
  sourceChecksum: string;
  extractedAt: string;
  model: string;
  pipelineVersion: string;
  chunkCount: number;
  factCount: number;
  droppedFactCount: number;
  warnings: string[];
}

export interface ExtractionMetadataFile {
  entries: Record<string, ExtractionMetadataEntry>;
}

/** Per-fact evidence sidecar, written alongside metadata for traceability. Never read by BeingDB. */
export interface EvidenceEntry {
  fact: string;
  source: string;
  evidence: string;
  confidence: FactConfidence;
  page: number | null;
}

/** One predicate's shape as it currently exists in predicates/, used to ask the model about semantic duplicates. */
export interface PredicateCatalogEntry {
  name: string;
  arity: number;
  /** Per-position kinds observed (e.g. ["atom"], ["atom", "string"]). */
  argumentKinds: string[][];
  factCount: number;
  samples: string[];
}

/** One proposed merge of two or more predicates into a single canonical name. */
export interface ConsolidationGroup {
  canonical: string;
  members: string[];
  rationale: string;
}

export interface ConsolidationProposal {
  groups: ConsolidationGroup[];
}

export interface AppliedConsolidation {
  canonical: string;
  mergedFrom: string[];
  rationale: string;
  factsBefore: Record<string, number>;
  factsAfter: number;
}

export interface SkippedConsolidation {
  canonical: string;
  members: string[];
  reason: string;
}

/** One `npm run consolidate` run, appended to metadata/consolidation.json for provenance (git history is the actual restore mechanism). */
export interface ConsolidationRun {
  timestamp: string;
  model: string;
  pipelineVersion: string;
  applied: AppliedConsolidation[];
  skipped: SkippedConsolidation[];
}

export interface ConsolidationLogFile {
  runs: ConsolidationRun[];
}
