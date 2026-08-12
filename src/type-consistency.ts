/**
 * Detects and resolves argument-type inconsistencies within one predicate's
 * facts - e.g. one fact using an atom entity reference where another uses a
 * free-text string for what should be the same kind of value at the same
 * argument position. BeingDB compiles a mixed-type position without error,
 * but it silently splits the predicate's semantics (a query pattern against
 * one type never matches facts of the other type there), so this pipeline
 * treats it as worth reconciling rather than compiling through.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { FactArgument } from "./types.js";
import { readExistingPropositions, writePropositions } from "./serialize.js";

export type LiteralKind = FactArgument["kind"];

/** Same literal-kind classification BeingDB itself uses to infer types from syntax. */
export function classifyLiteral(literal: string): LiteralKind {
  if (literal.startsWith('"')) return "string";
  if (literal.startsWith("@")) return "year"; // the only "@" literal this pipeline emits
  if (literal === "true" || literal === "false") return "boolean";
  if (/^-?\d+\.\d+$/.test(literal)) return "decimal";
  if (/^-?\d+$/.test(literal)) return "integer";
  return "atom";
}

/** Reverses BeingDB's string-literal escaping back to the plain text value. */
export function unquoteStringLiteral(literal: string): string {
  if (!literal.startsWith('"')) return literal;
  return literal.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

/** Splits a proposition's argument list, respecting commas inside quoted strings. */
export function splitArguments(argsText: string): string[] {
  const args: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < argsText.length; i++) {
    const ch = argsText[i]!;
    if (ch === '"' && argsText[i - 1] !== "\\") inQuotes = !inQuotes;
    if (ch === "," && !inQuotes) {
      args.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim().length > 0) args.push(current.trim());
  return args;
}

/** Parses one proposition line into its predicate name and literal argument texts, or null if not fact-shaped. */
export function parseProposition(line: string): { predicate: string; args: string[] } | null {
  const match = /^([a-z][a-z0-9_]*)\((.*)\)\.$/.exec(line.trim());
  if (!match) return null;
  return { predicate: match[1]!, args: splitArguments(match[2]!) };
}

/** Per-position argument kinds already present in an existing predicates/<name>.pl file. */
export function establishedKinds(predicatesDir: string, predicate: string): Map<number, Set<LiteralKind>> {
  const filePath = path.join(predicatesDir, `${predicate}.pl`);
  const kinds = new Map<number, Set<LiteralKind>>();
  if (!fs.existsSync(filePath)) return kinds;

  for (const raw of fs.readFileSync(filePath, "utf8").split("\n")) {
    const parsed = parseProposition(raw);
    if (!parsed) continue;
    parsed.args.forEach((arg, position) => {
      const set = kinds.get(position) ?? new Set<LiteralKind>();
      set.add(classifyLiteral(arg));
      kinds.set(position, set);
    });
  }
  return kinds;
}

const MAX_COERCIBLE_LENGTH = 60;

/**
 * If an argument is a string at a position where an atom-typed fact already
 * exists for the same predicate (on disk, or earlier in the same batch),
 * coerce it to an atom via `resolveLabel` instead of leaving the predicate
 * with a silently mismatched type there. Long, sentence-like strings are
 * left alone (more likely genuine free text than an entity name) and
 * reported instead, since guessing wrong here would be worse than leaving
 * the type mismatch for a human to resolve.
 */
export function reconcileArgumentKinds(
  predicate: string,
  args: FactArgument[],
  established: Map<number, Set<LiteralKind>>,
  resolveLabel: (label: string) => string,
): { arguments: FactArgument[]; warnings: string[] } {
  const warnings: string[] = [];
  const result = args.map((arg, position) => {
    if (arg.kind !== "string") return arg;
    const kinds = established.get(position);
    if (!kinds || !kinds.has("atom")) return arg;

    if (arg.value.length > MAX_COERCIBLE_LENGTH) {
      warnings.push(
        `${predicate} argument ${position}: "${arg.value}" conflicts with existing atom-typed facts there but ` +
          `looks like free text, not an entity name - left as a string. Consider a different predicate name.`,
      );
      return arg;
    }

    const atomId = resolveLabel(arg.value);
    warnings.push(
      `${predicate} argument ${position}: coerced string "${arg.value}" to atom ${atomId} to match existing ` +
        `atom-typed facts for this predicate/position`,
    );
    return { kind: "atom", value: atomId } as FactArgument;
  });
  return { arguments: result, warnings };
}

export interface FixFileResult {
  file: string;
  renamedLines: Array<[oldLine: string, newLine: string]>;
}

/**
 * Text-level equivalent of {@link reconcileArgumentKinds}, applied directly
 * to an on-disk predicates/<name>.pl file rather than in-memory facts -
 * used both to retroactively fix already-generated files (npm run
 * fix-types) and to clean up a predicate immediately after merging two
 * predicates together (npm run consolidate), where the merge itself can
 * introduce a new type mismatch.
 */
export function fixPredicateFileTypes(
  predicatesDir: string,
  predicate: string,
  resolveLabel: (label: string) => string,
): FixFileResult | null {
  const filePath = path.join(predicatesDir, `${predicate}.pl`);
  const lines = readExistingPropositions(filePath);
  const parsedLines = lines.map((line) => ({ line, parsed: parseProposition(line) }));

  // Established kinds observed anywhere in the file, before any fix in this pass.
  const established = new Map<number, Set<LiteralKind>>();
  for (const { parsed } of parsedLines) {
    if (!parsed) continue;
    parsed.args.forEach((arg, position) => {
      const kinds = established.get(position) ?? new Set<LiteralKind>();
      kinds.add(classifyLiteral(arg));
      established.set(position, kinds);
    });
  }

  const renamedLines: Array<[string, string]> = [];
  const fixedLines = parsedLines.map(({ line, parsed }) => {
    if (!parsed) return line;
    let changed = false;
    const newArgs = parsed.args.map((arg, position) => {
      if (classifyLiteral(arg) !== "string" || !established.get(position)?.has("atom")) return arg;
      const value = unquoteStringLiteral(arg);
      if (value.length > MAX_COERCIBLE_LENGTH) return arg;
      changed = true;
      return resolveLabel(value);
    });
    if (!changed) return line;
    const newLine = `${predicate}(${newArgs.join(", ")}).`;
    renamedLines.push([line, newLine]);
    return newLine;
  });

  if (renamedLines.length === 0) return null;
  writePropositions(predicatesDir, predicate, fixedLines);
  return { file: filePath, renamedLines };
}

