#!/usr/bin/env node
/**
 * Optional validation against a real BeingDB installation: imports this
 * repository's predicates/ directly into a scratch Irmin Git store with
 * `beingdb-import` (no clone/remote needed - we already have the data on
 * disk) and compiles it with `beingdb-compile`, exercising the actual
 * BeingDB parser instead of re-implementing its grammar in TypeScript.
 * Skips gracefully (exit 0) if the `beingdb` CLI isn't installed - this is
 * a nice-to-have check, not a required step of `npm run extract`.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function hasCommand(cmd) {
  const result = spawnSync(cmd, ["--help"], { stdio: "ignore" });
  return result.error === undefined || result.error === null;
}

function run(cmd, args) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  const result = spawnSync(cmd, args, { stdio: "inherit", cwd: ROOT });
  if (result.status !== 0) {
    throw new Error(`${cmd} exited with status ${result.status}`);
  }
}

function main() {
  const useCombined = !hasCommand("beingdb-import") && hasCommand("beingdb");
  if (!hasCommand("beingdb-import") && !useCombined) {
    console.log(
      "validate: no `beingdb` / `beingdb-import` executable found on PATH. " +
        "Skipping (this check is optional - see https://github.com/jptmoore/beingdb).",
    );
    return;
  }

  const workDir = mkdtempSync(join(tmpdir(), "beingdb-validate-"));
  const gitStore = join(workDir, "git_store");
  const packStore = join(workDir, "pack_store");

  try {
    if (useCombined) {
      run("beingdb", ["import", "--input", ROOT, "--git", gitStore]);
      run("beingdb", ["compile", "--git", gitStore, "--pack", packStore]);
    } else {
      run("beingdb-import", ["--input", ROOT, "--git", gitStore]);
      run("beingdb-compile", ["--git", gitStore, "--pack", packStore]);
    }
    console.log("validate: OK - predicates/ compiled successfully with the real BeingDB CLI.");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

main();
