import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { globSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { parse } from "yaml";
import { sourceRoots } from "../bench/workloads/isolated/contract.mjs";
import { eventPaths, selectEvidence, selectKernel, selectScope } from "./benchmark-scope.mjs";

const root = new URL("../", import.meta.url);
const workflow = parse(readFileSync(new URL(".github/workflows/catalog.yml", root), "utf8"));
const allApps = JSON.parse(workflow.jobs.scope.env.PARITY_APPS);
const packageScripts = JSON.parse(readFileSync(new URL("package.json", root), "utf8")).scripts;

for (const [name, paths, apps, json] of [
  ["framework only", ["crates/corten/src/lib.rs", "Cargo.toml", "Cargo.lock"], ["corten"], false],
  ["standalone catalog app", ["bench/catalog/corten/src/main.rs"], ["corten"], false],
  ["one app", ["bench/fullstack/apps/nextjs/page.tsx", "bench/fullstack/apps/nextjs/package.json"], ["nextjs"], false],
  ["framework and one app", ["crates/corten/src/lib.rs", "bench/fullstack/apps/rails/app.rb"], ["corten", "rails"], false],
  ["shared harness", ["bench/catalog/upstream.mjs"], allApps, true],
  ["shared trace harness", ["bench/fullstack/native-trace-cost.mjs"], allApps, true],
  ["shared trace harness tests", ["bench/fullstack/native-trace-cost.test.mjs"], allApps, true],
  ["shared checker styles", ["bench/fullstack/apps/axum-maud/static/style.css"], allApps, true],
  ["Express driver used by FastAPI", ["bench/fullstack/apps/express/check-native.mjs"], ["fastapi", "express"], false],
  ["Express app without shared driver changes", ["bench/fullstack/apps/express/package.json"], ["express"], false],
  ["compiled alert helper", ["bench/fullstack/apps/gin/check-alerts.mjs"], ["leptos", "topcoat", "gin", "drogon"], false],
  ["workflow edit", [".github/workflows/catalog.yml"], allApps, true],
  ["docs only", ["docs/design.md", "CHANGELOG.md"], [], false],
  ["JSON-only app", ["bench/fullstack/apps/aspnet-aot/Program.cs"], [], true],
  ["unknown app directory", ["bench/fullstack/apps/newapp/catalog.test.mjs"], allApps, true],
  ["file directly in the apps directory", ["bench/fullstack/apps/express"], allApps, true],
  ["main push or manual dispatch", undefined, allApps, true],
]) {
  test(name, () => assert.deepEqual(selectScope(allApps, paths), { apps, json }));
}

test("Catalog always starts its scope job and gates parity and JSON on the selected inputs", () => {
  assert.equal(workflow.on.pull_request, null);
  assert.deepEqual(workflow.on.push, { branches: ["main"] });
  const { scope, harness, parity, "json-harness": jsonHarness, "json-aot": jsonAot } = workflow.jobs;
  assert.equal(scope.if, undefined);
  const step = scope.steps.find(step => step.run === "node scripts/benchmark-scope.mjs catalog");
  assert.equal(step.env.PUSH_BEFORE, "${{ github.event.before }}");
  assert.equal(scope.steps.find(step => step.uses?.startsWith("actions/checkout")).with["fetch-depth"], 0);
  // Every main push keeps its own run: a replaced run would leave its push diff untested.
  assert.equal(workflow.concurrency.group,
    "${{ github.workflow }}-${{ github.event_name == 'pull_request' && github.ref || github.run_id }}");
  assert.equal(workflow.concurrency["cancel-in-progress"], "${{ github.event_name == 'pull_request' }}");
  assert.equal(harness.if, "needs.scope.outputs.apps != '[]' || needs.scope.outputs.json == 'true'");
  assert.equal(parity.if, "needs.scope.outputs.apps != '[]'");
  assert.equal(jsonHarness.if, "needs.scope.outputs.json == 'true'");
  assert.equal(jsonAot.if, jsonHarness.if);
});

async function localImports(entries) {
  const cwd = fileURLToPath(root);
  const { metafile } = await build({
    absWorkingDir: cwd, entryPoints: entries.flatMap(pattern => {
      const files = globSync(pattern, { cwd });
      assert.ok(files.length > 0, "no entry points for " + pattern);
      return files;
    }), bundle: true, platform: "node", format: "esm", packages: "external", write: false,
    outdir: "unused", metafile: true, logLevel: "silent",
  });
  return Object.keys(metafile.inputs).filter(path => !path.startsWith("node_modules/"));
}

test("every local module used by the Catalog harness starts the harness", async () => {
  const patterns = workflow.jobs.harness.steps.flatMap(({ run }) => {
    if (!run || run.startsWith("npm ci ") || run.startsWith("npx playwright install ")) return [];
    const command = run === "npm run check:marketplace" ? packageScripts["check:marketplace"] : run;
    assert.match(command, /^node (?:--test )?bench\//, "trace new harness commands here");
    return command.replace(/^node (?:--test )?/, "").split(" ");
  });
  for (const input of await localImports(patterns)) {
    const { apps, json } = selectScope(allApps, [input]);
    assert.ok(apps.length > 0 || json, "harness input not selected: " + input);
  }
});

function parityEntries(app) {
  return [...new Set(workflow.jobs.parity.steps.flatMap(({ if: condition, run }) => {
    if (!run) return [];
    const command = run.replaceAll("${{ matrix.app }}", app);
    const entries = [...command.matchAll(/(?:^|\s)(bench\/[^\s]+\.mjs)(?=\s|$)/g)].map(([, path]) => path);
    if (!entries.length || !condition) return entries;
    const single = /^matrix\.app == '([^']+)'$/.exec(condition);
    if (single) return single[1] === app ? entries : [];
    const multiple = /^contains\(fromJSON\('([^']+)'\), matrix\.app\)$/.exec(condition);
    assert.ok(multiple, "trace new parity condition: " + condition);
    return JSON.parse(multiple[1]).includes(app) ? entries : [];
  }))];
}

