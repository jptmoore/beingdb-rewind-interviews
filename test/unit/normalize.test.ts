import { test } from "node:test";
import assert from "node:assert/strict";
import { AliasMap, EntityResolver, normalizeId } from "../../src/normalize.js";

test("normalizeId lowercases and underscores a plain name", () => {
  assert.equal(normalizeId("Kevin Atherton"), "kevin_atherton");
});

test("normalizeId strips apostrophes without leaving a stray underscore", () => {
  assert.equal(normalizeId("St Martin's School of Art"), "st_martins_school_of_art");
});

test("normalizeId strips accents", () => {
  assert.equal(normalizeId("Renée Zellweger"), "renee_zellweger");
});

test("normalizeId collapses punctuation and repeated separators", () => {
  assert.equal(normalizeId("Ikon  Gallery, Birmingham"), "ikon_gallery_birmingham");
});

test("normalizeId prefixes a leading digit so the result is a valid BeingDB atom", () => {
  assert.equal(normalizeId("16mm film"), "n16mm_film");
  assert.equal(normalizeId("7 monitors"), "n7_monitors");
});

test("normalizeId is deterministic", () => {
  assert.equal(normalizeId("Tape Piece"), normalizeId("Tape Piece"));
});

test("AliasMap resolves case-insensitively and ignores underscore-prefixed keys", () => {
  const aliases = new AliasMap({ _comment: "ignored", "Ikon Gallery": "ikon_gallery_birmingham" });
  assert.equal(aliases.resolve("ikon gallery"), "ikon_gallery_birmingham");
  assert.equal(aliases.resolve("IKON GALLERY"), "ikon_gallery_birmingham");
  assert.equal(aliases.resolve("_comment"), undefined);
});

test("EntityResolver reuses curated aliases across interviews", () => {
  const aliases = new AliasMap({ "Institute of Contemporary Arts": "ica_london" });
  const resolver = new EntityResolver({ aliases });
  assert.equal(resolver.resolve("Institute of Contemporary Arts"), "ica_london");
  assert.equal(resolver.resolve("ICA"), normalizeId("ICA")); // no alias for "ICA" itself in this test map
});

test("EntityResolver applies per-interview overrides ahead of aliases", () => {
  const aliases = new AliasMap({ "Kevin Atherton": "kevin_atherton_alias" });
  const resolver = new EntityResolver({ aliases, overrides: { "Kevin Atherton": "kevin_atherton" } });
  assert.equal(resolver.resolve("Kevin Atherton"), "kevin_atherton");
});

test("EntityResolver returns the same id for the same label seen twice", () => {
  const resolver = new EntityResolver({ aliases: new AliasMap({}) });
  const first = resolver.resolve("Battersea Arts Centre");
  const second = resolver.resolve("Battersea Arts Centre");
  assert.equal(first, second);
});

test("EntityResolver disambiguates two different labels that would collide, instead of merging them", () => {
  const resolver = new EntityResolver({ aliases: new AliasMap({}) });
  // Both normalize to "st_martins" style collisions when abbreviated differently in transcripts.
  const first = resolver.resolve("Central School of Art");
  const second = resolver.resolve("central school of art!!"); // normalizes identically, different label text
  assert.equal(first, "central_school_of_art");
  assert.equal(second, "central_school_of_art_2");
  assert.equal(resolver.warnings.length, 1);
});
