/**
 * Durable BeingDB predicate declarations (roles + plain-English
 * descriptions), authored in config/predicate-declarations.json and emitted
 * as `%!` declaration comments at the top of each predicates/<name>.pl file
 * whenever the pipeline writes it. Keeping them in config means they survive
 * every regeneration path (extract, reconcile, fix-types, consolidate),
 * which all rewrite predicate files from scratch.
 *
 * See the BeingDB docs ("Predicate declarations") for the syntax:
 *
 *   %! created_by(Work, Artist)
 *   % Relates a work to the artist or artist group who made it.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { isValidPredicateName } from "./validate.js";

export interface PredicateDeclaration {
  /** One role per argument, in order, e.g. ["Work", "Artist"]; optionally "Role:semantic_type". */
  arguments?: string[];
  /** One-line plain-English description of what the predicate means. */
  description?: string;
}

export type PredicateDeclarations = Record<string, PredicateDeclaration>;

export const DECLARATIONS_FILENAME = "predicate-declarations.json";

const ROLE = /^[A-Z][A-Za-z0-9_]*(:[a-z][a-z0-9_]*)?$/;

/** The declarations file for a repository whose fact files live in `predicatesDir` (i.e. `<root>/config/`). */
export function declarationsPathFor(predicatesDir: string): string {
  return path.join(path.dirname(path.resolve(predicatesDir)), "config", DECLARATIONS_FILENAME);
}

/** Returns a list of problems with a parsed declarations object (empty when valid). */
export function validateDeclarations(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ["declarations must be a JSON object keyed by predicate name"];
  }
  const errors: string[] = [];
  for (const [name, decl] of Object.entries(value as Record<string, unknown>)) {
    if (!isValidPredicateName(name)) errors.push(`${name}: invalid predicate name`);
    if (typeof decl !== "object" || decl === null || Array.isArray(decl)) {
      errors.push(`${name}: declaration must be an object`);
      continue;
    }
    const { arguments: args, description, ...rest } = decl as Record<string, unknown>;
    for (const key of Object.keys(rest)) errors.push(`${name}: unknown field "${key}"`);
    if (args === undefined && description === undefined) {
      errors.push(`${name}: declares neither arguments nor a description`);
    }
    if (args !== undefined) {
      if (!Array.isArray(args) || args.length === 0 || !args.every((a) => typeof a === "string")) {
        errors.push(`${name}: arguments must be a non-empty array of role strings`);
      } else {
        for (const role of args as string[]) {
          if (!ROLE.test(role)) errors.push(`${name}: invalid role "${role}" (expected e.g. Work or Work:work)`);
        }
        const roleNames = (args as string[]).map((a) => a.split(":")[0]);
        if (new Set(roleNames).size !== roleNames.length) errors.push(`${name}: duplicate role names`);
      }
    }
    if (description !== undefined) {
      if (typeof description !== "string" || description.trim() === "") {
        errors.push(`${name}: description must be a non-empty string`);
      } else if (/[\r\n]/.test(description)) {
        errors.push(`${name}: description must be a single line`);
      }
    }
  }
  return errors;
}

/** Loads and validates a declarations file; a missing file means "no declarations". Throws on invalid content. */
export function loadDeclarations(filePath: string): PredicateDeclarations {
  if (!fs.existsSync(filePath)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${filePath}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  const errors = validateDeclarations(parsed);
  if (errors.length > 0) {
    throw new Error(`${filePath}: invalid predicate declarations:\n  - ${errors.join("\n  - ")}`);
  }
  return parsed as PredicateDeclarations;
}

/** Loads the declarations belonging to the repository that owns `predicatesDir`. */
export function loadDeclarationsFor(predicatesDir: string): PredicateDeclarations {
  return loadDeclarations(declarationsPathFor(predicatesDir));
}

/** Own-property lookup, so predicate names like `constructor` never resolve to Object.prototype members. */
export function declarationOf(declarations: PredicateDeclarations, predicate: string): PredicateDeclaration | undefined {
  return Object.hasOwn(declarations, predicate) ? declarations[predicate] : undefined;
}

/** Renders one declaration as BeingDB `%!` comment lines (no trailing newline). */
export function renderDeclaration(predicate: string, declaration: PredicateDeclaration): string {
  const signature = declaration.arguments ? `${predicate}(${declaration.arguments.join(", ")})` : predicate;
  const lines = [`%! ${signature}`];
  if (declaration.description) lines.push(`% ${declaration.description.trim()}`);
  return lines.join("\n");
}
