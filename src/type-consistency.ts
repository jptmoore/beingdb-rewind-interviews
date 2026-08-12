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
 * If an argument is a string at a position where an established, non-string
 * kind already exists for the same predicate (on disk, or earlier in the
 * same batch), either coerce it to an atom via `resolveLabel` (when an atom
 * precedent exists and the value is short enough to be a name, not a
 * sentence) or - when no safe coercion exists (e.g. the established kind is
 * "year", or the string is long, sentence-like free text) - signal that the
 * whole fact should be dropped rather than written with a permanently
 * mismatched type. Mirrors {@link fixPredicateFileTypes}, the same logic
 * applied directly to an on-disk predicate file.
 */
export function reconcileArgumentKinds(
  predicate: string,
  args: FactArgument[],
  established: Map<number, Set<LiteralKind>>,
  resolveLabel: (label: string) => string,
): { arguments: FactArgument[]; warnings: string[]; drop: boolean } {
  const warnings: string[] = [];
  let drop = false;
  const result = args.map((arg, position) => {
    if (drop || arg.kind !== "string") return arg;
    const kinds = established.get(position);
    const conflicting = kinds && [...kinds].some((k) => k !== "string");
    if (!conflicting) return arg;

    if (kinds!.has("atom") && arg.value.length <= MAX_COERCIBLE_LENGTH) {
      const atomId = resolveLabel(arg.value);
      warnings.push(
        `${predicate} argument ${position}: coerced string "${arg.value}" to atom ${atomId} to match existing ` +
          `atom-typed facts for this predicate/position`,
      );
      return { kind: "atom", value: atomId } as FactArgument;
    }

    warnings.push(
      `${predicate} argument ${position}: dropped - "${arg.value}" conflicts with established type(s) ` +
        `[${[...kinds!].join(", ")}] at this position and can't be safely coerced`,
    );
    drop = true;
    return arg;
  });
  return { arguments: result, warnings, drop };
}


export interface FixFileResult {
  file: string;
  renamedLines: Array<[oldLine: string, newLine: string]>;
  /** Facts that conflicted with an established type but could not be safely coerced, so were removed instead. */
  droppedLines: Array<{ line: string; reason: string }>;
}

/**
 * Text-level equivalent of {@link reconcileArgumentKinds}, applied directly
 * to an on-disk predicates/<name>.pl file rather than in-memory facts -
 * used both to retroactively fix already-generated files (npm run
 * fix-types) and to clean up a predicate immediately after merging two
 * predicates together (npm run consolidate), where the merge itself can
 * introduce a new type mismatch.
 *
 * A string argument that conflicts with an established non-string kind at
 * its position is coerced to an atom when that's plausible (an atom
 * precedent exists and the value is short enough to be a name, not a
 * sentence). When it isn't - the established kind is something coercion
 * can't produce (e.g. "year"), or the string is long, sentence-like free
 * text - there is no safe rewrite, so the whole fact is dropped rather than
 * left permanently mismatched. This mirrors the pipeline's own "omit
 * rather than invent" rule for extraction itself.
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
  const droppedLines: Array<{ line: string; reason: string }> = [];
  const fixedLines = parsedLines.flatMap(({ line, parsed }) => {
    if (!parsed) return [line];

    let changed = false;
    let drop: string | null = null;
    const newArgs = parsed.args.map((arg, position) => {
      if (drop || classifyLiteral(arg) !== "string") return arg;
      const kinds = established.get(position);
      const conflicting = kinds && [...kinds].some((k) => k !== "string");
      if (!conflicting) return arg;

      const value = unquoteStringLiteral(arg);
      if (kinds!.has("atom") && value.length <= MAX_COERCIBLE_LENGTH) {
        changed = true;
        return resolveLabel(value);
      }
      drop = `argument ${position} ("${value}") conflicts with established type(s) [${[...kinds!].join(", ")}] at this position and can't be safely coerced`;
      return arg;
    });

    if (drop) {
      droppedLines.push({ line, reason: drop });
      return [];
    }
    if (!changed) return [line];
    const newLine = `${predicate}(${newArgs.join(", ")}).`;
    renamedLines.push([line, newLine]);
    return [newLine];
  });

  if (renamedLines.length === 0 && droppedLines.length === 0) return null;
  writePropositions(predicatesDir, predicate, fixedLines);
  return { file: filePath, renamedLines, droppedLines };
}

