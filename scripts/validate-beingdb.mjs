#!/usr/bin/env node
/**
 * Optional validation against a real BeingDB installation: clones this
 * repository's current working tree with `beingdb-clone` and compiles it
 * with `beingdb-compile`, exercising the actual BeingDB parser instead of
 * re-implementing its grammar in TypeScript. Skips gracefully (exit 0) if
 * the `beingdb` CLI isn't installed - this is a nice-to-have check, not a
 * required step of `npm run extract`.
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
  const clone = hasCommand("beingdb-clone") ? "beingdb-clone" : hasCommand("beingdb") ? "beingdb" : null;
  if (clone === null) {
    console.log(
      "validate:beingdb: no `beingdb` / `beingdb-clone` executable found on PATH. " +
        "Skipping (this check is optional - see https://github.com/jptmoore/beingdb).",
    );
    return;
  }

  const workDir = mkdtempSync(join(tmpdir(), "beingdb-validate-"));
  const gitStore = join(workDir, "git_store");
  const packStore = join(workDir, "pack_store");

  try {
    if (clone === "beingdb") {
      run("beingdb", ["clone", ROOT, "--git", gitStore]);
      run("beingdb", ["compile", "--git", gitStore, "--pack", packStore]);
    } else {
      run("beingdb-clone", [ROOT, "--git", gitStore]);
      run("beingdb-compile", ["--git", gitStore, "--pack", packStore]);
    }
    console.log("validate:beingdb: OK - repository compiled successfully with the real BeingDB CLI.");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

main();
