#!/usr/bin/env node
/**
 * Uses the model to find predicates in predicates/ that represent the same
 * relationship under different names (e.g. independently invented by
 * separate interview extractions), merges each confirmed group into one
 * canonical predicate, and removes the others.
 *
 * This is destructive on disk (old predicate files are deleted), but never
 * destructive in Git: run this, review `git diff` (removed files show as
 * deletions, the canonical file's added lines show as additions) before
 * committing, and revert or `git checkout -- predicates/` to undo. Every
 * run is also logged to metadata/consolidation.json with the rationale for
 * each merge, so a diff can be understood later without re-deriving it.
 *
 *   npm run consolidate
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";

import type { ConsolidationGroup, ConsolidationProposal, EvidenceEntry, PredicateCatalogEntry } from "./types.js";
import { AliasMap, EntityResolver } from "./normalize.js";
import { isValidPredicateName } from "./validate.js";
import { readExistingPropositions, writePropositions } from "./serialize.js";
import { appendConsolidationLog } from "./metadata.js";
import { classifyLiteral, fixPredicateFileTypes, parseProposition } from "./type-consistency.js";
import { loadDotEnv } from "./env.js";
import { PIPELINE_VERSION } from "./version.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PREDICATES_DIR = path.join(ROOT, "predicates");
const METADATA_DIR = path.join(ROOT, "metadata");
const EVIDENCE_DIR = path.join(METADATA_DIR, "evidence");
const CONSOLIDATION_LOG = path.join(METADATA_DIR, "consolidation.json");

const SAMPLES_PER_PREDICATE = 3;

/** Builds the per-predicate summary (arity, argument kinds, samples) the model reasons about. */
export function buildCatalog(predicatesDir: string): PredicateCatalogEntry[] {
  if (!fs.existsSync(predicatesDir)) return [];
  const catalog: PredicateCatalogEntry[] = [];

  for (const entry of fs.readdirSync(predicatesDir)) {
    if (!entry.endsWith(".pl")) continue;
    const name = entry.slice(0, -".pl".length);
    const lines = readExistingPropositions(path.join(predicatesDir, entry));
    if (lines.length === 0) continue;

    const argumentKinds: Set<string>[] = [];
    for (const line of lines) {
      const parsed = parseProposition(line);
      if (!parsed) continue;
      parsed.args.forEach((arg, position) => {
        const set = argumentKinds[position] ?? new Set<string>();
        set.add(classifyLiteral(arg));
        argumentKinds[position] = set;
      });
    }

    catalog.push({
      name,
      arity: argumentKinds.length,
      argumentKinds: argumentKinds.map((set) => [...set].sort()),
      factCount: lines.length,
      samples: lines.slice(0, SAMPLES_PER_PREDICATE),
    });
  }

  return catalog.sort((a, b) => a.name.localeCompare(b.name));
}

const CONSOLIDATE_SYSTEM_PROMPT = `You are auditing a BeingDB fact database's predicate vocabulary for
semantic duplicates: different predicate names that were independently
invented (often by extracting different interviews) to describe the same
kind of relationship.

You will be given a JSON catalog of every predicate currently in the
database: its name, arity, the argument kinds observed at each position,
how many facts it has, and a few example facts.

Group predicates ONLY when you are confident they represent the exact same
relationship and could be merged into one predicate without changing its
meaning. Two predicates must have the same arity to be mergeable, and their
argument positions must play the same role (e.g. both "person then
organisation", not one "person then organisation" and the other
"organisation then person"). Do not merge predicates just because their
names sound similar if their meaning, argument order, or argument roles
actually differ.

For each group of two or more predicates that should be merged, pick a
canonical name - it must be one of the predicate names already in the
group, normally whichever is clearer or already has the most facts - and
give a short rationale referencing the evidence in the catalog.

Do not include predicates you are not proposing to merge. It's fine, and
expected, to return few or no groups if the predicate vocabulary already
looks distinct. Output must conform exactly to the provided JSON schema.`;

const CONSOLIDATION_SCHEMA = {
  type: "object",
  properties: {
    groups: {
      type: "array",
      items: {
        type: "object",
        properties: {
          canonical: { type: "string" },
          members: { type: "array", items: { type: "string" } },
          rationale: { type: "string" },
        },
        required: ["canonical", "members", "rationale"],
        additionalProperties: false,
      },
    },
  },
  required: ["groups"],
  additionalProperties: false,
} as const;

