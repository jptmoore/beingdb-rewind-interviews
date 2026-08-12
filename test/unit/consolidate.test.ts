import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { applyGroup, buildCatalog, validateGroup } from "../../src/consolidate.js";
import { readExistingPropositions } from "../../src/serialize.js";
import type { ConsolidationGroup, PredicateCatalogEntry } from "../../src/types.js";

function withTempDir(fn: (dir: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "beingdb-consolidate-test-"));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("buildCatalog summarizes arity, argument kinds, fact count, and samples", () => {
  withTempDir((dir) => {
    fs.writeFileSync(
      path.join(dir, "employed_by.pl"),
      "employed_by(kevin_atherton, slade).\nemployed_by(kevin_atherton, chelsea).\n",
    );
    fs.writeFileSync(path.join(dir, "person.pl"), "person(kevin_atherton).\n");

    const catalog = buildCatalog(dir);
    assert.deepEqual(
      catalog.map((c) => c.name),
      ["employed_by", "person"],
    );
    const employedBy = catalog.find((c) => c.name === "employed_by")!;
    assert.equal(employedBy.arity, 2);
    assert.deepEqual(employedBy.argumentKinds, [["atom"], ["atom"]]);
    assert.equal(employedBy.factCount, 2);
    assert.equal(employedBy.samples.length, 2);
  });
});

test("buildCatalog skips predicate files with no facts", () => {
  withTempDir((dir) => {
    fs.writeFileSync(path.join(dir, "empty.pl"), "% just a header\n");
    assert.deepEqual(buildCatalog(dir), []);
  });
});

function catalogEntry(name: string, arity: number): PredicateCatalogEntry {
  return { name, arity, argumentKinds: Array.from({ length: arity }, () => ["atom"]), factCount: 1, samples: [] };
}

test("validateGroup rejects fewer than 2 distinct members", () => {
  const catalogByName = new Map([["employed_by", catalogEntry("employed_by", 2)]]);
  const group: ConsolidationGroup = { canonical: "employed_by", members: ["employed_by", "employed_by"], rationale: "" };
  const result = validateGroup(group, catalogByName, new Set());
  assert.equal(result.ok, false);
});

test("validateGroup rejects a canonical name that is not one of the members", () => {
  const catalogByName = new Map([
    ["employed_by", catalogEntry("employed_by", 2)],
    ["worked_for", catalogEntry("worked_for", 2)],
  ]);
  const group: ConsolidationGroup = { canonical: "works_for", members: ["employed_by", "worked_for"], rationale: "" };
  const result = validateGroup(group, catalogByName, new Set());
  assert.deepEqual(result, { ok: false, reason: "canonical name is not one of the members" });
});

test("validateGroup rejects unknown predicates", () => {
  const catalogByName = new Map([["employed_by", catalogEntry("employed_by", 2)]]);
  const group: ConsolidationGroup = { canonical: "employed_by", members: ["employed_by", "made_up"], rationale: "" };
  const result = validateGroup(group, catalogByName, new Set());
  assert.equal(result.ok, false);
});

test("validateGroup rejects members with mismatched arity", () => {
  const catalogByName = new Map([
    ["employed_by", catalogEntry("employed_by", 2)],
    ["person", catalogEntry("person", 1)],
  ]);
  const group: ConsolidationGroup = { canonical: "employed_by", members: ["employed_by", "person"], rationale: "" };
  const result = validateGroup(group, catalogByName, new Set());
  assert.equal(result.ok, false);
});

test("validateGroup rejects a member already claimed by an earlier group in the same run", () => {
  const catalogByName = new Map([
    ["employed_by", catalogEntry("employed_by", 2)],
    ["worked_for", catalogEntry("worked_for", 2)],
  ]);
  const group: ConsolidationGroup = { canonical: "employed_by", members: ["employed_by", "worked_for"], rationale: "" };
  const result = validateGroup(group, catalogByName, new Set(["worked_for"]));
  assert.equal(result.ok, false);
});

test("validateGroup accepts a well-formed group", () => {
  const catalogByName = new Map([
    ["employed_by", catalogEntry("employed_by", 2)],
    ["worked_for", catalogEntry("worked_for", 2)],
  ]);
  const group: ConsolidationGroup = { canonical: "employed_by", members: ["employed_by", "worked_for"], rationale: "" };
  assert.deepEqual(validateGroup(group, catalogByName, new Set()), { ok: true });
});

test("applyGroup merges facts under the canonical predicate name and deletes the other files", () => {
  withTempDir((dir) => {
    fs.writeFileSync(path.join(dir, "employed_by.pl"), "employed_by(kevin_atherton, slade).\n");
    fs.writeFileSync(path.join(dir, "worked_for.pl"), "worked_for(kevin_atherton, chelsea).\nworked_for(kevin_atherton, slade).\n");

    const group: ConsolidationGroup = {
      canonical: "employed_by",
      members: ["employed_by", "worked_for"],
      rationale: "same relationship",
    };
    const result = applyGroup(dir, path.join(dir, "evidence"), group);

    assert.deepEqual(result.mergedFrom, ["worked_for"]);
    assert.deepEqual(result.factsBefore, { employed_by: 1, worked_for: 2 });
    assert.equal(result.factsAfter, 2); // employed_by(...,slade) was a duplicate across both files
    assert.equal(fs.existsSync(path.join(dir, "worked_for.pl")), false);

    const lines = readExistingPropositions(path.join(dir, "employed_by.pl"));
    assert.deepEqual(lines, ["employed_by(kevin_atherton, chelsea).", "employed_by(kevin_atherton, slade)."]);
  });
});

test("applyGroup updates evidence sidecars for merged-away predicates", () => {
  withTempDir((dir) => {
    const predicatesDir = path.join(dir, "predicates");
    const evidenceDir = path.join(dir, "evidence");
    fs.mkdirSync(predicatesDir, { recursive: true });
    fs.mkdirSync(evidenceDir, { recursive: true });
    fs.writeFileSync(path.join(predicatesDir, "employed_by.pl"), "employed_by(kevin_atherton, slade).\n");
    fs.writeFileSync(path.join(predicatesDir, "worked_for.pl"), "worked_for(kevin_atherton, chelsea).\n");
    fs.writeFileSync(
      path.join(evidenceDir, "kevin_atherton.json"),
      JSON.stringify([
        { fact: "worked_for(kevin_atherton, chelsea).", source: "kevin_atherton", evidence: "e", confidence: "explicit", page: null },
      ]),
    );

    applyGroup(predicatesDir, evidenceDir, { canonical: "employed_by", members: ["employed_by", "worked_for"], rationale: "" });

    const evidence = JSON.parse(fs.readFileSync(path.join(evidenceDir, "kevin_atherton.json"), "utf8"));
    assert.equal(evidence[0].fact, "employed_by(kevin_atherton, chelsea).");
  });
});
