import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { renameAtomInText, renameAtomsInEvidence, renameAtomsInPredicates } from "../../src/reconcile.js";
import { readExistingPropositions } from "../../src/serialize.js";

function withTempDir(fn: (dir: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "beingdb-reconcile-test-"));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("renameAtomInText replaces a whole atom token", () => {
  assert.equal(
    renameAtomInText("venue(ikon_gallery_birmingham_2).", "ikon_gallery_birmingham_2", "ikon_gallery_birmingham"),
    "venue(ikon_gallery_birmingham).",
  );
});

test("renameAtomInText does not touch a longer atom that merely starts with the same prefix", () => {
  const line = "venue(ikon_gallery_birmingham_20).";
  assert.equal(renameAtomInText(line, "ikon_gallery_birmingham_2", "ikon_gallery_birmingham"), line);
});

test("renameAtomInText replaces every occurrence on a line", () => {
  assert.equal(
    renameAtomInText("collaborated_with(a_2, a_2).", "a_2", "a"),
    "collaborated_with(a, a).",
  );
});

test("renameAtomsInPredicates rewrites matching atoms and merges resulting duplicates", () => {
  withTempDir((dir) => {
    fs.writeFileSync(
      path.join(dir, "venue.pl"),
      "% header\nvenue(ikon_gallery_birmingham_2).\nvenue(ikon_gallery_birmingham_3).\nvenue(ikon_gallery_birmingham).\nvenue(acme_gallery).\n",
    );

    const results = renameAtomsInPredicates(dir, [
      ["ikon_gallery_birmingham_2", "ikon_gallery_birmingham"],
      ["ikon_gallery_birmingham_3", "ikon_gallery_birmingham"],
    ]);

    assert.equal(results.length, 1);
    assert.equal(results[0]?.mergedDuplicateCount, 2);

    const lines = readExistingPropositions(path.join(dir, "venue.pl"));
    assert.deepEqual(lines, ["venue(acme_gallery).", "venue(ikon_gallery_birmingham)."]);
  });
});

test("renameAtomsInPredicates leaves files with no matching atom untouched", () => {
  withTempDir((dir) => {
    fs.writeFileSync(path.join(dir, "person.pl"), "person(kevin_atherton).\n");
    const results = renameAtomsInPredicates(dir, [["some_other_id", "renamed"]]);
    assert.equal(results.length, 0);
  });
});

test("renameAtomsInEvidence updates fact strings that reference a renamed atom", () => {
  withTempDir((dir) => {
    const file = path.join(dir, "kevin_atherton.json");
    fs.writeFileSync(
      file,
      JSON.stringify([
        { fact: "venue(ikon_gallery_birmingham_2).", source: "kevin_atherton", evidence: "e", confidence: "explicit", page: null },
        { fact: "person(kevin_atherton).", source: "kevin_atherton", evidence: "e", confidence: "explicit", page: null },
      ]),
    );

    const results = renameAtomsInEvidence(dir, [["ikon_gallery_birmingham_2", "ikon_gallery_birmingham"]]);
    assert.equal(results.length, 1);
    assert.equal(results[0]?.changedEntryCount, 1);

    const updated = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(updated[0].fact, "venue(ikon_gallery_birmingham).");
    assert.equal(updated[1].fact, "person(kevin_atherton).");
  });
});
