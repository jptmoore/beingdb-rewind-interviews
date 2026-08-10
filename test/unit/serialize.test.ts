import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  factToProposition,
  groupFactsByPredicate,
  literalToString,
  mergePredicateFile,
  readExistingPropositions,
  writeFactsToPredicates,
} from "../../src/serialize.js";
import type { ResolvedFact } from "../../src/types.js";

test("literalToString renders every typed literal per BeingDB syntax", () => {
  assert.equal(literalToString({ kind: "atom", value: "kevin_atherton" }), "kevin_atherton");
  assert.equal(literalToString({ kind: "string", value: "Tape Tape" }), '"Tape Tape"');
  assert.equal(literalToString({ kind: "year", value: 1975 }), "@1975");
  assert.equal(literalToString({ kind: "integer", value: 42 }), "42");
  assert.equal(literalToString({ kind: "decimal", value: "0.92" }), "0.92");
  assert.equal(literalToString({ kind: "boolean", value: true }), "true");
  assert.equal(literalToString({ kind: "boolean", value: false }), "false");
});

test("literalToString escapes embedded quotes and backslashes in strings", () => {
  assert.equal(literalToString({ kind: "string", value: 'He said "hi"' }), '"He said \\"hi\\""');
  assert.equal(literalToString({ kind: "string", value: "C:\\path" }), '"C:\\\\path"');
});

test("factToProposition always ends with a period and one fact per line", () => {
  const line = factToProposition("created_by", [
    { kind: "atom", value: "tape_tape" },
    { kind: "atom", value: "kevin_atherton" },
  ]);
  assert.equal(line, "created_by(tape_tape, kevin_atherton).");
  assert.equal(line.endsWith("."), true);
  assert.equal(line.includes("\n"), false);
});

test("groupFactsByPredicate groups and sorts predicate names deterministically", () => {
  const facts: ResolvedFact[] = [
    { predicate: "work", arguments: [{ kind: "atom", value: "b" }], evidence: "e", confidence: "explicit", page: null, sourceId: "s" },
    { predicate: "created_by", arguments: [{ kind: "atom", value: "a" }, { kind: "atom", value: "p" }], evidence: "e", confidence: "explicit", page: null, sourceId: "s" },
  ];
  const groups = groupFactsByPredicate(facts);
  assert.deepEqual([...groups.keys()], ["created_by", "work"]);
});

function withTempDir(fn: (dir: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "beingdb-serialize-test-"));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("mergePredicateFile creates a new file with sorted, deduplicated lines", () => {
  withTempDir((dir) => {
    const result = mergePredicateFile(dir, "person", ["person(bob).", "person(alice).", "person(alice)."]);
    assert.equal(result.totalCount, 2);
    assert.equal(result.addedCount, 2);
    const lines = readExistingPropositions(path.join(dir, "person.pl"));
    assert.deepEqual(lines, ["person(alice).", "person(bob)."]);
  });
});

test("mergePredicateFile preserves facts from a previous run and only adds new ones", () => {
  withTempDir((dir) => {
    mergePredicateFile(dir, "person", ["person(alice)."]);
    const second = mergePredicateFile(dir, "person", ["person(bob)."]);
    assert.equal(second.addedCount, 1);
    assert.equal(second.totalCount, 2);
    const lines = readExistingPropositions(path.join(dir, "person.pl"));
    assert.deepEqual(lines, ["person(alice).", "person(bob)."]);
  });
});

test("mergePredicateFile is idempotent: regenerating identical facts changes nothing", () => {
  withTempDir((dir) => {
    mergePredicateFile(dir, "person", ["person(alice)."]);
    const before = fs.readFileSync(path.join(dir, "person.pl"), "utf8");
    mergePredicateFile(dir, "person", ["person(alice)."]);
    const after = fs.readFileSync(path.join(dir, "person.pl"), "utf8");
    assert.equal(before, after);
  });
});

test("writeFactsToPredicates writes one file per predicate", () => {
  withTempDir((dir) => {
    const facts: ResolvedFact[] = [
      { predicate: "person", arguments: [{ kind: "atom", value: "kevin_atherton" }], evidence: "e", confidence: "explicit", page: null, sourceId: "s" },
      { predicate: "work", arguments: [{ kind: "atom", value: "tape_tape" }], evidence: "e", confidence: "explicit", page: null, sourceId: "s" },
    ];
    const results = writeFactsToPredicates(dir, facts);
    assert.equal(results.length, 2);
    assert.equal(fs.existsSync(path.join(dir, "person.pl")), true);
    assert.equal(fs.existsSync(path.join(dir, "work.pl")), true);
  });
});
