import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

import {
  declarationsPathFor,
  loadDeclarations,
  loadDeclarationsFor,
  renderDeclaration,
  validateDeclarations,
} from "../../src/declarations.js";
import { mergePredicateFile, readExistingPropositions, writePropositions } from "../../src/serialize.js";
import { checkDeclarations } from "../../src/apply-declarations.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** A throwaway repo layout: <root>/predicates/ plus an optional <root>/config/predicate-declarations.json. */
function withTempRepo(declarations: unknown, fn: (predicatesDir: string) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "beingdb-declarations-test-"));
  const predicatesDir = path.join(root, "predicates");
  try {
    if (declarations !== undefined) {
      fs.mkdirSync(path.join(root, "config"));
      fs.writeFileSync(declarationsPathFor(predicatesDir), JSON.stringify(declarations), "utf8");
    }
    fn(predicatesDir);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("renderDeclaration renders roles + description, roles only, and description only", () => {
  assert.equal(
    renderDeclaration("created_by", { arguments: ["Work", "Artist"], description: "Relates a work to its maker." }),
    "%! created_by(Work, Artist)\n% Relates a work to its maker.",
  );
  assert.equal(renderDeclaration("created_by", { arguments: ["Work", "Artist"] }), "%! created_by(Work, Artist)");
  assert.equal(renderDeclaration("created_by", { description: "Relates a work to its maker." }), "%! created_by\n% Relates a work to its maker.");
  assert.equal(
    renderDeclaration("created_by", { arguments: ["Work:work", "Artist:person"] }),
    "%! created_by(Work:work, Artist:person)",
  );
});

test("validateDeclarations accepts BeingDB-valid declarations", () => {
  assert.deepEqual(
    validateDeclarations({
      created_by: { arguments: ["Work", "Artist"], description: "Relates a work to its maker." },
      work: { arguments: ["Work"] },
      year_created: { description: "Records the year a work was created." },
      typed: { arguments: ["Work:work", "Artist_2:person"] },
    }),
    [],
  );
});

test("validateDeclarations rejects declarations BeingDB would ignore", () => {
  const errors = validateDeclarations({
    "Bad-Name": { description: "x" },
    empty: {},
    lower_role: { arguments: ["work"] },
    dup_roles: { arguments: ["Work", "Work:work"] },
    bad_type: { arguments: ["Work:Work"] },
    no_args: { arguments: [] },
    multi_line: { description: "one\ntwo" },
    blank: { description: "  " },
    extra: { arguments: ["Work"], types: ["atom"] },
  });
  for (const name of ["Bad-Name", "empty", "lower_role", "dup_roles", "bad_type", "no_args", "multi_line", "blank", "extra"]) {
    assert.ok(errors.some((e) => e.startsWith(`${name}:`)), `expected an error for ${name}: ${errors.join("; ")}`);
  }
  assert.deepEqual(validateDeclarations([]), ["declarations must be a JSON object keyed by predicate name"]);
});

test("loadDeclarations treats a missing file as no declarations and throws on invalid content", () => {
  withTempRepo(undefined, (predicatesDir) => {
    assert.deepEqual(loadDeclarationsFor(predicatesDir), {});
  });
  withTempRepo({ created_by: { arguments: ["work"] } }, (predicatesDir) => {
    assert.throws(() => loadDeclarationsFor(predicatesDir), /invalid role "work"/);
  });
});

test("writePropositions emits the declaration after the header, separated by a blank line, above the facts", () => {
  const declarations = { created_by: { arguments: ["Work", "Artist"], description: "Relates a work to its maker." } };
  withTempRepo(declarations, (predicatesDir) => {
    writePropositions(predicatesDir, "created_by", ["created_by(b, y).", "created_by(a, x).", "created_by(a, x)."]);
    const text = fs.readFileSync(path.join(predicatesDir, "created_by.pl"), "utf8");
    const lines = text.split("\n");
    const sig = lines.indexOf("%! created_by(Work, Artist)");
    assert.ok(sig > 0);
    assert.equal(lines[sig - 1], "", "blank line keeps header comments out of the description");
    assert.ok(lines.slice(0, sig - 1).every((l) => l.startsWith("% ")));
    assert.equal(lines[sig + 1], "% Relates a work to its maker.");
    assert.deepEqual(lines.slice(sig + 2), ["created_by(a, x).", "created_by(b, y).", ""]);
    assert.deepEqual(readExistingPropositions(path.join(predicatesDir, "created_by.pl")), [
      "created_by(a, x).",
      "created_by(b, y).",
    ]);
  });
});

test("writePropositions omits the declaration block for undeclared predicates", () => {
  withTempRepo({ created_by: { arguments: ["Work", "Artist"] } }, (predicatesDir) => {
    writePropositions(predicatesDir, "constructor", ["constructor(x)."]);
    assert.equal(fs.readFileSync(path.join(predicatesDir, "constructor.pl"), "utf8").includes("%!"), false);
    writePropositions(predicatesDir, "person", ["person(alice)."]);
    const text = fs.readFileSync(path.join(predicatesDir, "person.pl"), "utf8");
    assert.equal(text.includes("%!"), false);
    assert.equal(text.includes("\n\n"), false);
    assert.ok(text.endsWith("% Do not hand-edit generated lines below - regenerate and review the diff instead.\nperson(alice).\n"));
  });
});

test("declarations survive a merge that regenerates the predicate file", () => {
  withTempRepo({ person: { arguments: ["Person"], description: "Marks an entity as a person." } }, (predicatesDir) => {
    mergePredicateFile(predicatesDir, "person", ["person(alice)."]);
    mergePredicateFile(predicatesDir, "person", ["person(bob)."]);
    const text = fs.readFileSync(path.join(predicatesDir, "person.pl"), "utf8");
    assert.equal(text.match(/^%! /gm)?.length, 1);
    assert.ok(text.includes("%! person(Person)\n% Marks an entity as a person.\nperson(alice).\nperson(bob).\n"));
  });
});

test("checkDeclarations reports arity mismatches, undeclared, orphaned and stale predicates", () => {
  const declarations = {
    created_by: { arguments: ["Work"] },
    person: { arguments: ["Person"] },
    gone: { description: "Merged away." },
  };
  withTempRepo(declarations, (predicatesDir) => {
    writePropositions(predicatesDir, "created_by", ["created_by(a, x)."]);
    writePropositions(predicatesDir, "person", ["person(alice)."]);
    writePropositions(predicatesDir, "work", ["work(a)."]);
    fs.writeFileSync(path.join(predicatesDir, "person.pl"), "person(alice).\n", "utf8");

    const report = checkDeclarations(predicatesDir, loadDeclarationsFor(predicatesDir));
    assert.deepEqual(report.arityMismatches, ["created_by: declares 1 argument(s) but facts have arity 2"]);
    assert.deepEqual(report.undeclared, ["work"]);
    assert.deepEqual(report.orphaned, ["gone"]);
    assert.deepEqual(report.stale, ["person"]);
  });
});

test("config/predicate-declarations.json is valid and matches the arity of every predicates/ file", () => {
  const predicatesDir = path.join(ROOT, "predicates");
  const declarations = loadDeclarations(declarationsPathFor(predicatesDir));
  const report = checkDeclarations(predicatesDir, declarations);
  assert.deepEqual(report.arityMismatches, []);
  assert.deepEqual(report.stale, [], "run `npm run declarations` to apply config/predicate-declarations.json");
});