async function proposeConsolidation(
  client: OpenAI,
  model: string,
  catalog: PredicateCatalogEntry[],
): Promise<ConsolidationProposal> {
  const completion = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: CONSOLIDATE_SYSTEM_PROMPT },
      { role: "user", content: `Predicate catalog:\n${JSON.stringify(catalog, null, 2)}` },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "consolidation_proposal", schema: CONSOLIDATION_SCHEMA, strict: true },
    },
  });

  const content = completion.choices[0]?.message?.content;
  if (!content) throw new Error("consolidate: model returned no content");
  return JSON.parse(content) as ConsolidationProposal;
}

export type GroupValidation = { ok: true } | { ok: false; reason: string };

/** Structural/safety validation of one proposed group before it is ever applied. */
export function validateGroup(
  group: ConsolidationGroup,
  catalogByName: Map<string, PredicateCatalogEntry>,
  claimed: ReadonlySet<string>,
): GroupValidation {
  const members = [...new Set(group.members)];
  if (members.length < 2) return { ok: false, reason: "fewer than 2 distinct members" };
  if (!isValidPredicateName(group.canonical)) return { ok: false, reason: `invalid canonical name "${group.canonical}"` };
  if (!members.includes(group.canonical)) return { ok: false, reason: "canonical name is not one of the members" };

  for (const member of members) {
    if (!catalogByName.has(member)) return { ok: false, reason: `unknown predicate "${member}"` };
    if (claimed.has(member)) return { ok: false, reason: `"${member}" was already merged by an earlier group this run` };
  }

  const arities = new Set(members.map((m) => catalogByName.get(m)!.arity));
  if (arities.size > 1) return { ok: false, reason: `members have different arities (${[...arities].join(", ")})` };

  return { ok: true };
}

export interface AppliedGroupResult {
  canonical: string;
  mergedFrom: string[];
  factsBefore: Record<string, number>;
  factsAfter: number;
}

/** Merges every member's facts (renamed to the canonical predicate) into one file, and deletes the other member files. */
export function applyGroup(predicatesDir: string, evidenceDir: string, group: ConsolidationGroup): AppliedGroupResult {
  const members = [...new Set(group.members)];
  const factsBefore: Record<string, number> = {};
  const mergedLines: string[] = [];

  for (const member of members) {
    const lines = readExistingPropositions(path.join(predicatesDir, `${member}.pl`));
    factsBefore[member] = lines.length;
    for (const line of lines) {
      const parsed = parseProposition(line)!;
      mergedLines.push(`${group.canonical}(${parsed.args.join(", ")}).`);
    }
  }

  const unique = new Set(mergedLines);
  writePropositions(predicatesDir, group.canonical, unique);

  const mergedFrom = members.filter((m) => m !== group.canonical);
  for (const member of mergedFrom) {
    fs.rmSync(path.join(predicatesDir, `${member}.pl`));
    renamePredicateInEvidence(evidenceDir, member, group.canonical);
  }

  return { canonical: group.canonical, mergedFrom, factsBefore, factsAfter: unique.size };
}

/** Renames a predicate's prefix in every evidence sidecar's recorded "fact" strings, e.g. after merging it away. */
function renamePredicateInEvidence(evidenceDir: string, oldPredicate: string, newPredicate: string): void {
  if (!fs.existsSync(evidenceDir)) return;
  const prefix = `${oldPredicate}(`;

  for (const entry of fs.readdirSync(evidenceDir)) {
    if (!entry.endsWith(".json")) continue;
    const filePath = path.join(evidenceDir, entry);
    const entries = JSON.parse(fs.readFileSync(filePath, "utf8")) as EvidenceEntry[];
    let changed = false;
    const updated = entries.map((e) => {
      if (!e.fact.startsWith(prefix)) return e;
      changed = true;
      return { ...e, fact: `${newPredicate}(${e.fact.slice(prefix.length)}` };
    });
    if (changed) fs.writeFileSync(filePath, JSON.stringify(updated, null, 2) + "\n", "utf8");
  }
}

