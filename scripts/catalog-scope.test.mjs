import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { changedPaths, selectScope } from "./catalog-scope.mjs";

const workflow = parse(readFileSync(new URL("../.github/workflows/catalog.yml", import.meta.url), "utf8"));
const allApps = parse(workflow.jobs.scope.env.PARITY_MATRIX).app;

for (const [name, paths, apps, json] of [
  ["framework only", ["crates/corten/src/lib.rs", "Cargo.toml", "Cargo.lock"], ["corten"], false],
  ["standalone catalog app", ["bench/catalog/corten/src/main.rs"], ["corten"], false],
  ["one app", ["bench/fullstack/apps/nextjs/page.tsx", "bench/fullstack/apps/nextjs/package.json"], ["nextjs"], false],
  ["framework and one app", ["crates/corten/src/lib.rs", "bench/fullstack/apps/rails/app.rb"], ["corten", "rails"], false],
  ["shared harness", ["bench/catalog/upstream.mjs"], allApps, true],
  ["shared checker styles", ["bench/fullstack/apps/axum-maud/static/style.css"], allApps, true],
  ["compiled alert helper", ["bench/fullstack/apps/gin/check-alerts.mjs"], ["leptos", "topcoat", "gin", "drogon"], false],
  ["workflow edit", [".github/workflows/catalog.yml"], allApps, true],
  ["docs only", ["docs/design.md", "CHANGELOG.md"], [], false],
  ["JSON-only app", ["bench/fullstack/apps/aspnet-aot/Program.cs"], [], true],
  ["main push or manual dispatch", undefined, allApps, true],
]) {
  test(name, () => assert.deepEqual(selectScope(allApps, paths), { apps, json }));
}

test("PR diff excludes base-only changes and includes both sides of an app rename", t => {
  const cwd = mkdtempSync(join(tmpdir(), "corten-catalog-scope-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  const write = path => {
    const file = join(cwd, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "fixture\n");
  };
  const commit = () => {
    git("add", ".");
    git("-c", "user.name=Catalog Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
    return git("rev-parse", "HEAD");
  };
  const before = "bench/fullstack/apps/rails/old file";
  const after = "bench/fullstack/apps/nextjs/new file";
  write(before);
  const fork = commit();
  write("bench/catalog/upstream.mjs");
  const base = commit();
  git("switch", "--quiet", "--detach", fork);
  mkdirSync(dirname(join(cwd, after)), { recursive: true });
  renameSync(join(cwd, before), join(cwd, after));
  const head = commit();
  const paths = changedPaths(base, head, cwd);
  assert.deepEqual(paths.sort(), [after, before]);

  const script = fileURLToPath(new URL("./catalog-scope.mjs", import.meta.url));
  const output = join(cwd, "output");
  const env = { ...process.env, GITHUB_OUTPUT: output, PARITY_MATRIX: workflow.jobs.scope.env.PARITY_MATRIX,
    GITHUB_EVENT_NAME: "pull_request", PR_BASE: base, PR_HEAD: head };
  execFileSync(process.execPath, [script], { cwd, env });
  assert.equal(readFileSync(output, "utf8"), 'apps=["nextjs","rails"]\njson=false\n');
});
