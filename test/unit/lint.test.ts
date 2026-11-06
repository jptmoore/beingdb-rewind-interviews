import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  checkDeclarations,
  checkMixedKinds,
  checkRetired,
  readFacts,
  retiredPredicates,
  similarAtoms,
  singleFactPredicates,
} from "../../src/lint.js";

function withTempDir(fn: (dir: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "beingdb-lint-test-"));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const facts = (entries: Record<string, string[][]>) => new Map(Object.entries(entries));

test("readFacts parses every predicate file into argument lists", () => {
  withTempDir((dir) => {
    fs.writeFileSync(path.join(dir, "created_by.pl"), "%! created_by(Work, Artist)\ncreated_by(tape_tape, kevin_atherton).\n");
    assert.deepEqual([...readFacts(dir)], [["created_by", [["tape_tape", "kevin_atherton"]]]]);
  });
});

test("retiredPredicates collects merged-away members, unless a later plan reuses the name as a canonical", () => {
  withTempDir((dir) => {
    fs.writeFileSync(path.join(dir, "01.json"), JSON.stringify({ groups: [{ canonical: "educated_at", members: ["educated_at", "studied_at"] }] }));
    fs.writeFileSync(path.join(dir, "02.json"), JSON.stringify({ groups: [{ canonical: "studied_at", members: ["trained_at"] }] }));
    assert.deepEqual([...retiredPredicates(dir)], [["trained_at", "studied_at"]]);
  });
});

test("checkRetired flags a merged-away predicate that has come back", () => {
  const errors = checkRetired(facts({ studied_at: [["a", "b"]], educated_at: [] }), new Map([["studied_at", "educated_at"]]));
  assert.deepEqual(errors, ["studied_at: merged into educated_at by a consolidation plan; use educated_at"]);
});

test("checkDeclarations requires argument roles and a description", () => {
  const errors = checkDeclarations(facts({ a: [], b: [], c: [], d: [] }), {
    b: { description: "x" },
    c: { arguments: ["X"], description: " " },
    d: { arguments: ["X"], description: "ok" },
  });
  assert.deepEqual(errors, [
    "a: no declaration in config/predicate-declarations.json",
    "b: declaration has no argument roles",
    "c: declaration has no description",
  ]);
});

test("checkMixedKinds flags a position holding both atoms and text", () => {
  const errors = checkMixedKinds(facts({ used_equipment: [["flying_time", '"Portapak"'], ["video_void", "camera"]], year_created: [["w", "@1979"]] }));
  assert.deepEqual(errors, ["used_equipment: argument 2 mixes atom and string"]);
});

test("singleFactPredicates and similarAtoms report candidates for review", () => {
  const f = facts({ created_by: [["compass", "elsa"], ["running_time", "elsa_stansfield"]], partner_of: [["a1", "b1"]] });
  assert.deepEqual(singleFactPredicates(f), ["partner_of"]);
  assert.deepEqual(similarAtoms(f), [["elsa", "elsa_stansfield"]]);
});