/** Applies a fact-string rename/removal (from {@link fixPredicateFileTypes}) to every evidence sidecar. */
function applyFixToEvidence(evidenceDir: string, renames: Array<[string, string]>, dropped: string[]): void {
  if (!fs.existsSync(evidenceDir) || (renames.length === 0 && dropped.length === 0)) return;
  for (const entry of fs.readdirSync(evidenceDir)) {
    if (!entry.endsWith(".json")) continue;
    const filePath = path.join(evidenceDir, entry);
    const entries = JSON.parse(fs.readFileSync(filePath, "utf8")) as EvidenceEntry[];
    let changed = false;
    const updated = entries
      .filter((e) => {
        if (!dropped.includes(e.fact)) return true;
        changed = true;
        return false;
      })
      .map((e) => {
        const rename = renames.find(([oldLine]) => oldLine === e.fact);
        if (!rename) return e;
        changed = true;
        return { ...e, fact: rename[1] };
      });
    if (changed) fs.writeFileSync(filePath, JSON.stringify(updated, null, 2) + "\n", "utf8");
  }
}

function loadAliasMap(): AliasMap {
  const raw = fs.readFileSync(path.join(ROOT, "config", "entity-aliases.json"), "utf8");
  return new AliasMap(JSON.parse(raw) as Record<string, string>);
}

async function main() {
  loadDotEnv(path.join(ROOT, ".env"));
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL;
  if (!apiKey || !model) {
    console.error("consolidate: OPENAI_API_KEY/OPENAI_MODEL are not set. Copy .env.example to .env and fill it in.");
    process.exitCode = 1;
    return;
  }

  const catalog = buildCatalog(PREDICATES_DIR);
  if (catalog.length === 0) {
    console.log("consolidate: no predicates found in predicates/ - nothing to do.");
    return;
  }

  console.log(`Scanning ${catalog.length} predicates for semantic duplicates using ${model}...`);
  const client = new OpenAI({ apiKey });
  const proposal = await proposeConsolidation(client, model, catalog);
  console.log(`Model proposed ${proposal.groups.length} candidate group(s).\n`);

  const catalogByName = new Map(catalog.map((c) => [c.name, c]));
  const resolver = new EntityResolver({ aliases: loadAliasMap() });
  const claimed = new Set<string>();

  const applied: import("./types.js").AppliedConsolidation[] = [];
  const skipped: import("./types.js").SkippedConsolidation[] = [];

  for (const group of proposal.groups) {
    const validation = validateGroup(group, catalogByName, claimed);
    if (!validation.ok) {
      skipped.push({ canonical: group.canonical, members: group.members, reason: validation.reason });
      console.log(`skipped [${group.members.join(", ")}] -> ${group.canonical}: ${validation.reason}`);
      continue;
    }

    group.members.forEach((m) => claimed.add(m));
    const result = applyGroup(PREDICATES_DIR, EVIDENCE_DIR, group);
    const fix = fixPredicateFileTypes(PREDICATES_DIR, group.canonical, (label) => resolver.resolve(label));
    if (fix) {
      applyFixToEvidence(
        EVIDENCE_DIR,
        fix.renamedLines,
        fix.droppedLines.map((d) => d.line),
      );
      for (const { line, reason } of fix.droppedLines) {
        console.log(`  dropped after merge: ${line}\n    ${reason}`);
      }
      result.factsAfter -= fix.droppedLines.length;
    }

    applied.push({ ...result, rationale: group.rationale });
    console.log(`merged [${result.mergedFrom.join(", ")}] into ${result.canonical} (${result.factsAfter} facts)`);
    console.log(`  ${group.rationale}`);
  }

  if (applied.length === 0) {
    console.log("\nNo predicates were merged.");
    return;
  }

  appendConsolidationLog(CONSOLIDATION_LOG, {
    timestamp: new Date().toISOString(),
    model,
    pipelineVersion: PIPELINE_VERSION,
    applied,
    skipped,
  });

  console.log(
    `\n${applied.length} predicate group(s) merged. Provenance recorded in ${path.relative(ROOT, CONSOLIDATION_LOG)}.`,
  );
  console.log(
    "Nothing is committed yet - review `git diff` (merged-away predicates show as deletions) before committing. " +
      "To undo: `git checkout -- predicates/ metadata/` before committing, or `git revert <commit>` after. " +
      "A removed predicates/<name>.pl can also be restored on its own with " +
      "`git show <commit>^:predicates/<name>.pl > predicates/<name>.pl`.",
  );
}

if (path.resolve(process.argv[1] ?? "") === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
