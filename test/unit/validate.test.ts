import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalFactKey,
  dedupeFacts,
  filterConservative,
  isValidPredicateName,
  validateArgument,
  validateFactShape,
} from "../../src/validate.js";
import type { RawFact, ResolvedFact } from "../../src/types.js";

test("isValidPredicateName accepts snake_case lowercase names", () => {
  assert.equal(isValidPredicateName("created_by"), true);
  assert.equal(isValidPredicateName("year_created"), true);
});

test("isValidPredicateName rejects uppercase, spaces, and leading digits", () => {
  assert.equal(isValidPredicateName("CreatedBy"), false);
  assert.equal(isValidPredicateName("created by"), false);
  assert.equal(isValidPredicateName("1created"), false);
  assert.equal(isValidPredicateName(""), false);
});

test("validateArgument rejects implausible years", () => {
  assert.match(validateArgument({ kind: "year", value: 12 }) ?? "", /implausible/);
  assert.equal(validateArgument({ kind: "year", value: 1975 }), null);
});

test("validateArgument rejects malformed decimals and empty strings", () => {
  assert.match(validateArgument({ kind: "decimal", value: "abc" }) ?? "", /invalid decimal/);
  assert.equal(validateArgument({ kind: "decimal", value: "0.92" }), null);
  assert.match(validateArgument({ kind: "string", value: "" }) ?? "", /empty string/);
});

test("validateArgument rejects invalid atoms", () => {
  assert.match(validateArgument({ kind: "atom", value: "Kevin Atherton" }) ?? "", /invalid atom/);
  assert.equal(validateArgument({ kind: "atom", value: "kevin_atherton" }), null);
});

test("validateFactShape rejects malformed model output: bad predicate name", () => {
  const fact: RawFact = {
    predicate: "Created By",
    arguments: [{ kind: "atom", value: "a" }],
    evidence: "quote",
    confidence: "explicit",
    page: null,
  };
  assert.match(validateFactShape(fact) ?? "", /invalid predicate name/);
});

test("validateFactShape rejects facts with no arguments", () => {
  const fact: RawFact = { predicate: "person", arguments: [], evidence: "quote", confidence: "explicit", page: null };
  assert.match(validateFactShape(fact) ?? "", /no arguments/);
});

test("validateFactShape rejects facts with no supporting evidence", () => {
  const fact: RawFact = {
    predicate: "person",
    arguments: [{ kind: "atom", value: "kevin_atherton" }],
    evidence: "   ",
    confidence: "explicit",
    page: null,
  };
  assert.match(validateFactShape(fact) ?? "", /no supporting evidence/);
});

test("validateFactShape accepts well-formed facts", () => {
  const fact: RawFact = {
    predicate: "year_created",
    arguments: [
      { kind: "atom", value: "tape_tape" },
      { kind: "year", value: 1975 },
    ],
    evidence: "I made Tape Tape in 1975",
    confidence: "explicit",
    page: 6,
  };
  assert.equal(validateFactShape(fact), null);
});

test("canonicalFactKey is type-sensitive (integer vs year vs string of the same digits)", () => {
  const a = canonicalFactKey("value", [{ kind: "atom", value: "x" }, { kind: "integer", value: 1979 }]);
  const b = canonicalFactKey("value", [{ kind: "atom", value: "x" }, { kind: "year", value: 1979 }]);
  const c = canonicalFactKey("value", [{ kind: "atom", value: "x" }, { kind: "string", value: "1979" }]);
  assert.notEqual(a, b);
  assert.notEqual(b, c);
  assert.notEqual(a, c);
});

function fact(predicate: string, args: ResolvedFact["arguments"], overrides: Partial<ResolvedFact> = {}): ResolvedFact {
  return { predicate, arguments: args, evidence: "quote", confidence: "explicit", page: null, sourceId: "test", ...overrides };
}

test("filterConservative drops uncertain facts and keeps explicit/supported ones", () => {
  const facts: ResolvedFact[] = [
    fact("person", [{ kind: "atom", value: "a" }], { confidence: "explicit" }),
    fact("person", [{ kind: "atom", value: "b" }], { confidence: "supported" }),
    fact("person", [{ kind: "atom", value: "c" }], { confidence: "uncertain" }),
  ];
  const { kept, dropped } = filterConservative(facts);
  assert.equal(kept.length, 2);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0]?.reason, "confidence=uncertain");
});

test("dedupeFacts removes exact duplicates but keeps distinct facts", () => {
  const facts: ResolvedFact[] = [
    fact("created_by", [{ kind: "atom", value: "tape_tape" }, { kind: "atom", value: "kevin_atherton" }]),
    fact("created_by", [{ kind: "atom", value: "tape_tape" }, { kind: "atom", value: "kevin_atherton" }]),
    fact("created_by", [{ kind: "atom", value: "other_work" }, { kind: "atom", value: "kevin_atherton" }]),
  ];
  const deduped = dedupeFacts(facts);
  assert.equal(deduped.length, 2);
});