test("every local module used by Catalog parity selects each consuming matrix app", async () => {
  const missing = [];
  for (const app of allApps) {
    const entries = parityEntries(app);
    assert.ok(entries.length > 0, "no parity entries for " + app);
    for (const input of await localImports(entries)) {
      if (!selectScope(allApps, [input]).apps.includes(app)) missing.push(`${app}: ${input}`);
    }
  }
  assert.deepEqual(missing, [], "unselected Catalog parity inputs");
});

test("Evidence covers every real source-custody root and its descendants", () => {
  for (const path of sourceRoots) {
    assert.equal(selectEvidence([path]), true, path);
    assert.equal(selectEvidence([path + "/new file"]), true, path);
  }
  for (const path of [".github/workflows/benchmark-evidence.yml", ".gitattributes", "docs/new-link.md", "crates/corten/src/lib.rs"]) {
    assert.equal(selectEvidence([path]), true, path);
  }
  assert.equal(selectEvidence(["CHANGELOG.md", "examples/watchlist/src/main.rs", "docs-other/file"]), false);
  assert.equal(selectEvidence(undefined), true);
});

test("native kernel controls run for fixture and tooling inputs, not portable source custody alone", () => {
  for (const path of ["bench/workloads/isolated/bootstrap.mjs", "scripts/benchmark-kernel-ci.sh",
    ".github/workflows/benchmark-evidence.yml", "package-lock.json"]) {
    assert.equal(selectKernel([path]), true, path);
  }
  for (const path of ["crates/corten/src/lib.rs", "Cargo.toml", "Cargo.lock", "docs/design.md"]) {
    assert.equal(selectKernel([path]), false, path);
  }
  assert.equal(selectKernel(undefined), true);
});

