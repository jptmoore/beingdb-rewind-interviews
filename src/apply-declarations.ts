#!/usr/bin/env node
/**
 * Applies config/predicate-declarations.json to every predicates/*.pl file
 * without calling the OpenAI API: each file is rewritten through the same
 * serializer `npm run extract` uses, so only the header/declaration block can
 * change - the facts are re-emitted exactly as they are.
 *
 *   npm run declarations             -- rewrite predicates/ with current declarations
 *   npm run declarations -- --check  -- verify only; exit 1 if anything is stale or invalid
 *
 * Fails (and writes nothing) if a declaration's argument count does not match
 * its predicate's arity. Undeclared predicates (e.g. new ones from a fresh
 * extraction) and declarations with no predicate file (e.g. merged away by
 * `npm run consolidate`) are reported so they can be authored or removed.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { type PredicateDeclarations, declarationOf, declarationsPathFor, loadDeclarationsFor } from "./declarations.js";
import { readExistingPropositions, renderPredicateFile, writePropositions } from "./serialize.js";
import { parseProposition } from "./type-consistency.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PREDICATES_DIR = path.join(ROOT, "predicates");

export interface DeclarationReport {
  /** Declarations whose argument count differs from the facts' arity. */
  arityMismatches: string[];
  /** Predicates with facts but no declaration. */
  undeclared: string[];
  /** Declarations naming a predicate that has no file in predicates/. */
  orphaned: string[];
  /** Predicate files whose current text differs from what the serializer would write. */
  stale: string[];
}

function listPredicates(predicatesDir: string): string[] {
  if (!fs.existsSync(predicatesDir)) return [];
  return fs
    .readdirSync(predicatesDir)
    .filter((f) => f.endsWith(".pl"))
    .map((f) => f.slice(0, -".pl".length))
    .sort();
}

/** Compares declarations against the predicate files in `predicatesDir`, without writing anything. */
export function checkDeclarations(predicatesDir: string, declarations: PredicateDeclarations): DeclarationReport {
  const predicates = listPredicates(predicatesDir);
  const report: DeclarationReport = { arityMismatches: [], undeclared: [], orphaned: [], stale: [] };

  for (const predicate of predicates) {
    const filePath = path.join(predicatesDir, `${predicate}.pl`);
    const lines = readExistingPropositions(filePath);
    const declaration = declarationOf(declarations, predicate);
    if (!declaration) report.undeclared.push(predicate);

    const arities = new Set(lines.map((l) => parseProposition(l)?.args.length ?? -1));
    if (declaration?.arguments && (arities.size !== 1 || !arities.has(declaration.arguments.length))) {
      report.arityMismatches.push(
        `${predicate}: declares ${declaration.arguments.length} argument(s) but facts have arity ${[...arities].join("/")}`,
      );
    }

    if (fs.readFileSync(filePath, "utf8") !== renderPredicateFile(predicatesDir, predicate, lines)) {
      report.stale.push(predicate);
    }
  }

  const present = new Set(predicates);
  report.orphaned = Object.keys(declarations)
    .filter((name) => !present.has(name))
    .sort();
  return report;
}

function main() {
  const checkOnly = process.argv.slice(2).includes("--check");
  const declarationsFile = path.relative(ROOT, declarationsPathFor(PREDICATES_DIR));
  const declarations = loadDeclarationsFor(PREDICATES_DIR);
  const report = checkDeclarations(PREDICATES_DIR, declarations);

  if (report.undeclared.length > 0) {
    console.log(`Undeclared predicates (add them to ${declarationsFile}):`);
    for (const p of report.undeclared) console.log(`  - ${p}`);
  }
  if (report.orphaned.length > 0) {
    console.log(`Declarations with no predicates/ file (remove or rename in ${declarationsFile}):`);
    for (const p of report.orphaned) console.log(`  - ${p}`);
  }
  if (report.arityMismatches.length > 0) {
    console.error(`Arity mismatches (BeingDB would ignore these declarations):`);
    for (const m of report.arityMismatches) console.error(`  - ${m}`);
    process.exitCode = 1;
    return;
  }

  if (checkOnly) {
    if (report.stale.length > 0) {
      console.error(`${report.stale.length} predicate file(s) are out of date - run \`npm run declarations\`:`);
      for (const p of report.stale) console.error(`  - predicates/${p}.pl`);
      process.exitCode = 1;
      return;
    }
    console.log(`declarations: OK - ${Object.keys(declarations).length} declaration(s), predicates/ up to date.`);
    return;
  }

  for (const predicate of report.stale) {
    const lines = readExistingPropositions(path.join(PREDICATES_DIR, `${predicate}.pl`));
    writePropositions(PREDICATES_DIR, predicate, lines);
  }
  console.log(`declarations: rewrote ${report.stale.length} predicate file(s) from ${declarationsFile} (facts unchanged).`);
}

if (path.resolve(process.argv[1] ?? "") === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
