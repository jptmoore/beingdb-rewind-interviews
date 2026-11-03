// Presentation helpers shared by the tutorial page and its Node test.
// Nothing here interprets queries: responses come from the BeingDB WASM
// runtime and are only classified and formatted for display.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.TutorialFormat = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const escapeHtml = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  // Lesson prose: `code`, **bold** and [text](https://...) links only.
  function inline(text) {
    return String(text)
      .split(/(`[^`]*`)/g)
      .map((part) => {
        if (part.length > 1 && part.startsWith("`") && part.endsWith("`")) return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
        return escapeHtml(part)
          .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
          .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
      })
      .join("");
  }

  // Parse a runtime response defensively: the UI must never throw on output.
  function parse(text) {
    try {
      const json = JSON.parse(text);
      return json && typeof json === "object" ? json : { error: { code: "bad_response", message: String(text) } };
    } catch (e) {
      return { error: { code: "bad_response", message: `Unreadable response: ${String(text).slice(0, 200)}` } };
    }
  }

  // Which response family is this? Mirrors the native server's response shapes.
  function classify(r, action = "execute") {
    if (!r || typeof r !== "object") return { kind: "failure", code: "bad_response", message: "No response" };
    if (r.error) return { kind: "failure", code: r.error.code, message: r.error.message };
    if (r.valid === false) return { kind: "invalid", errors: r.errors || [], warnings: r.warnings || [] };
    const warnings = r.warnings || [];
    if (action === "explain") return { kind: "explain", planText: r.planText || "", core: r.normalizedCoreQuery || null, warnings };
    if (action === "validate") return { kind: "validate", projection: r.projection || [], distinct: !!r.distinct, warnings };
    if (action === "diagnose")
      return { kind: "diagnose", diagnostics: r.diagnostics || [], provablyEmpty: !!r.provablyEmpty, repair: r.repair || null, warnings };
    if (Array.isArray(r.results) && Array.isArray(r.variables))
      return {
        kind: "rows",
        variables: r.variables,
        rows: r.results.map((row) => r.variables.map((v) => (row ? row[v] ?? null : null))),
        count: r.count,
        total: r.total,
        hasMore: !!r.hasMore,
        truncated: !!r.truncated,
        warnings,
        diagnostics: r.diagnostics || [],
        provablyEmpty: !!r.provablyEmpty,
        repair: r.repair || null,
      };
    return { kind: "failure", code: "bad_response", message: "Unexpected response shape" };
  }

  // A typed result value as shown in a table cell; null for an unmatched optional.
  const cellText = (v) => (v == null ? null : String(v.value));

  // A typed value in BeingDB literal syntax, for predicate examples.
  function literal(v) {
    if (v == null) return "_";
    switch (v.type) {
      case "string":
        return JSON.stringify(v.value);
      case "year":
      case "year_month":
      case "date":
      case "instant":
        return `@${v.value}`;
      case "uri":
        return `<${v.value}>`;
      default:
        return String(v.value);
    }
  }

  return { escapeHtml, inline, parse, classify, cellText, literal };
});
