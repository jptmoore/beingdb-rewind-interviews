// BeingDB explorer: query any BeingDB browser export in the page.
//
// The data comes from beingdb.json next to this page ({"data": "...", "title",
// "description", "examples": [{"title", "query"}]}), or from ?data=URL, which
// takes precedence. All query behaviour comes from BeingDB; this file and
// ui.js only display it.
(() => {
  const { h, rich, fill, ACTIONS, call, renderResponse, makeEditor, predicateBrowser } = window.BeingDBUI;
  const F = window.TutorialFormat;
  const $ = (sel) => document.querySelector(sel);
  const state = { BeingDB: null, predicates: [] };

  async function loadConfig() {
    const res = await fetch("beingdb.json").catch(() => null);
    if (!res || res.status === 404) return {};
    if (!res.ok) throw new Error(`beingdb.json: HTTP ${res.status}`);
    const config = await res.json().catch(() => {
      throw new Error("beingdb.json is not valid JSON");
    });
    return config && typeof config === "object" ? config : {};
  }

  // Only http(s) URLs, resolved against the page.
  function dataUrl(spec) {
    let url;
    try {
      url = new URL(spec, location.href);
    } catch (e) {
      throw new Error(`Not a valid data URL: ${spec}`);
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`Data must be loaded over http(s): ${spec}`);
    return url;
  }

  // A first query when none is configured: ten facts of the largest predicate.
  function defaultQuery() {
    const p = [...state.predicates].sort((a, b) => b.count - a.count)[0];
    if (!p) return "";
    const vars = (p.arguments || []).map((a, i) => (a.role && /^[A-Z][A-Za-z0-9_]*$/.test(a.role) ? a.role : String.fromCharCode(65 + i)));
    const unique = vars.map((v, i) => (vars.indexOf(v) === i ? v : `${v}${i}`));
    return `find ${unique.join(", ")}\nwhere\n  ${p.name}(${unique.join(", ")})\nlimit 10`;
  }

  function render(config, examples) {
    const editor = makeEditor(examples[0] ? examples[0].query : defaultQuery());
    const out = h("div.output", { "aria-live": "polite" });
    const run = (a) => renderResponse(out, call(state.BeingDB, a, editor.get()), editor);
    editor.el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        run("execute");
      }
    });
    fill(
      $("#app"),
      config.description ? rich("p.intro", config.description) : null,
      examples.length
        ? [
            h("p.label", "Examples"),
            h(
              "div.examples",
              examples.map((ex) => h("button.secondary", { type: "button", onclick: () => { editor.set(ex.query); run("execute"); } }, ex.title || ex.query.split("\n")[0])),
            ),
          ]
        : null,
      h(
        "section.step",
        editor.el,
        h(
          "div.toolbar",
          h("button.primary", { type: "button", onclick: () => run("execute") }, ACTIONS.execute.label),
          ["validate", "diagnose", "explain"].map((a) => h("button.secondary", { type: "button", onclick: () => run(a), title: `${ACTIONS[a].label} without running` }, ACTIONS[a].label)),
          h("span.hint", "Ctrl/⌘ + Enter"),
        ),
        out,
      ),
      h(
        "p.footer",
        "Queries run in your browser with ",
        h("a", { href: "https://github.com/jptmoore/beingdb-wasm", target: "_blank", rel: "noopener" }, "BeingDB WASM"),
        "; nothing is sent to a server. ",
        h("a", { href: "https://github.com/jptmoore/beingdb/blob/main/docs/query-language.md", target: "_blank", rel: "noopener" }, "Query language reference"),
        ".",
      ),
    );
  }

  function openVocabulary() {
    const dialog = $("#vocabulary");
    const body = dialog.querySelector(".dialog-body");
    if (!body.childElementCount) body.append(...predicateBrowser(state.predicates));
    dialog.showModal();
  }

  function fail(message) {
    $("#status").textContent = "Failed to load";
    fill(
      $("#app"),
      h("div.message.error", h("div.message-head", h("code.badge", "load_failed")), h("p", message)),
      h("p", "Serve this directory over HTTP; opening index.html directly from disk does not work. Data from another site must be served with CORS enabled."),
    );
  }

  window.onBeingDBReady = async (BeingDB) => {
    try {
      state.BeingDB = BeingDB;
      const config = await loadConfig();
      const override = new URLSearchParams(location.search).get("data");
      const spec = override || config.data;
      if (!spec) throw new Error('No data to load: set "data" in beingdb.json, or open this page with ?data=URL');
      const url = dataUrl(spec);
      // The configured title, description and examples describe the configured data only.
      const own = !override || override === config.data;
      const title = (own && config.title) || "BeingDB";
      $("#title").textContent = title;
      document.title = title === "BeingDB" ? "BeingDB" : `${title} · BeingDB`;
      $("#status").textContent = `Loading ${url.pathname.split("/").pop() || url.href}…`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${url.href}: HTTP ${res.status}`);
      const summary = F.parse(BeingDB.load(await res.text()));
      if (summary.error) throw new Error(`${url.href}: ${summary.error.message}`);
      state.predicates = F.parse(BeingDB.predicates()).predicates || [];
      $("#status").textContent = `${summary.predicates} predicates · ${summary.facts.toLocaleString()} facts · running in your browser`;
      $("#vocab-button").disabled = false;
      $("#vocab-button").addEventListener("click", openVocabulary);
      const examples = own && Array.isArray(config.examples) ? config.examples.filter((ex) => ex && typeof ex.query === "string") : [];
      render(own ? config : {}, examples);
    } catch (e) {
      fail(String(e && e.message ? e.message : e));
    }
  };

  window.addEventListener("error", (e) => {
    if (!state.BeingDB) fail(`Could not start the BeingDB WebAssembly runtime: ${e.message}`);
  });
})();
