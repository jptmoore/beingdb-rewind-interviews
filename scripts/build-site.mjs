#!/usr/bin/env node
/**
 * Build the browser site in docs/ (served by GitHub Pages from main /docs):
 * compile predicates/ with BeingDB, export the pack, and bundle it with
 * BeingDB WASM using site/beingdb.json. Re-run and commit docs/ whenever
 * predicates/ or site/beingdb.json changes.
 *
 * Needs a BeingDB with the `export` command (`beingdb` on PATH, or
 * BEINGDB=/path/to/beingdb) and a BeingDB WASM checkout (../beingdb-wasm, or
 * BEINGDB_WASM=/path/to/beingdb-wasm). Use the BeingDB commit recorded in
 * BeingDB WASM's prebuilt/runtime.json so the export matches the runtime.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BEINGDB = process.env.BEINGDB || "beingdb";
const WASM = resolve(ROOT, process.env.BEINGDB_WASM || "../beingdb-wasm");

function run(cmd, args) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  const result = spawnSync(cmd, args, { stdio: "inherit", cwd: ROOT });
  if (result.error) throw new Error(`could not run ${cmd} (${result.error.message})`);
  if (result.status !== 0) throw new Error(`${cmd} ${args[0]} exited with status ${result.status}`);
}

const workDir = mkdtempSync(join(tmpdir(), "beingdb-site-"));
try {
  if (!existsSync(join(WASM, "scripts", "site.mjs")))
    throw new Error(`BeingDB WASM not found at ${WASM}; clone https://github.com/jptmoore/beingdb-wasm there or set BEINGDB_WASM`);
  const data = join(workDir, "rewind.browser.json");
  run(BEINGDB, ["import", "--input", ROOT, "--git", join(workDir, "git_store")]);
  run(BEINGDB, ["compile", "--git", join(workDir, "git_store"), "--pack", join(workDir, "pack_store")]);
  run(BEINGDB, ["export", "--pack", join(workDir, "pack_store"), "-o", data]);
  run(process.execPath, [join(WASM, "scripts", "site.mjs"), "bundle", "--data", data, "--config", join(ROOT, "site", "beingdb.json"), "--out", join(ROOT, "docs")]);
  console.log("build-site: docs/ is ready; commit it to publish.");
} catch (e) {
  console.error(`build-site: ${e.message}`);
  process.exitCode = 1;
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
