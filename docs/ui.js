// Shared page UI for the BeingDB WASM runtime: query editor, response
// rendering and predicate browsing, used by the tutorial and the explorer.
// Nothing here interprets queries; all behaviour comes from BeingDB.
(() => {
  const F = window.TutorialFormat;

  // Tiny DOM builder: h("div.class", {attrs}, ...children). Strings become text nodes.
  function h(tag, attrs, ...children) {
    const [name, ...classes] = tag.split(".");
    const el = document.createElement(name);
    if (classes.length) el.className = classes.join(" ");
    if (attrs && (typeof attrs !== "object" || attrs instanceof Node || Array.isArray(attrs))) {
      children.unshift(attrs);
      attrs = null;
    }
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "html") el.innerHTML = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) el.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
    return el;
  }
  const rich = (tag, text) => h(tag, { html: F.inline(text) });
  // replaceChildren, accepting nested arrays like h() does.
  const fill = (el, ...children) => el.replaceChildren(...children.flat(Infinity).filter((c) => c != null && c !== false));

  // ---- Calling the runtime -------------------------------------------------

  const ACTIONS = {
    execute: { method: "query", label: "Run" },
    validate: { method: "validate", label: "Validate" },
    diagnose: { method: "diagnose", label: "Diagnose" },
    explain: { method: "explain", label: "Explain" },
  };

  function call(BeingDB, action, text) {
    const t = performance.now();
    let raw;
    try {
      raw = BeingDB[ACTIONS[action].method](text);
    } catch (e) {
      raw = JSON.stringify({ error: { code: "runtime_exception", message: String(e && e.message ? e.message : e) } });
    }
    const json = F.parse(raw);
    return { json, view: F.classify(json, action), ms: performance.now() - t };
  }

  // ---- Rendering responses -------------------------------------------------

  function messages(list, cls) {
    return list.map((m) =>
      h(
        `div.message.${cls}${m.severity ? "." + m.severity : ""}`,
        h("div.message-head", h("code.badge", m.code || cls), m.severity ? h("span.severity", m.severity) : null, m.line ? h("span.where", `line ${m.line}${m.column ? `, column ${m.column}` : ""}`) : null),
        h("p", m.message || ""),
        Array.isArray(m.suggestions) && m.suggestions.length ? h("p.suggest", "Did you mean: ", m.suggestions.map((s) => h("code", s)).reduce((a, b) => [a, ", ", b])) : null,
        m.groups ? h("p.suggest", "Unconnected groups: ", m.groups.map((g) => h("code", g.join(" ")))) : null,
      ),
    );
  }

  function diagnosis(view, editor) {
    const out = [];
    if (view.provablyEmpty) out.push(h("p.provably", h("strong", "Provably empty: "), "BeingDB has proved this query can never match the loaded data."));
    if (view.diagnostics.length) out.push(...messages(view.diagnostics, "diagnostic"));
    if (view.repair && view.repair.query)
      out.push(
        h(
          "div.repair",
          h("p", h("strong", "Proven repair"), " (computed by BeingDB):"),
          h("pre.code", view.repair.query),
          h("button.secondary", { type: "button", onclick: () => editor.set(view.repair.query) }, "Apply repair"),
        ),
      );
    return out;
  }

  function resultTable(view) {
    const LIMIT = 100;
    const table = (rows) =>
      h(
        "div.table-wrap",
        h(
          "table.results",
          h("thead", h("tr", view.variables.map((v) => h("th", v)))),
          h(
            "tbody",
            rows.map((row) =>
              h(
                "tr",
                row.map((v) => (v == null ? h("td.null", { title: "unbound (no optional match)" }, "null") : h("td", { title: v.type }, F.cellText(v)))),
              ),
            ),
          ),
        ),
      );
    const wrap = h("div", table(view.rows.slice(0, LIMIT)));
    if (view.rows.length > LIMIT)
      wrap.append(h("button.link", { type: "button", onclick: () => wrap.replaceChildren(table(view.rows)) }, `Show all ${view.rows.length} rows`));
    return wrap;
  }

  function summaryLine(view, ms) {
    const n = (x) => `${x} row${x === 1 ? "" : "s"}`;
    let text = view.count === view.total ? n(view.total) : `${n(view.count)} shown of ${view.total} matching`;
    if (view.truncated) text += " (truncated by the result cap)";
    return h("p.summary", text, h("span.ms", ` · ${ms.toFixed(1)} ms`));
  }

  function renderResponse(out, { json, view, ms }, editor) {
    const parts = [];
    if (view.kind === "rows") {
      parts.push(summaryLine(view, ms));
      if (view.rows.length) parts.push(resultTable(view));
      else parts.push(h("p.empty", "No rows."));
      parts.push(...diagnosis(view, editor));
    } else if (view.kind === "invalid") {
      parts.push(h("p.summary.bad", "Query rejected before running"));
      parts.push(...messages(view.errors, "error"));
    } else if (view.kind === "failure") {
      parts.push(h("p.summary.bad", "Query failed"));
      parts.push(...messages([{ code: view.code, message: view.message }], "error"));
    } else if (view.kind === "diagnose") {
      parts.push(h("p.summary", view.diagnostics.length ? "Diagnostics (query not executed)" : "No problems found (query not executed)", h("span.ms", ` · ${ms.toFixed(1)} ms`)));
      parts.push(...diagnosis(view, editor));
    } else if (view.kind === "validate") {
      parts.push(h("p.summary.good", "Valid. ", "Returns columns: ", view.projection.map((v) => h("code", v)).reduce((a, b) => [a, ", ", b], []), view.distinct ? " (distinct)" : ""));
    } else if (view.kind === "explain") {
      parts.push(h("p.summary", "Execution plan (query not executed)"));
      parts.push(h("pre.code", view.planText));
    }
    if (view.warnings && view.warnings.length) parts.push(...messages(view.warnings, "warning"));
    parts.push(h("details.raw", h("summary", "Raw JSON"), h("pre", JSON.stringify(json, null, 2))));
    fill(out, parts);
  }

  // ---- Editor and predicates -----------------------------------------------

  function makeEditor(initial) {
    const area = h("textarea.editor", { spellcheck: "false", autocapitalize: "off", autocomplete: "off", "aria-label": "BeingDB query" });
    const fit = () => {
      area.style.height = "auto";
      area.style.height = `${area.scrollHeight + 2}px`;
    };
    area.value = initial;
    area.addEventListener("input", fit);
    area.addEventListener("keydown", (e) => {
      if (e.key === "Tab" && !e.shiftKey) {
        e.preventDefault();
        area.setRangeText("  ", area.selectionStart, area.selectionEnd, "end");
        fit();
      }
    });
    requestAnimationFrame(fit);
    return {
      el: area,
      get: () => area.value,
      set: (text) => {
        area.value = text;
        fit();
        area.focus();
      },
    };
  }

  function describeCard(p) {
    if (!p) return h("p.empty", "Unknown predicate.");
    const examples = (p.examples || []).map((args) => `${p.name}(${args.map(F.literal).join(", ")})`);
    return h(
      "div.describe",
      h("h4", h("code", `${p.name}/${p.arity}`), h("span.count", `${p.count} facts`)),
      p.description ? h("p", p.description) : h("p.empty", "No description declared."),
      h(
        "div.table-wrap",
        h(
          "table.prose",
          h("thead", h("tr", h("th", "Argument"), h("th", "Role"), h("th", "Type"))),
          h("tbody", p.arguments.map((a) => h("tr", h("td", String(a.position)), h("td", a.role ? h("code", a.role) : "–", a.semanticType ? ` (${a.semanticType})` : ""), h("td", a.types.join(" | "))))),
        ),
      ),
      examples.length ? [h("p.label", "Examples"), h("pre.code", examples.join("\n"))] : null,
    );
  }

  function predicateBrowser(predicates, onPick) {
    const detail = h("div");
    const tbody = h("tbody");
    const filter = h("input.filter", { type: "search", placeholder: "Filter predicates", "aria-label": "Filter predicates" });
    const count = h("span.hint");
    const draw = () => {
      const q = filter.value.trim().toLowerCase();
      const shown = predicates.filter((p) => !q || p.name.includes(q) || (p.description || "").toLowerCase().includes(q));
      count.textContent = `${shown.length} of ${predicates.length}`;
      fill(
        tbody,
        shown.map((p) =>
          h(
            "tr",
            h("td", h("button.link", { type: "button", onclick: () => (onPick ? onPick(p) : detail.replaceChildren(describeCard(p))) }, `${p.name}/${p.arity}`)),
            h("td.num", String(p.count)),
            h("td", p.description || ""),
          ),
        ),
      );
    };
    filter.addEventListener("input", draw);
    draw();
    return [
      h("div.toolbar", filter, count),
      detail,
      h("div.table-wrap.scroll", h("table.prose.predicates", h("thead", h("tr", h("th", "Predicate"), h("th", "Facts"), h("th", "Description"))), tbody)),
    ];
  }

  window.BeingDBUI = { h, rich, fill, ACTIONS, call, renderResponse, makeEditor, describeCard, predicateBrowser };
})();
