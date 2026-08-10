# BeingDB REWIND Interviews

A reproducible dataset of structured [BeingDB](https://github.com/jptmoore/beingdb)
facts extracted from curated artist interviews, starting with the
[REWIND](https://rewind.ac.uk/) video-art archive.

This repository is both:

1. **A small TypeScript pipeline** that downloads a curated interview PDF,
   extracts its text, and calls the OpenAI API to propose conservative,
   evidenced factual assertions.
2. **A directly cloneable BeingDB fact repository** - the `predicates/`
   directory at the repository root is exactly what `beingdb-clone` /
   `beingdb-compile` expect (see ["How to use with BeingDB"](#how-to-use-with-beingdb)).

## Why it exists

This dataset exists to test whether a small, constrained, factual-retrieval
layer (BeingDB) can support grounded LLM question-answering about real
artists' interviews, without needing a separate text-search/embeddings
backend. It is deliberately narrow: a curated set of interviews, a
conservative extraction prompt, and a fixed set of typed predicates - not a
general-purpose crawler or a knowledge-graph framework.

## Research status

**Generated facts are derived from interview sources by a language model and
must be treated as a research artifact, not verified catalogue metadata.**
Every fact is extracted conservatively (see below) and comes with supporting
evidence recorded in `metadata/evidence/`, but it has not been independently
fact-checked against primary/archival sources. Review the Git diff produced
by `npm run extract` before committing, the same way you would review any
other generated code.

## Repository layout

```
.
├── README.md
├── package.json
├── tsconfig.json
├── .gitignore
├── .env.example
│
├── config/
│   ├── interviews.json        # curated list of interview sources (human-edited)
│   └── entity-aliases.json    # cross-interview entity ID overrides (human-edited)
│
├── src/                       # pipeline source code
│   ├── index.ts               # CLI entrypoint (npm run extract)
│   ├── fetch-source.ts        # download a configured URL
│   ├── extract-text.ts        # PDF -> plain text (embedded text layer only)
│   ├── generate-facts.ts      # chunking + OpenAI structured-output calls
│   ├── prompts.ts             # the conservative extraction prompt
│   ├── normalize.ts           # stable atom IDs, aliasing, collision handling
│   ├── validate.ts            # structural validation, conservative filtering, dedup
│   ├── serialize.ts           # typed literals -> BeingDB syntax, predicate-file merge
│   ├── metadata.ts            # provenance + evidence sidecar files
│   └── types.ts
│
├── source/                    # cached PDFs/extracted text (gitignored - see below)
│
├── predicates/                 # <-- BeingDB compile root (one file per predicate)
│   ├── document.pl
│   ├── source_url.pl
│   ├── interviewee.pl
│   ├── person.pl
│   ├── work.pl
│   ├── created_by.pl
│   ├── year_created.pl
│   └── ...
│
├── metadata/
│   ├── extraction.json        # provenance: URL, checksum, model, timestamp, warnings
│   └── evidence/<id>.json     # per-interview fact -> supporting quote sidecars
│
└── test/
    ├── unit/                  # no network/API calls
    └── integration/           # live OpenAI calls (npm run test:integration)
```

### Why facts live under `predicates/`, not `facts/artists/`

BeingDB's actual Git-repository convention (see
[`beingdb` docs/getting-started.md](https://github.com/jptmoore/beingdb/blob/main/docs/getting-started.md#repository-structure))
requires one file per **predicate name** directly under `predicates/` at the
repository root - e.g. `predicates/created_by.pl` containing every
`created_by(...)` fact from every artist, not one file per artist. This is
what makes cross-artist joins work at all (`created_by(Work, Artist),
affiliated_with(Artist, Org)` needs every artist's facts in the same
`affiliated_with.pl`). This repository follows that convention rather than
inventing an incompatible layout: extraction merges each artist's new facts
into the shared per-predicate files, deduplicating and sorting so
regeneration produces a clean, minimal Git diff.

### Why `source/` is gitignored

`source/` caches the downloaded PDF and its extracted plain text so a run
can be inspected or re-processed without re-fetching. It is **not** committed:
interview transcripts are copyrighted source material, not pipeline output.
Reproducibility instead comes from `metadata/extraction.json`, which records
the source URL and a SHA-256 checksum of the extracted text - anyone can
re-fetch the same URL and verify the checksum matches.

## How to regenerate facts

```bash
npm install
cp .env.example .env
# edit .env: set OPENAI_API_KEY and OPENAI_MODEL (e.g. gpt-4.1)

npm run extract                          # every interview in config/interviews.json
npm run extract -- --artist kevin_atherton   # a single interview
```

This fetches the source, extracts its text, calls OpenAI for structured
candidate facts, validates and conservatively filters them, and merges the
result into `predicates/*.pl`, plus updates `metadata/extraction.json` and
`metadata/evidence/<id>.json`.

**Review before committing.** Nothing is destructive - rerunning only adds or
preserves lines - but always read the `git diff` on `predicates/` before
committing, the same as any other generated artifact:

```
source interview -> generated candidate facts -> human review (git diff) -> commit -> BeingDB compile
```

### Adding a new interview

Add an entry to `config/interviews.json`:

```json
{
  "id": "jane_doe",
  "name": "Jane Doe",
  "url": "https://rewind.ac.uk/.../JDOE123.pdf",
  "documentId": "rewind_jane_doe_interview",
  "personId": "jane_doe"
}
```

`documentId` and `personId` are optional (they default to
`${id}_interview` and a normalized form of `name`), but setting `personId`
explicitly is recommended if the artist might already exist under a
different atom from another interview. Cross-interview entity aliases
(institutions, venues that recur across artists) belong in
`config/entity-aliases.json`; per-interview one-off overrides go in that
interview's own `idOverrides`.

### Fixing an entity-id collision without re-running the AI pipeline

If `metadata/extraction.json` shows an `entity id collision` warning (e.g.
"Ikon Gallery" and "Ikon Gallery, Birmingham" got assigned
`ikon_gallery_birmingham` and `ikon_gallery_birmingham_2`), it usually means
one label is missing from `config/entity-aliases.json`. Fixing it doesn't
require another (paid) extraction run:

1. Add the missing alias so *future* runs resolve correctly:
   ```json
   "Ikon Gallery, Birmingham": "ikon_gallery_birmingham"
   ```
2. Rewrite the *already-generated* files in place with `npm run reconcile`,
   which only renames atoms already on disk (`predicates/*.pl` and
   `metadata/evidence/*.json`) and merges any facts that become duplicates -
   no OpenAI calls involved:
   ```bash
   npm run reconcile -- ikon_gallery_birmingham_2=ikon_gallery_birmingham
   ```
3. Review the resulting `git diff` as usual before committing.

`metadata/extraction.json`'s `warnings` field is left as-is by `reconcile` -
it's a historical log of what a specific run produced, not a live index.

## How to use with BeingDB

This repository *is* a BeingDB facts repository. Using the real
[BeingDB CLI](https://github.com/jptmoore/beingdb):

```bash
beingdb-clone https://github.com/<owner>/beingdb-rewind-interviews.git --git ./git_store
beingdb-compile --git ./git_store --pack ./pack_store
beingdb-serve --pack ./pack_store
```

```bash
curl -X POST http://localhost:8080/query \
  -d '{"query": "created_by(Work, kevin_atherton)"}'
```

An optional local check, if you have `beingdb`/`beingdb-clone` installed,
compiles this working tree directly with the real BeingDB parser (rather
than re-implementing its grammar here):

```bash
npm run validate:beingdb
```

## Example configured interview

```json
{
  "id": "kevin_atherton",
  "name": "Kevin Atherton",
  "url": "https://rewind.ac.uk/rewind/wp-content/uploads/sites/146/2021/03/KAT510.pdf",
  "documentId": "rewind_kevin_atherton_interview",
  "personId": "kevin_atherton"
}
```

## Example generated facts

The pipeline always asserts a small set of curated, certain provenance facts
per interview (never inferred by the model), plus whatever conservative
facts the model extracts from the transcript with supporting evidence:

```prolog
% predicates/document.pl
document(rewind_kevin_atherton_interview).

% predicates/source_url.pl
source_url(rewind_kevin_atherton_interview, "https://rewind.ac.uk/rewind/wp-content/uploads/sites/146/2021/03/KAT510.pdf").

% predicates/interviewee.pl
interviewee(rewind_kevin_atherton_interview, kevin_atherton).

% predicates/person.pl
person(kevin_atherton).

% predicates/work.pl
work(tape_tape).

% predicates/created_by.pl
created_by(tape_tape, kevin_atherton).

% predicates/year_created.pl
year_created(tape_tape, @1975).

% predicates/venue.pl
venue(battersea_arts_centre).

% predicates/made_at.pl
made_at(tape_tape, battersea_arts_centre).

% predicates/uses_medium.pl
uses_medium(tape_tape, video).
```

**Note:** `predicates/` is intentionally empty in this checkout (no
`OPENAI_API_KEY` was available while building this pipeline) - the block
above illustrates the expected *format* of a regeneration, not facts that
have actually been generated and reviewed yet. Run `npm run extract` with a
real API key to populate it for real, then review the diff before
committing.

Each kept fact also gets a sidecar evidence entry, e.g.
`metadata/evidence/kevin_atherton.json`:

```json
{
  "fact": "year_created(tape_tape, @1975).",
  "source": "kevin_atherton",
  "evidence": "I made Tape Tape in 1975...",
  "confidence": "explicit",
  "page": 6
}
```

## Key design decisions

- **Structured output, not raw `.facts` text.** The model returns typed
  JSON (`entities` + `facts`, each fact tagged with a typed argument list,
  evidence quote, and confidence) validated in TypeScript; only validated
  facts are ever serialized into BeingDB syntax (`src/generate-facts.ts`,
  `src/validate.ts`, `src/serialize.ts`).
- **Conservative by construction.** The prompt (`src/prompts.ts`) explicitly
  separates explicit statements from opinion/interpretation/uncertainty, and
  any fact tagged `confidence: "uncertain"` is dropped, never asserted
  (`filterConservative` in `src/validate.ts`).
- **No OCR.** `src/extract-text.ts` only reads a PDF's embedded text layer
  and fails loudly (rather than silently producing empty/garbage facts) if a
  source has too little extractable text.
- **Deterministic, collision-aware IDs.** `src/normalize.ts` normalizes
  labels predictably, but a curated `config/entity-aliases.json` plus
  per-interview `idOverrides` take priority, and two different labels that
  would otherwise collide onto the same atom are automatically disambiguated
  (with a recorded warning) instead of silently merged.
- **Merge into shared per-predicate files.** Facts are grouped by predicate
  and merged into `predicates/<name>.pl` across all artists (deduplicated,
  sorted, whitespace-normalized) so cross-artist queries work and
  regeneration produces a small, stable diff - matching BeingDB's own
  repository convention rather than a per-artist file layout.
- **Provenance is a sidecar, not a fact-level model.** `document()`,
  `source_url()`, and `interviewee()` facts are the only provenance
  encoded in BeingDB itself; checksums, timestamps, model IDs, and
  per-fact evidence quotes live in `metadata/`, outside the query model, so
  the compiled dataset stays simple to query.

## Tests

```bash
npm test               # unit tests, no network/API calls
npm run test:integration   # live OpenAI calls; requires .env; explicit opt-in
```

Unit tests cover: atom-ID normalization (incl. accents, punctuation,
apostrophes), shared entity aliasing and per-interview overrides, collision
disambiguation, BeingDB literal serialization (incl. quoted-string escaping),
deterministic sorting, malformed model output rejection, duplicate removal,
extraction-metadata generation, and the offline atom-rename/reconcile tool.
See `test/unit/`.

## Limitations and assumptions

- Only PDF sources with an embedded text layer are supported; scanned PDFs
  without one are rejected rather than OCR'd.
- Long interviews are chunked by paragraph boundaries before being sent to
  the model (`src/generate-facts.ts`); very long individual paragraphs are
  hard-split. Chunk boundaries are never visible in the final facts, but a
  fact that depends on context split across chunks may be missed.
- Entity resolution is heuristic outside of the curated alias/override
  files: it can still occasionally produce a different atom for the same
  real-world entity across two interviews (under-merging) or, more rarely,
  the same atom for two different smaller entities that happen to share a
  normalized label without being caught as a collision (over-merging). Both
  are mitigated, not eliminated, by `config/entity-aliases.json` and
  per-interview `idOverrides`.
- The pipeline trusts the model's `confidence` self-assessment as a first
  filter; it does not independently re-verify explicit-looking claims
  against outside sources. Treat generated facts as review-pending, per
  ["Research status"](#research-status) above.
- No pipeline in this repository has actually been run end-to-end against a
  real interview and committed (see the note under ["Example generated
  facts"](#example-generated-facts)) - `fetch-source.ts`/`extract-text.ts`
  have been smoke-tested against the real Kevin Atherton PDF, but full
  extraction requires an `OPENAI_API_KEY` that was not available while
  building this repository.
