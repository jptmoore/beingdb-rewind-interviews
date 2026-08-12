import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  classifyLiteral,
  establishedKinds,
  fixPredicateFileTypes,
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

test("reconcileArgumentKinds signals drop for long, sentence-like strings that conflict with an atom precedent", () => {
  const longValue = "a".repeat(80);
  const established = new Map<number, Set<FactArgument["kind"]>>([[1, new Set(["atom"])]]);
  const { arguments: args, warnings, drop } = reconcileArgumentKinds(
    "affiliated_with",
    [atomArg("x"), stringArg(longValue)],
    established,
    (label) => label,
  );
  assert.equal(drop, true);
  assert.deepEqual(args[1], stringArg(longValue));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /can't be safely coerced/);
});

test("reconcileArgumentKinds signals drop when a string conflicts with a non-atom established type (e.g. year)", () => {
  const established = new Map<number, Set<FactArgument["kind"]>>([[1, new Set(["year"])]]);
  const { warnings, drop } = reconcileArgumentKinds(
    "year_created",
    [atomArg("time_spent"), stringArg("while at Royal College")],
    established,
    (label) => label,
  );
  assert.equal(drop, true);
  assert.match(warnings[0]!, /conflicts with established type\(s\) \[year\]/);
});

test("reconcileArgumentKinds does nothing when there is no atom precedent at that position", () => {
  const established = new Map<number, Set<FactArgument["kind"]>>([[1, new Set(["string"])]]);
  const { arguments: args, warnings, drop } = reconcileArgumentKinds(
    "description",
    [atomArg("x"), stringArg("a free-text description")],
    established,
    (label) => label,
  );
  assert.deepEqual(args[1], stringArg("a free-text description"));
  assert.equal(warnings.length, 0);
  assert.equal(drop, false);
});

test("fixPredicateFileTypes coerces a short conflicting string to an atom", () => {
  withTempDir((dir) => {
    fs.writeFileSync(
      dir + "/venue.pl",
      'venue(battersea_arts_centre).\nvenue("Ikon Gallery").\n',
    );
    const result = fixPredicateFileTypes(dir, "venue", (label) =>
      label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, ""),
    );
    assert.ok(result);
    assert.equal(result!.droppedLines.length, 0);
    assert.deepEqual(result!.renamedLines, [['venue("Ikon Gallery").', "venue(ikon_gallery)."]]);
  });
});

test("fixPredicateFileTypes drops a fact whose string conflicts with a non-atom established type", () => {
  withTempDir((dir) => {
    fs.writeFileSync(
      dir + "/year_created.pl",
      'year_created(tape_tape, @1975).\nyear_created(time_spent, "while at Royal College").\n',
    );
    const result = fixPredicateFileTypes(dir, "year_created", (label) => label);
    assert.ok(result);
    assert.equal(result!.renamedLines.length, 0);
    assert.equal(result!.droppedLines.length, 1);
    assert.equal(result!.droppedLines[0]!.line, 'year_created(time_spent, "while at Royal College").');

    const remaining = fs.readFileSync(dir + "/year_created.pl", "utf8");
    assert.equal(remaining.includes("time_spent"), false);
    assert.equal(remaining.includes("tape_tape"), true);
  });
});

test("fixPredicateFileTypes drops a long, sentence-like string that conflicts with an atom-typed position", () => {
  withTempDir((dir) => {
    const longEvidence = "visit to Hiroshima and the connection of the monitor sending out electro-magnetic radiation";
    fs.writeFileSync(
      dir + "/influenced_by.pl",
      `influenced_by(peter_donebauer, kandinsky).\ninfluenced_by(museum_of_memory_1, "${longEvidence}").\n`,
    );
    const result = fixPredicateFileTypes(dir, "influenced_by", (label) => label);
    assert.ok(result);
    assert.equal(result!.droppedLines.length, 1);
    assert.match(result!.droppedLines[0]!.reason, /can't be safely coerced/);
  });
});

test("fixPredicateFileTypes returns null when there is nothing to fix", () => {
  withTempDir((dir) => {
    fs.writeFileSync(dir + "/person.pl", "person(kevin_atherton).\n");
    assert.equal(fixPredicateFileTypes(dir, "person", (label) => label), null);
  });
});
