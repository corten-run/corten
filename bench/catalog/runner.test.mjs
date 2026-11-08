import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { allApps } from "../fullstack/apps.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../..");
test("an existing catalog results directory is reserved, including a failed or check-only round", () => {
  const round = `c${Date.now()}${process.pid}`;
  const parent = join(here, "results");
  const dir = join(parent, round);
  mkdirSync(parent, { recursive: true });
  mkdirSync(dir);
  const sentinel = join(dir, "sentinel");
  writeFileSync(sentinel, "do not overwrite");
  try {
    const result = spawnSync(process.execPath, [join(here, "run.mjs"), round, "--check-only"], { cwd: repo, encoding: "utf8", windowsHide: true, timeout: 10000 });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /EEXIST/);
    assert.equal(readFileSync(sentinel, "utf8"), "do not overwrite");
    assert.equal(existsSync(join(dir, "summary.json")), false);
  } finally {
    assert.equal(dirname(dir), parent, "cleanup remains in catalog results");
    rmSync(dir, { recursive: true, force: true });
  }
});
test("runner rejects marketplace/matched/unsafe rounds before any Docker commands", () => {
  for (const round of ["r1", "m1", "../c1", "c0"]) {
    const result = spawnSync(process.execPath, [join(here, "run.mjs"), round], { cwd: repo, encoding: "utf8", windowsHide: true, timeout: 10000 });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /round must be cN/);
  }
});
test("catalog CI covers exactly the registry's twenty page apps and both sources without nightly integration", () => {
  const workflow = readFileSync(join(repo, ".github/workflows/catalog.yml"), "utf8");
  const names = /app: \[([^\]]+)\]/.exec(workflow)[1].split(",").map((s) => s.trim());
  assert.equal(names.length, 20);
  assert.deepEqual(names.sort(), Object.entries(allApps).filter(([, app]) => app.pages !== false).map(([name]) => name).sort());
  assert.match(workflow, /run\.mjs c1 --apps \$\{\{ matrix\.app \}\} --build --check-only/);
  assert.match(workflow, /CATALOG_DOCKER_TESTS:\s*"1"/, "Linux CI must execute the cleanup regression rather than skip it");
  assert.ok(!/schedule:|droplet\.mjs|run-all\.mjs|trend\.mjs|BENCH_TIER|BENCH_NETWORK/.test(workflow));
  const runner = readFileSync(join(here, "run.mjs"), "utf8");
  assert.match(runner, /for \(const source of sources\)/);
  assert.match(runner, /mkdirSync\(folder\);/);
  assert.match(runner, /Config\.Labels\?\.\[label\], runId/);
  assert.match(runner, /mcr\.microsoft\.com\/playwright/);
  assert.match(runner, /finally \{ await remove\(checkContainer\); \}/);
  assert.ok(!runner.includes('command(process.execPath, [join(here, "check.mjs")'), "checks must not launch a host browser outside owned cleanup");
  assert.ok(!/fsw-|rustbench|\brmi\b|volume.*prune|network.*prune/.test(runner));
});
