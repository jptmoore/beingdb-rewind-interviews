import type { FactArgument, RawFact, ResolvedFact } from "./types.js";

const PREDICATE_NAME_RE = /^[a-z][a-z0-9_]*$/;
const ATOM_RE = /^[a-z][a-z0-9_]*$/;
const MIN_YEAR = 1000;
const MAX_YEAR = 2100;

export function isValidPredicateName(name: string): boolean {
  return PREDICATE_NAME_RE.test(name);
}

export function isValidAtom(value: string): boolean {
  return ATOM_RE.test(value);
}

/** Structural validation of one typed argument. Returns an error message, or null if valid. */
export function validateArgument(arg: FactArgument): string | null {
  switch (arg.kind) {
    case "atom":
      if (!ATOM_RE.test(arg.value)) return `invalid atom "${arg.value}"`;
      return null;
    case "string":
      if (arg.value.length === 0) return "empty string argument";
      if (/[\r\n]/.test(arg.value)) return "string argument must not contain newlines";
      return null;
    case "year":
      if (!Number.isInteger(arg.value) || arg.value < MIN_YEAR || arg.value > MAX_YEAR) {
        return `implausible year ${arg.value}`;
      }
      return null;
    case "integer":
      if (!Number.isInteger(arg.value)) return `non-integer value ${arg.value}`;
      return null;
    case "decimal":
      if (!/^-?\d+\.\d+$/.test(arg.value)) return `invalid decimal "${arg.value}"`;
      return null;
    case "boolean":
      return null;
    default:
      return `unknown argument kind`;
  }
}

/**
 * Structural validation of one raw fact: well-formed predicate name, at
 * least one argument, every argument individually valid, and non-empty
 * supporting evidence (a fact with no quoted evidence is rejected outright -
 * this pipeline never accepts unsupported assertions).
 */
export function validateFactShape(fact: RawFact): string | null {
  if (typeof fact.predicate !== "string" || !isValidPredicateName(fact.predicate)) {
    return `invalid predicate name "${fact.predicate}"`;
  }
  if (!Array.isArray(fact.arguments) || fact.arguments.length === 0) {
    return "fact has no arguments";
  }
  for (const arg of fact.arguments) {
    const error = validateArgument(arg);
    if (error) return error;
  }
  if (typeof fact.evidence !== "string" || fact.evidence.trim().length === 0) {
    return "fact has no supporting evidence";
  }
  return null;
}

/** Canonical, type-tagged key for a fact, used for deduplication and stable sorting. */
export function canonicalFactKey(predicate: string, args: FactArgument[]): string {
  const argKey = args.map((a) => `${a.kind}:${String(a.value)}`).join(",");
  return `${predicate}(${argKey})`;
}

/**
 * Keeps only facts explicitly stated or strongly supported by the source
 * text. "uncertain" facts (the model's own hedge) are dropped rather than
 * asserted - this pipeline never upgrades a guess into a fact.
 */
export function filterConservative(
  facts: ResolvedFact[],
): { kept: ResolvedFact[]; dropped: Array<{ fact: ResolvedFact; reason: string }> } {
  const kept: ResolvedFact[] = [];
  const dropped: Array<{ fact: ResolvedFact; reason: string }> = [];
  for (const fact of facts) {
    if (fact.confidence === "uncertain") {
      dropped.push({ fact, reason: "confidence=uncertain" });
      continue;
    }
    kept.push(fact);
  }
  return { kept, dropped };
}

/** Removes exact duplicate facts, keeping the first occurrence (stable). */
export function dedupeFacts(facts: ResolvedFact[]): ResolvedFact[] {
  const seen = new Set<string>();
  const result: ResolvedFact[] = [];
  for (const fact of facts) {
    const key = canonicalFactKey(fact.predicate, fact.arguments);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(fact);
  }
  return result;
}
