import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  classifyLiteral,
  establishedKinds,
  parseProposition,
  reconcileArgumentKinds,
  splitArguments,
  unquoteStringLiteral,
} from "../../src/type-consistency.js";
import type { FactArgument } from "../../src/types.js";

test("classifyLiteral identifies each BeingDB literal kind", () => {
  assert.equal(classifyLiteral("kevin_atherton"), "atom");
  assert.equal(classifyLiteral('"Tape Tape"'), "string");
  assert.equal(classifyLiteral("@1975"), "year");
  assert.equal(classifyLiteral("true"), "boolean");
  assert.equal(classifyLiteral("false"), "boolean");
  assert.equal(classifyLiteral("0.92"), "decimal");
  assert.equal(classifyLiteral("-3"), "integer");
  assert.equal(classifyLiteral("42"), "integer");
});

test("splitArguments respects commas inside quoted strings", () => {
  assert.deepEqual(splitArguments('jan_van_eyck_academy, "Maastricht, Netherlands"'), [
    "jan_van_eyck_academy",
    '"Maastricht, Netherlands"',
  ]);
});

test("unquoteStringLiteral reverses BeingDB string escaping", () => {
  assert.equal(unquoteStringLiteral('"Tape Tape"'), "Tape Tape");
  assert.equal(unquoteStringLiteral('"He said \\"hi\\""'), 'He said "hi"');
  assert.equal(unquoteStringLiteral("kevin_atherton"), "kevin_atherton");
});

test("parseProposition extracts predicate name and argument literals", () => {
  assert.deepEqual(parseProposition('created_by(tape_tape, kevin_atherton).'), {
    predicate: "created_by",
    args: ["tape_tape", "kevin_atherton"],
  });
  assert.equal(parseProposition("not a fact"), null);
});

function withTempDir(fn: (dir: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "beingdb-type-consistency-test-"));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("establishedKinds reports the set of kinds seen per argument position", () => {
  withTempDir((dir) => {
    fs.writeFileSync(
      path.join(dir, "affiliated_with.pl"),
      'affiliated_with(anna_ridley, analogue).\naffiliated_with(jan_van_eyck_academy, "Maastricht, Netherlands").\n',
    );
    const kinds = establishedKinds(dir, "affiliated_with");
    assert.deepEqual([...kinds.get(0)!], ["atom"]);
    assert.deepEqual([...kinds.get(1)!].sort(), ["atom", "string"]);
  });
});

test("establishedKinds returns an empty map for a predicate with no existing file", () => {
  withTempDir((dir) => {
    const kinds = establishedKinds(dir, "nonexistent");
    assert.equal(kinds.size, 0);
  });
});

function stringArg(value: string): FactArgument {
  return { kind: "string", value };
}
function atomArg(value: string): FactArgument {
  return { kind: "atom", value };
}

test("reconcileArgumentKinds coerces a string to an atom where an atom precedent exists", () => {
  const established = new Map<number, Set<FactArgument["kind"]>>([[1, new Set(["atom"])]]);
  const { arguments: args, warnings } = reconcileArgumentKinds(
    "affiliated_with",
    [atomArg("jan_van_eyck_academy"), stringArg("Maastricht, Netherlands")],
    established,
    (label) => label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, ""),
  );
  assert.deepEqual(args[1], { kind: "atom", value: "maastricht_netherlands" });
  assert.equal(warnings.length, 1);
});

test("reconcileArgumentKinds leaves long, sentence-like strings alone", () => {
  const longValue = "a".repeat(80);
  const established = new Map<number, Set<FactArgument["kind"]>>([[1, new Set(["atom"])]]);
  const { arguments: args, warnings } = reconcileArgumentKinds(
    "affiliated_with",
    [atomArg("x"), stringArg(longValue)],
    established,
    (label) => label,
  );
  assert.deepEqual(args[1], stringArg(longValue));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /looks like free text/);
});

test("reconcileArgumentKinds does nothing when there is no atom precedent at that position", () => {
  const established = new Map<number, Set<FactArgument["kind"]>>([[1, new Set(["string"])]]);
  const { arguments: args, warnings } = reconcileArgumentKinds(
    "description",
    [atomArg("x"), stringArg("a free-text description")],
    established,
    (label) => label,
  );
  assert.deepEqual(args[1], stringArg("a free-text description"));
  assert.equal(warnings.length, 0);
});
