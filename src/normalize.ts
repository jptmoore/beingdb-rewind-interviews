/**
 * Deterministic, human-readable atom identifiers.
 *
 * Normalization is intentionally simple (lowercase, ASCII, underscores) so it
 * stays predictable across regenerations. Because a predictable scheme can
 * still collide two genuinely different entities onto the same atom, callers
 * should route every label through an {@link EntityResolver} rather than
 * calling {@link normalizeId} directly, so accidental collisions are
 * detected and disambiguated instead of silently merged.
 */

/** Lowercase, ASCII-only, underscore-separated identifier for a human-readable label. */
export function normalizeId(label: string): string {
  const ascii = label
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, ""); // strip combining accents (e.g. "é" -> "e")

  const slug = ascii
    .toLowerCase()
    .replace(/'/g, "") // "St Martin's" -> "st martins" (no stray underscore for the apostrophe)
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");

  return slug.length > 0 ? slug : "unknown";
}

/** Case-insensitive lookup over a curated label -> atom-ID alias map. */
export class AliasMap {
  private readonly byLowerLabel = new Map<string, string>();

  constructor(aliases: Record<string, string>) {
    for (const [label, id] of Object.entries(aliases)) {
      if (label.startsWith("_")) continue; // e.g. "_comment"
      this.byLowerLabel.set(label.trim().toLowerCase(), id);
    }
  }

  resolve(label: string): string | undefined {
    return this.byLowerLabel.get(label.trim().toLowerCase());
  }
}

export interface EntityResolverOptions {
  /** Shared, cross-interview curated aliases (config/entity-aliases.json). */
  aliases: AliasMap;
  /** Per-interview explicit overrides (config/interviews.json[].idOverrides), take priority over aliases. */
  overrides?: Record<string, string>;
}

/**
 * Resolves model-proposed entity labels to stable atom IDs for a single
 * extraction run, detecting the case where two different labels would
 * otherwise normalize to the same atom (and disambiguating them instead of
 * silently merging two different real-world entities).
 */
export class EntityResolver {
  private readonly aliases: AliasMap;
  private readonly overrides: Map<string, string>;
  /** final atom ID -> the label that first claimed it. */
  private readonly claimedBy = new Map<string, string>();
  readonly warnings: string[] = [];

  constructor(options: EntityResolverOptions) {
    this.aliases = options.aliases;
    this.overrides = new Map(
      Object.entries(options.overrides ?? {}).map(([label, id]) => [label.trim().toLowerCase(), id]),
    );
  }

  /** Resolve a single label to a final, collision-checked atom ID. */
  resolve(label: string): string {
    const override = this.overrides.get(label.trim().toLowerCase());
    const alias = this.aliases.resolve(label);
    const candidate = override ?? alias ?? normalizeId(label);
    return this.disambiguate(candidate, label);
  }

  private disambiguate(candidateId: string, label: string): string {
    const existingLabel = this.claimedBy.get(candidateId);
    if (existingLabel === undefined) {
      this.claimedBy.set(candidateId, label);
      return candidateId;
    }
    if (existingLabel.trim().toLowerCase() === label.trim().toLowerCase()) {
      return candidateId; // same entity, referred to again
    }

    // Two different labels normalized to the same atom: keep the first
    // claim stable and mint a suffixed ID for the newcomer rather than
    // merging two potentially different real-world entities.
    let suffix = 2;
    let disambiguated = `${candidateId}_${suffix}`;
    while (this.claimedBy.has(disambiguated)) {
      suffix += 1;
      disambiguated = `${candidateId}_${suffix}`;
    }
    this.claimedBy.set(disambiguated, label);
    this.warnings.push(
      `entity id collision: "${label}" and "${existingLabel}" both normalize to "${candidateId}"; ` +
        `"${label}" was assigned "${disambiguated}" instead. Add an explicit override in ` +
        `config/entity-aliases.json or config/interviews.json if this is wrong.`,
    );
    return disambiguated;
  }
}
