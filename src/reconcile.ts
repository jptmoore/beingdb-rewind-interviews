#!/usr/bin/env node
/**
 * Cheap, offline fix-up for atom IDs already written into predicates/ and
 * metadata/evidence/ - e.g. after adding a missed alias to
 * config/entity-aliases.json for an entity-id collision the resolver had to
 * disambiguate (see EntityResolver in src/normalize.ts). Renaming here never
 * calls the OpenAI API; it just rewrites already-generated files.
 *
 *   npm run reconcile -- ikon_gallery_birmingham_2=ikon_gallery_birmingham \
 *                         ikon_gallery_birmingham_3=ikon_gallery_birmingham
 *
 * Remember to also add the missing alias/override so future `npm run
 * extract` runs don't need this again.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { isValidAtom } from "./validate.js";
import { readExistingPropositions, writePropositions } from "./serialize.js";
import type { EvidenceEntry } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PREDICATES_DIR = path.join(ROOT, "predicates");
const EVIDENCE_DIR = path.join(ROOT, "metadata", "evidence");

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Replaces `oldId` with `newId` only where it appears as a whole atom token, never as a substring of a longer one. */
export function renameAtomInText(text: string, oldId: string, newId: string): string {
  const pattern = new RegExp(`(?<![a-z0-9_])${escapeRegExp(oldId)}(?![a-z0-9_])`, "g");
  return text.replace(pattern, newId);
}

export interface PredicateRenameResult {
  file: string;
  changedLineCount: number;
  mergedDuplicateCount: number;
}

/** Applies every [oldId, newId] rename to every predicates/*.pl file, merging any facts that become duplicates. */
export function renameAtomsInPredicates(
  predicatesDir: string,
  renames: Array<[string, string]>,
): PredicateRenameResult[] {
  const results: PredicateRenameResult[] = [];
  if (!fs.existsSync(predicatesDir)) return results;

  for (const entry of fs.readdirSync(predicatesDir)) {
    if (!entry.endsWith(".pl")) continue;
    const filePath = path.join(predicatesDir, entry);
    const predicate = entry.slice(0, -".pl".length);

    const original = readExistingPropositions(filePath);
    const renamed = original.map((line) => renames.reduce((l, [oldId, newId]) => renameAtomInText(l, oldId, newId), line));

    const changedLineCount = renamed.filter((line, i) => line !== original[i]).length;
    if (changedLineCount === 0) continue;

    const unique = new Set(renamed);
    writePropositions(predicatesDir, predicate, unique);
    results.push({
      file: filePath,
      changedLineCount,
      mergedDuplicateCount: renamed.length - unique.size,
    });
  }
  return results;
}

export interface EvidenceRenameResult {
  file: string;
  changedEntryCount: number;
}

/** Keeps metadata/evidence/*.json's recorded "fact" strings consistent with a predicates/ rename. */
export function renameAtomsInEvidence(evidenceDir: string, renames: Array<[string, string]>): EvidenceRenameResult[] {
  const results: EvidenceRenameResult[] = [];
  if (!fs.existsSync(evidenceDir)) return results;

  for (const entry of fs.readdirSync(evidenceDir)) {
    if (!entry.endsWith(".json")) continue;
    const filePath = path.join(evidenceDir, entry);
    const entries = JSON.parse(fs.readFileSync(filePath, "utf8")) as EvidenceEntry[];

    let changedEntryCount = 0;
    const updated = entries.map((e) => {
      const fact = renames.reduce((f, [oldId, newId]) => renameAtomInText(f, oldId, newId), e.fact);
      if (fact !== e.fact) changedEntryCount++;
      return { ...e, fact };
    });

    if (changedEntryCount > 0) {
      fs.writeFileSync(filePath, JSON.stringify(updated, null, 2) + "\n", "utf8");
      results.push({ file: filePath, changedEntryCount });
    }
  }
  return results;
}

function parseRenamePairs(argv: string[]): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const arg of argv) {
    const eq = arg.indexOf("=");
    if (eq === -1) {
      throw new Error(`reconcile: expected "oldId=newId", got "${arg}"`);
    }
    const oldId = arg.slice(0, eq).trim();
    const newId = arg.slice(eq + 1).trim();
    if (!isValidAtom(oldId)) throw new Error(`reconcile: "${oldId}" is not a valid atom`);
    if (!isValidAtom(newId)) throw new Error(`reconcile: "${newId}" is not a valid atom`);
    pairs.push([oldId, newId]);
  }
  return pairs;
}

function main() {
  const renames = parseRenamePairs(process.argv.slice(2));
  if (renames.length === 0) {
    console.error("usage: npm run reconcile -- oldId=newId [oldId2=newId2 ...]");
    process.exitCode = 1;
    return;
  }

  console.log("Renaming (no OpenAI calls involved):");
  for (const [oldId, newId] of renames) console.log(`  ${oldId} -> ${newId}`);

  const predicateResults = renameAtomsInPredicates(PREDICATES_DIR, renames);
  console.log(`\npredicates/: ${predicateResults.length} file(s) changed`);
  for (const r of predicateResults) {
    console.log(
      `  ${path.relative(ROOT, r.file)}: ${r.changedLineCount} line(s) touched, ${r.mergedDuplicateCount} duplicate(s) merged away`,
    );
  }

  const evidenceResults = renameAtomsInEvidence(EVIDENCE_DIR, renames);
  console.log(`\nmetadata/evidence/: ${evidenceResults.length} file(s) changed`);
  for (const r of evidenceResults) {
    console.log(`  ${path.relative(ROOT, r.file)}: ${r.changedEntryCount} entr(y/ies) updated`);
  }

  console.log(
    "\nRemember: this only fixes already-generated files. Add the same mapping as an alias in " +
      "config/entity-aliases.json (or an idOverrides entry) so future `npm run extract` runs resolve it correctly too.",
  );
}

if (path.resolve(process.argv[1] ?? "") === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
