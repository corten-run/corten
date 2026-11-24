import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";
import { allApps } from "../fullstack/apps.mjs";
import { buildPlan as jsonBuildPlan, descriptor as jsonDescriptor, appArgs as jsonAppArgs, cpuSettings as jsonCpuSettings } from "../json-api/contract.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../..");
test("catalog Corten uses supported lean settings, not the production timeout/compression profile", () => {
  const manifest = readFileSync(join(here, "corten/Cargo.toml"), "utf8");
  const application = readFileSync(join(here, "corten/src/main.rs"), "utf8");
  const dependency = manifest.split("\n").find((line) => line.startsWith("corten = "));
  assert.match(dependency, /features = \["json"\]/);
  assert.doesNotMatch(dependency, /"compress"/);
  for (const setting of ["deadline", "header_timeout", "send_timeout"]) {
    assert.ok(application.includes(`.${setting}(None)`), `catalog keeps no optional ${setting} timer`);
  }
  assert.ok(application.includes('let lean = std::env::var("PROFILE").as_deref() == Ok("catalog-lean");'));
  assert.ok(application.includes("if lean {"));
  assert.ok(application.includes("} else {\n        app\n    }"));
  assert.ok(application.includes("corten::serve(app(source, lean))"));
  assert.ok(application.includes("req.page(views::document"));
  assert.doesNotMatch(application, /\bunstaged\b/, "catalog remains a working page, not sandboxed data");
});

test("the shared Corten catalog build preserves framework-default JSON settings", () => {
  const plan = jsonBuildPlan("corten", "catalog-v1");
  assert.equal(plan.dockerfile, "bench/catalog/corten/Dockerfile");
  assert.equal(jsonDescriptor().nativeProfile, "framework-default");
  const args = jsonAppArgs({ name: "offline-app", profile: { payload: "catalog-v1", source: "fixture" }, imageId: "offline-image",
    network: "offline-net", upstream: "http://offline-upstream:8080", fixtures: "/fixtures", cpus: jsonCpuSettings({}) });
  assert.ok(args.includes("PROFILE="));
  const manifest = readFileSync(join(here, "corten/Cargo.toml"), "utf8");
  assert.match(manifest, /default = \["compression"\]/);
  assert.match(manifest, /compression = \["corten\/compress"\]/);
  const dockerfile = readFileSync(join(repo, plan.dockerfile), "utf8");
  assert.match(dockerfile, /ARG CATALOG_LEAN=0/);
  assert.ok(dockerfile.includes('1) set -- --no-default-features ;; 0) set -- ;; *) exit 1'));
  const runner = readFileSync(join(here, "run.mjs"), "utf8");
  assert.ok(runner.includes('app === "corten" ? ["--build-arg", "CATALOG_LEAN=1"] : []'));
  assert.ok(!readFileSync(join(repo, "bench/json-api/run.mjs"), "utf8").includes("CATALOG_LEAN=1"));
});

test("catalog checks include failure reporting regressions and native umask coverage is Gin-only parity work", () => {
  const workflow = parse(readFileSync(join(repo, ".github/workflows/catalog.yml"), "utf8"));
  const script = "node --test bench/catalog/gin-permissions.test.mjs";
  const steps = workflow.jobs.parity.steps.filter((step) => step.run === script);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].if, "matrix.app == 'gin'");
  assert.equal(steps[0].env.CATALOG_GIN_DOCKER_TESTS, "1");
  assert.ok(workflow.jobs.harness.steps.every((step) => !step.run?.includes("gin-permissions.test.mjs")));
  const check = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).scripts["check:catalog"];
  for (const file of ["check-result.test.mjs", "runner-failure.test.mjs"]) assert.ok(check.split(" ").includes(`bench/catalog/${file}`));
});

// Chromium and its libraries come from Playwright's image, not from the runner's apt mirror (#2011):
// every browser check runs through the image's command, set up before it in the same job.
test("catalog CI takes Chromium from Playwright's image, not the runner's apt mirror", () => {
  const workflow = parse(readFileSync(join(repo, ".github/workflows/catalog.yml"), "utf8"));
  for (const [name, job] of Object.entries(workflow.jobs)) {
    assert.ok(job.steps.every((step) => !/playwright install/.test(step.run ?? "")), name);
  }
  const browserChecks = {
    harness: ["$PLAYWRIGHT npm run check:marketplace", "$PLAYWRIGHT_WITH_DOCKER node --test bench/catalog/*.test.mjs"],
    parity: ["$PLAYWRIGHT_WITH_DOCKER node bench/fullstack/apps/gin/check-alerts.mjs ${{ matrix.app }} ",
      "$PLAYWRIGHT_WITH_DOCKER node bench/fullstack/apps/drogon/tests/marketplace-matched.mjs ",
      "$PLAYWRIGHT_WITH_DOCKER node bench/fullstack/apps/gin/check-alerts.mjs gin cb-catalog-gin matched"],
  };
  for (const [name, commands] of Object.entries(browserChecks)) {
    const steps = workflow.jobs[name].steps;
    const image = steps.findIndex((step) => step.name === "Playwright's image");
    assert.ok(image >= 0, name);
    assert.match(steps[image].run, /mcr\.microsoft\.com\/playwright:v\$\(node -p 'require\("@playwright\/test\/package\.json"\)\.version'\)-noble/);
    for (const command of commands) {
      const at = steps.findIndex((step) => (step.run ?? "").split("\n").some((line) => line.startsWith(command)));
      assert.ok(at > image, `${name}: ${command}`);
    }
  }
  const alerts = workflow.jobs.parity.steps.find((step) => step.name === "Test native compiled alert forms and independent readback");
  assert.equal(workflow.jobs.parity.steps.find((step) => step.name === "Playwright's image").if, alerts.if);
});

test("an existing catalog results directory is reserved, including a failed or check-only round", () => {
  const round = `c${Date.now()}${process.pid}`;
  const parent = join(here, "results");
  const dir = join(parent, round);
  mkdirSync(parent, { recursive: true });
  mkdirSync(dir);
  const sentinel = join(dir, "sentinel");
  writeFileSync(sentinel, "do not overwrite");
  try {
    for (const extra of [[], ["--group", "catalog-page"]]) {
      const result = spawnSync(process.execPath, [join(here, "run.mjs"), round, "--check-only", ...extra], {
        cwd: repo, encoding: "utf8", windowsHide: true, timeout: 10000,
        env: { ...process.env, BENCH_APPS: "corten", BENCH_TIER: "matched" },
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /EEXIST/, "full native inventory remains available despite legacy tier/subset environment");
    }
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
  const names = JSON.parse(/PARITY_APPS: >-\s*(\[[^\]]+\])/.exec(workflow)[1].replace(/\s+/g, " "));
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