function kernelEntries() {
  const script = readFileSync(new URL("scripts/benchmark-kernel-ci.sh", root), "utf8");
  // Read Node arguments and inline imports, including the generated unit's test path.
  const paths = [...script.matchAll(/(?:^|[\s"'`])(?:\$checkout\/|\.\/)?([\w/.$\-{}]+\.mjs)(?=[\s"'`]|$)/g)]
    .map(([, path]) => path);
  assert.ok(paths.length > 0, "no kernel Node entries");
  const entries = paths.flatMap(path => {
    if (!path.includes("$")) return path;
    const suites = /^\s*for suite in ([\w -]+); do$/m.exec(script);
    const branch = /const file = suite === '([\w-]+)' \? '[^']+\.mjs'/.exec(script);
    assert.ok(suites && branch && path.includes("${suite}"), "trace new kernel unit path: " + path);
    const values = suites[1].split(/\s+/);
    assert.ok(values.length > 1 && values.includes(branch[1]), "trace new kernel suite branches");
    return values.filter(suite => suite !== branch[1]).map(suite => path.replaceAll("${suite}", suite));
  });

  // The process launcher passes bootstrap as argv, not as an import. Bootstrap imports
  // dispatcher-child, whose argv targets (and the directly spawned fixtures) are in the tests.
  const spawned = ["bench/workloads/isolated/bootstrap.mjs"];
  for (const entry of new Set(entries)) {
    const source = readFileSync(new URL(entry, root), "utf8");
    for (const [, path] of source.matchAll(/["']((?:bench\/|\.\/)[\w/.-]*(?:dispatcher-fixtures|test-fixtures)\/[\w/.-]+\.mjs)["']/g)) {
      spawned.push(path.startsWith("./") ? new URL(path, new URL(entry, root)).href.slice(root.href.length) : path);
    }
  }
  return [...new Set([...entries, ...spawned])];
}

test("every local module used by native kernel controls selects the kernel job", async () => {
  const inputs = await localImports(kernelEntries());
  assert.deepEqual(inputs.filter(input => !selectKernel([input])).sort(), [], "unselected native kernel inputs");
});

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), "corten-benchmark-scope-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", [
    "-c", "core.autocrlf=false", "-c", "user.name=Catalog Fixture", "-c", "user.email=fixture@example.invalid",
    "-c", "commit.gpgsign=false", ...args,
  ], { cwd, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  const write = (path, text = "fixture\n") => {
    const file = join(cwd, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  const commit = () => {
    git("add", ".");
    git("commit", "-qm", "fixture");
    return git("rev-parse", "HEAD");
  };
  const rename = (from, to) => {
    mkdirSync(dirname(join(cwd, to)), { recursive: true });
    renameSync(join(cwd, from), join(cwd, to));
  };
  const merge = head => {
    git("switch", "--quiet", "main");
    git("merge", "--quiet", "--no-ff", "--no-edit", head);
    return git("rev-parse", "HEAD");
  };
  return { cwd, git, write, commit, rename, merge };
}

const prEvent = GITHUB_SHA => ({ GITHUB_EVENT_NAME: "pull_request", GITHUB_SHA });

test("PR diff excludes base-only changes and includes both sides of an app rename", t => {
  const { cwd, git, write, commit, rename, merge } = fixture(t);
  const before = "bench/fullstack/apps/rails/old file";
  const after = "bench/fullstack/apps/nextjs/new file";
  write(before);
  const fork = commit();
  write("bench/catalog/upstream.mjs");
  commit();
  git("switch", "--quiet", "--detach", fork);
  rename(before, after);
  const event = prEvent(merge(commit()));
  const paths = eventPaths(event, cwd);
  assert.deepEqual(paths.sort(), [after, before]);

  const script = fileURLToPath(new URL("./benchmark-scope.mjs", import.meta.url));
  const output = join(cwd, "output");
  const env = { ...process.env, ...event, GITHUB_OUTPUT: output, PARITY_APPS: workflow.jobs.scope.env.PARITY_APPS };
  for (const job of ["catalog", "evidence"]) execFileSync(process.execPath, [script, job], { cwd, env });
  assert.equal(readFileSync(output, "utf8"), 'apps=["nextjs","rails"]\njson=false\nrun=true\nkernel=true\n');
});

test("a base-side rename scopes the edited file where parity actually tests it", t => {
  const { cwd, git, write, commit, rename, merge } = fixture(t);
  const before = "bench/fullstack/apps/express/driver.mjs";
  const after = "bench/workloads/driver.mjs";
  write(before);
  const fork = commit();
  rename(before, after);
  const base = commit();
  git("switch", "--quiet", "--detach", fork);
  write(before, "edited on PR\n");
  const head = commit();
  const merged = merge(head);
  assert.equal(git("diff", "--name-only", base + "..." + head), before);
  const paths = eventPaths(prEvent(merged), cwd);
  assert.deepEqual(paths, [after]);
  assert.deepEqual(selectScope(allApps, paths), { apps: allApps, json: true });
});

test("a push to main scopes Catalog by its push diff, and an unknown base selects everything", t => {
  const { cwd, write, commit } = fixture(t);
  write("initial");
  const base = commit();
  write("docs/guide/views.md");
  const docs = commit();
  write("crates/corten/src/lib.rs");
  const framework = commit();
  const script = fileURLToPath(new URL("./benchmark-scope.mjs", import.meta.url));
  const output = join(cwd, "output");
  const scope = (PUSH_BEFORE, GITHUB_SHA) => {
    writeFileSync(output, "");
    const env = { ...process.env, GITHUB_EVENT_NAME: "push", GITHUB_SHA, PUSH_BEFORE, GITHUB_OUTPUT: output,
      PARITY_APPS: workflow.jobs.scope.env.PARITY_APPS };
    execFileSync(process.execPath, [script, "catalog"], { cwd, env, stdio: ["ignore", "ignore", "ignore"] });
    return readFileSync(output, "utf8");
  };
  assert.equal(scope(base, docs), "apps=[]\njson=false\n");
  assert.equal(scope(docs, framework), 'apps=["corten"]\njson=false\n');
  const all = `apps=${JSON.stringify(allApps)}\njson=true\n`;
  assert.equal(scope("0".repeat(40), framework), all);
  assert.equal(scope("a".repeat(40), framework), all);
  // A rewound or rewritten push compares with a base that is not its ancestor.
  assert.equal(scope(framework, docs), all);
  for (const GITHUB_EVENT_NAME of ["workflow_dispatch", "schedule"]) {
    assert.deepEqual(selectScope(allApps, eventPaths({ GITHUB_EVENT_NAME, GITHUB_SHA: framework }, cwd)), { apps: allApps, json: true });
  }
});

test("PR and multi-commit push diffs see inputs beyond the hosted path-filter limit", t => {
  const { cwd, git, write, commit, merge } = fixture(t);
  write("initial");
  const base = commit();
  git("switch", "--quiet", "--detach", base);
  for (let i = 0; i < 301; i++) write("aaa-unrelated/" + i);
  const input = "bench/fullstack/native-trace-cost.mjs";
  write(input);
  commit();
  write("zzz-unrelated");
  const head = commit();
  const events = [prEvent(merge(head)), { GITHUB_EVENT_NAME: "push", GITHUB_SHA: head, PUSH_BEFORE: base }];
  for (const event of events) {
    const paths = eventPaths(event, cwd);
    assert.equal(paths.length, 303);
    assert.equal(paths[301], input);
    assert.deepEqual(selectScope(allApps, paths), { apps: allApps, json: true });
    assert.equal(selectEvidence(paths), true);
    assert.equal(selectKernel(paths), true);
  }
  for (const before of ["0".repeat(40), "a".repeat(40)]) {
    const paths = eventPaths({ ...events[1], PUSH_BEFORE: before }, cwd);
    assert.equal(selectEvidence(paths), true);
    assert.equal(selectKernel(paths), true);
  }
});
