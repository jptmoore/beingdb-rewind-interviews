# BeingDB REWIND Interviews

A structured, [BeingDB](https://github.com/jptmoore/beingdb)-queryable dataset
of facts extracted from curated artist interviews, built as a companion
dataset for experiments in grounded LLM question-answering. The first source
is [REWIND](https://rewind.ac.uk/), an archive of interviews with British and
international video artists.

## What this is

A small, auditable pipeline (TypeScript + the OpenAI API) that turns a
curated list of interview PDFs into typed, evidenced BeingDB facts, plus the
generated facts themselves. The repository is both the code and the data:
clone it, and `predicates/` is a ready-to-compile BeingDB fact repository.

```
curated interview URLs -> PDF text extraction -> LLM extraction (structured output)
                        -> validation & conservative filtering -> predicates/*.pl
```

## Why it exists

BeingDB stores facts as simple typed predicates in Git and compiles them into
a queryable store. This project tests whether that kind of small, explicit
factual layer - as opposed to embeddings or full-text search - can ground an
LLM's answers about a body of interviews in specific, checkable statements
("who made what, where, when, with whom") rather than free-text retrieval.

## Research status

Facts are extracted by a language model from primary-source interview text
and are a **research artifact, not verified catalogue metadata**. Extraction
is deliberately conservative (see "How extraction works" below) and every
fact is recorded with a supporting quote in `metadata/evidence/`, but nothing
here has been independently fact-checked. Treat it the way you would treat
any other model output cited in a paper: as data to be reviewed, not ground
truth.

## Quick start

```bash
npm install
cp .env.example .env        # set OPENAI_API_KEY and OPENAI_MODEL

npm run extract                              # only interviews not yet extracted
npm run extract -- --artist kevin_atherton   # (re)process a single interview
npm run extract -- --force                   # re-run every configured interview
```

This downloads the configured PDF, extracts its text, sends it to the model
in chunks, validates and filters the result, and merges the resulting facts
into `predicates/*.pl`. Regeneration is non-destructive - review the `git
diff` before committing, the same as any other generated code.

Without `--artist` or `--force`, interviews that already have an entry in
`metadata/extraction.json` are skipped, so adding one new interview to
`config/interviews.json` and running `npm run extract` only calls the model
for that new interview - it never re-processes ones you've already run.

To add an interview, add an entry to `config/interviews.json`:

```json
{ "id": "jane_doe", "name": "Jane Doe", "url": "https://rewind.ac.uk/.../JDOE123.pdf" }
```

Other useful commands:

```bash
npm run show-prompt        # print the exact prompt sent to the model
npm run consolidate        # merge semantically-duplicate predicates (see below)
npm test                   # unit tests (no network/API calls)
npm run test:integration   # tests that call the live OpenAI API
npm run validate:beingdb   # compile this repo with a real BeingDB install, if present
```

### Consolidating duplicate predicates

Different interviews' extractions can independently invent different names
for the same relationship (e.g. `employed_by` vs `worked_for`). `npm run
consolidate` sends the current predicate catalog (names, arity, argument
types, sample facts) to the model, merges any predicates it's confident
represent the same relationship into one canonical name, and deletes the
others. Merges are validated first (same arity required, canonical name
must be one of the group, no predicate merged twice in one run), and any
new argument-type mismatch introduced by a merge is reconciled the same way
`npm run fix-types` does.

This deletes files, but only in the working tree - review `git diff` before
committing like any other generated change, and revert or `git checkout --
predicates/` to undo. Every run also appends a record of what was merged
and why to `metadata/consolidation.json`, so a past diff can be understood
without re-deriving the model's reasoning; restoring one removed predicate
file on its own is `git show <commit>^:predicates/<name>.pl > predicates/<name>.pl`.

## Using the dataset with BeingDB

This repository *is* a BeingDB fact repository: `predicates/` at the root
holds one file per predicate (e.g. `predicates/created_by.pl`), which is
exactly what BeingDB's own tools expect.

```bash
beingdb-clone https://github.com/<owner>/beingdb-rewind-interviews.git --git ./git_store
beingdb-compile --git ./git_store --pack ./pack_store
beingdb-repl --pack ./pack_store
```

Some more interesting queries to try in the REPL:

```prolog
% Everything Kevin Atherton made, with the medium of each work
created_by(Work, kevin_atherton), uses_medium(Work, Medium)

% Where his work has been exhibited
created_by(Work, kevin_atherton), exhibited_at(Work, Venue)

% Who he collaborated with
collaborated_with(kevin_atherton, Person)

% Institutions he studied at or was employed by
educated_at(kevin_atherton, Institution)
employed_by(kevin_atherton, Institution)

% Any work made using video, regardless of artist (string type)
uses_medium(Work, "video")

% Exact match on a typed year literal (@1975), not the integer 1975 or the string "1975"
year_created(Work, @1975)

% Comparison and range operators work on year literals directly
began_in(Work, Year), Year >= 1970
began_in(Work, Year), Year between @1960 and @1980
```

As more interviews are added, the same predicates join across artists, e.g.
`employed_by(Artist, slade)` for everyone who taught or studied at the Slade.

## Example

Facts actually generated from Kevin Atherton's REWIND interview:

```prolog
% predicates/document.pl
document(rewind_kevin_atherton_interview).

% predicates/source_url.pl
source_url(rewind_kevin_atherton_interview, "https://rewind.ac.uk/rewind/wp-content/uploads/sites/146/2021/03/KAT510.pdf").

% predicates/interviewee.pl
interviewee(rewind_kevin_atherton_interview, kevin_atherton).

% predicates/person.pl, predicates/work.pl
person(kevin_atherton).
work(tape_tape).

% predicates/created_by.pl
created_by(tape_tape, kevin_atherton).

% predicates/year_created.pl
year_created(tape_tape, @1975).

% predicates/venue.pl, predicates/made_at.pl
venue(battersea_arts_centre).
made_at(tape_tape, battersea_arts_centre).
```

Each fact has a corresponding entry in `metadata/evidence/kevin_atherton.json`
recording the source quote:

```json
{
  "fact": "year_created(tape_tape, @1975).",
  "source": "kevin_atherton",
  "evidence": "I made it tape in 1975. I'd just moved to London. I made it at Battersea Arts Centre.",
  "confidence": "explicit",
  "page": null
}
```

## Repository layout

```
config/
  interviews.json        curated list of interview sources
  entity-aliases.json    shared entity ID aliases (e.g. "ICA" -> ica_london)

src/                      the extraction pipeline (fetch, extract, prompt, validate, serialize)
source/                   cached PDFs/text (gitignored; not redistributed - see below)
predicates/               BeingDB compile root: one file per predicate, shared across all artists
metadata/
  extraction.json         per-interview provenance: URL, checksum, model, timestamp
  evidence/<id>.json      per-fact supporting quotes
  consolidation.json      log of predicate merges from npm run consolidate
test/
  unit/                   no network/API calls
  integration/            live OpenAI calls (npm run test:integration)
```

Facts live under `predicates/<name>.pl` (one file per predicate, across all
artists) rather than one file per artist, because that's the layout BeingDB
itself expects, and it's what makes cross-artist queries possible.

`source/` is not committed: interview transcripts are copyrighted source
material, not pipeline output. `metadata/extraction.json` records a checksum
of the extracted text instead, so a run can be verified by re-fetching the
same URL.

## How extraction works

1. **Fetch & extract**: download the PDF, read its embedded text layer (no
   OCR - a source without one fails loudly rather than producing facts from
   nothing).
2. **Chunk & prompt**: long transcripts are split by paragraph and sent to
   the model chunk by chunk, with a prompt (`npm run show-prompt`) that
   explicitly separates explicit statements from opinion, interpretation,
   and hedged/uncertain claims - only the former become facts.
3. **Structured output**: the model returns typed JSON (entities + facts,
   each with typed arguments, a supporting quote, and a confidence label),
   not raw BeingDB text - only validated output is ever serialized.
4. **Normalize & merge**: entity labels are resolved to stable atom IDs
   (`config/entity-aliases.json` plus automatic collision detection), and
   new facts are merged into the shared per-predicate files, deduplicated
   and sorted for a clean diff.
5. **Provenance**: `document()`, `source_url()`, and `interviewee()` facts
   record curated, certain provenance directly in BeingDB; checksums,
   timestamps, model IDs and per-fact evidence live in `metadata/`, outside
   the query model.

## Limitations

- PDF only, and only PDFs with an embedded text layer.
- Entity resolution outside the curated alias list is heuristic: the same
  real-world entity can occasionally end up under two different atoms
  across interviews, or two similarly-named entities under one. See
  `config/entity-aliases.json` and each interview's `idOverrides`.
- Confidence labels are the model's own self-assessment, not an independent
  verification step.
