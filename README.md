# BeingDB REWIND Interviews

Facts about British and international video artists, their works,
exhibitions and collaborators, taken from the
[REWIND](https://rewind.ac.uk/) archive of artists' interviews, in
[BeingDB](https://github.com/jptmoore/beingdb) format.

**[Query the facts in your browser](https://jptmoore.github.io/beingdb-rewind-interviews/)**,
with nothing to install.

> **About the data.** The facts were extracted automatically from the
> interview transcripts. They are a research dataset, not verified catalogue
> metadata: a result means "this is recorded in the dataset", not "this is
> complete or historically correct". Each fact's supporting quote is kept in
> `metadata/evidence/`.

## What's here

```
predicates/          the facts: one file per predicate (114 files)
config/predicate-declarations.json   argument roles and descriptions for each predicate
metadata/evidence/   the interview quote behind each fact, per artist
site/beingdb.json    the browser site's title, description and example queries
docs/                the browser site (built, served by GitHub Pages)
```

Each file in `predicates/` holds every fact for one predicate, for example
`predicates/created_by.pl`:

```prolog
%! created_by(Work, Artist)
% Relates a work to the artist or artist group who made it.
created_by(absence_of_satan, george_barber).
created_by(tape_tape, kevin_atherton).
```

The `%!` line names the arguments, and the `%` line under it describes the
predicate. BeingDB shows both when you browse the predicates.

## Query the facts

- **In the browser:** <https://jptmoore.github.io/beingdb-rewind-interviews/>.
  Use the example queries, or click **Predicates** to see what you can ask
  about. The [BeingDB tutorial](https://jptmoore.github.io/beingdb-wasm/tutorial/)
  teaches the query language on this dataset.
- **With BeingDB:**

  ```bash
  beingdb clone https://github.com/jptmoore/beingdb-rewind-interviews.git --git ./git_store
  beingdb compile --git ./git_store --pack ./pack_store
  beingdb repl --pack ./pack_store
  ```

  then, for example:

  ```text
  find Work, Medium
  where
    created_by(Work, kevin_atherton)
    uses_medium(Work, Medium)
  ```

## Edit the facts

Edit the files in `predicates/` directly:

- One fact per line, ending with a full stop: `created_by(tape_tape, kevin_atherton).`
- Every fact in a file has the same predicate name and number of arguments.
- Values are atoms (`kevin_atherton`), strings (`"The Video Stairs"`),
  numbers (`42`) or dates (`@1975`, `@1975-06`, `@1975-06-21`). See BeingDB's
  [query language](https://github.com/jptmoore/beingdb/blob/main/docs/query-language.md).
- Use the same atom for the same thing everywhere, so facts join up across
  predicates: `created_by(tape_tape, kevin_atherton)` and
  `year_created(tape_tape, @1975)` together say when Kevin Atherton made
  *Tape*.
- A new predicate is a new file, `predicates/<name>.pl`.
- Lines starting with `%` are comments.

To change a predicate's argument roles or description, edit it in
`config/predicate-declarations.json`, then run `npm install` (once) and
`npm run declarations` to update the `%!` lines in `predicates/`.

To merge predicates that record the same relation, list them in a plan file
like [`metadata/consolidation-plans/01-synonyms.json`](metadata/consolidation-plans/01-synonyms.json)
and run `npm run consolidate -- --plan <file>`. The members must have the same
number of arguments; a member whose arguments are in a different order gets an
`argumentOrder` (see [`02-general.json`](metadata/consolidation-plans/02-general.json)),
and the merged predicate can be a new name. It merges the facts, updates the
evidence in `metadata/` and logs each merge in `metadata/consolidation.json`.
Then remove the merged-away predicates from
`config/predicate-declarations.json`, declare any new one, and run
`npm run declarations`.

To merge two atoms for the same thing, run
`npm run reconcile -- old_atom=new_atom`, and add the name to
`config/entity-aliases.json` (or, for a name that means different things in
different interviews, to that interview's `idOverrides` in
`config/interviews.json`) so future extractions use the same atom.

## Build a new output

After editing, rebuild the browser site and commit it with your changes.
This needs [BeingDB](https://github.com/jptmoore/beingdb/blob/main/docs/installation.md)
installed, and [BeingDB WASM](https://github.com/jptmoore/beingdb-wasm)
cloned next to this repository:

```bash
git clone https://github.com/jptmoore/beingdb-wasm.git ../beingdb-wasm   # once

npm run build-site
git add predicates docs
git commit -m "Update facts"
git push
```

`npm run build-site` compiles `predicates/` with BeingDB, exports it, and
bundles it with BeingDB WASM into `docs/`. It stops with an error if a fact
does not parse or a file mixes argument counts, so check its output. GitHub
Pages publishes `docs/` from `main` a minute or two after the push (Settings >
Pages: "Deploy from a branch", `main`, `/docs`).

If `beingdb` is not on your `PATH`, give its location with
`BEINGDB=/path/to/beingdb npm run build-site`; for a BeingDB WASM checkout
elsewhere, set `BEINGDB_WASM=/path/to/beingdb-wasm`.

To only check that the facts compile, without building the site, run
`npm run validate`.
