#!/usr/bin/env node
/**
 * Retroactively fixes argument-type inconsistencies already written to
 * predicates/*.pl (see src/type-consistency.ts for why this matters) -
 * without calling the OpenAI API. Coerces a string argument to an atom
 * wherever that predicate/position already has atom-typed facts elsewhere
 * in the same file, using config/entity-aliases.json for known relabelings.
 *
 *   npm run fix-types
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { AliasMap, EntityResolver } from "./normalize.js";
import { fixPredicateFileTypes } from "./type-consistency.js";
import type { EvidenceEntry } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PREDICATES_DIR = path.join(ROOT, "predicates");
const EVIDENCE_DIR = path.join(ROOT, "metadata", "evidence");

function loadAliasMap(): AliasMap {
  const raw = fs.readFileSync(path.join(ROOT, "config", "entity-aliases.json"), "utf8");
  return new AliasMap(JSON.parse(raw) as Record<string, string>);
}

function updateEvidence(renames: Array<[string, string]>, dropped: string[]): string[] {
  const changedFiles: string[] = [];
  if (!fs.existsSync(EVIDENCE_DIR) || (renames.length === 0 && dropped.length === 0)) return changedFiles;

  for (const entry of fs.readdirSync(EVIDENCE_DIR)) {
    if (!entry.endsWith(".json")) continue;
    const filePath = path.join(EVIDENCE_DIR, entry);
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
    if (changed) {
      fs.writeFileSync(filePath, JSON.stringify(updated, null, 2) + "\n", "utf8");
      changedFiles.push(filePath);
    }
  }
  return changedFiles;
}

function main() {
  const aliases = loadAliasMap();
  const resolver = new EntityResolver({ aliases });

  if (!fs.existsSync(PREDICATES_DIR)) {
    console.log("fix-types: predicates/ does not exist yet - nothing to do.");
    return;
  }

  const allRenames: Array<[string, string]> = [];
  const allDropped: string[] = [];
  let filesChanged = 0;

  for (const entry of fs.readdirSync(PREDICATES_DIR)) {
    if (!entry.endsWith(".pl")) continue;
    const predicate = entry.slice(0, -".pl".length);
    const result = fixPredicateFileTypes(PREDICATES_DIR, predicate, (label) => resolver.resolve(label));
    if (!result) continue;
    filesChanged++;
    console.log(`  ${path.relative(ROOT, result.file)}:`);
    for (const [oldLine, newLine] of result.renamedLines) {
      console.log(`    ${oldLine}\n    -> ${newLine}`);
    }
    for (const { line, reason } of result.droppedLines) {
      console.log(`    dropped: ${line}\n      ${reason}`);
    }
    allRenames.push(...result.renamedLines);
    allDropped.push(...result.droppedLines.map((d) => d.line));
  }

  const evidenceFilesChanged = updateEvidence(allRenames, allDropped);

  console.log(
    `\npredicates/: ${filesChanged} file(s) fixed, ${allRenames.length} fact(s) coerced, ${allDropped.length} fact(s) dropped`,
  );
  console.log(`metadata/evidence/: ${evidenceFilesChanged.length} file(s) updated`);
  if (filesChanged === 0) {
    console.log("No mixed-type positions found.");
  }
}

if (path.resolve(process.argv[1] ?? "") === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
