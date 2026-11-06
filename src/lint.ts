#!/usr/bin/env node
/**
 * Checks that predicates/ keeps the conventions that make the dataset easy
 * to query, without calling any model:
 *
 * Errors (exit 1):
 * - a predicate merged away by a consolidation plan has come back
 *   (e.g. a new extraction wrote studied_at again instead of educated_at)
 * - a predicate has no declaration, or one without arguments or description
 * - an argument position mixes kinds (atoms in some facts, text in others),
 *   which silently splits the predicate: a query matches only one kind
 *
 * Reported only:
 * - predicates with a single fact
 * - atoms that look like duplicates of another atom (one is the other plus
 *   a suffix, e.g. elsa / elsa_stansfield); fix real ones with
 *   `npm run reconcile` and an alias
 *
 *   npm run lint
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { readExistingPropositions } from "./serialize.js";
import { declarationOf, loadDeclarationsFor, type PredicateDeclarations } from "./declarations.js";
import { classifyLiteral, parseProposition, type LiteralKind } from "./type-consistency.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PREDICATES_DIR = path.join(ROOT, "predicates");
const PLANS_DIR = path.join(ROOT, "metadata", "consolidation-plans");

export type Facts = Map<string, string[][]>;

/** Every predicate's facts as argument lists, keyed by predicate name. */
export function readFacts(predicatesDir: string): Facts {
  const facts: Facts = new Map();
  for (const file of fs.readdirSync(predicatesDir).filter((f) => f.endsWith(".pl")).sort()) {
    const predicate = file.slice(0, -".pl".length);
    const lines = readExistingPropositions(path.join(predicatesDir, file));
    facts.set(predicate, lines.map((line) => parseProposition(line)?.args ?? []));
  }
  return facts;
}

/** Predicate names merged away by the plans in plansDir, mapped to the predicate that replaced them. */
export function retiredPredicates(plansDir: string): Map<string, string> {
  const retired = new Map<string, string>();
  if (!fs.existsSync(plansDir)) return retired;
  for (const file of fs.readdirSync(plansDir).filter((f) => f.endsWith(".json")).sort()) {
    const plan = JSON.parse(fs.readFileSync(path.join(plansDir, file), "utf8")) as { groups: Array<{ canonical: string; members: string[] }> };
    for (const group of plan.groups) {
      for (const member of group.members) if (member !== group.canonical) retired.set(member, group.canonical);
    }
  }
  for (const canonical of new Set(retired.values())) retired.delete(canonical);
  return retired;
}

export function checkRetired(facts: Facts, retired: Map<string, string>): string[] {
  return [...facts.keys()].filter((p) => retired.has(p)).map((p) => `${p}: merged into ${retired.get(p)} by a consolidation plan; use ${retired.get(p)}`);
}

export function checkDeclarations(facts: Facts, declarations: PredicateDeclarations): string[] {
  const errors: string[] = [];
  for (const predicate of facts.keys()) {
    const declaration = declarationOf(declarations, predicate);
    if (!declaration) errors.push(`${predicate}: no declaration in config/predicate-declarations.json`);
    else if (!declaration.arguments?.length) errors.push(`${predicate}: declaration has no argument roles`);
    else if (!declaration.description?.trim()) errors.push(`${predicate}: declaration has no description`);
  }
  return errors;
}

export function checkMixedKinds(facts: Facts): string[] {
  const errors: string[] = [];
  for (const [predicate, rows] of facts) {
    const kinds = new Map<number, Set<LiteralKind>>();
    for (const args of rows) {
      args.forEach((a, i) => {
        if (!kinds.has(i)) kinds.set(i, new Set());
        kinds.get(i)!.add(classifyLiteral(a));
      });
    }
    for (const [i, set] of kinds) {
      if (set.size > 1) errors.push(`${predicate}: argument ${i + 1} mixes ${[...set].sort().join(" and ")}`);
    }
  }
  return errors;
}

export function singleFactPredicates(facts: Facts): string[] {
  return [...facts].filter(([, rows]) => rows.length === 1).map(([p]) => p);
}

/** Pairs of atoms where one is the other plus an underscore suffix (elsa / elsa_stansfield). */
export function similarAtoms(facts: Facts): Array<[string, string]> {
  const atoms = new Set<string>();
  for (const rows of facts.values()) for (const args of rows) for (const a of args) if (classifyLiteral(a) === "atom") atoms.add(a);
  const sorted = [...atoms].sort();
  const pairs: Array<[string, string]> = [];
  for (const a of sorted) {
    if (a.length < 4) continue;
    for (const b of sorted) if (b.startsWith(`${a}_`)) pairs.push([a, b]);
  }
  return pairs;
}

function main() {
  const facts = readFacts(PREDICATES_DIR);
  const errors = [
    ...checkRetired(facts, retiredPredicates(PLANS_DIR)),
    ...checkDeclarations(facts, loadDeclarationsFor(PREDICATES_DIR)),
    ...checkMixedKinds(facts),
  ];

  const single = singleFactPredicates(facts);
  console.log(`${facts.size} predicates, ${[...facts.values()].reduce((n, rows) => n + rows.length, 0)} facts`);
  console.log(`\n${single.length} predicate(s) with a single fact (consider merging into a general predicate):\n  ${single.join(", ")}`);
  const pairs = similarAtoms(facts);
  console.log(`\n${pairs.length} atom pair(s) where one extends the other (check for duplicates):`);
  for (const [a, b] of pairs) console.log(`  ${a} / ${b}`);

  if (errors.length) {
    console.error(`\nlint: ${errors.length} error(s):\n  - ${errors.join("\n  - ")}`);
    process.exitCode = 1;
  } else {
    console.log("\nlint: OK");
  }
}

if (path.resolve(process.argv[1] ?? "") === path.resolve(fileURLToPath(import.meta.url))) main();
