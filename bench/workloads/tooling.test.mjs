import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

test("browser CI keeps its pinned Playwright base and prepares immutable-source Git", () => {
  const root = new URL("../../", import.meta.url);
  const workflow = parse(readFileSync(new URL(".github/workflows/ci.yml", root), "utf8"));
  const step = workflow.jobs.smoke.steps.find((entry) => entry.name === "Playwright's image");
  assert.ok(step);
  assert.match(step.run, /require\("@playwright\/test\/package\.json"\)\.version/);
  const build = 'docker build --build-arg PLAYWRIGHT_IMAGE="$image" -f bench/workloads/test-tools.Dockerfile -t corten-playwright-tools .';
  const select = 'image="corten-playwright-tools"';
  assert.ok(step.run.indexOf('docker pull "$image"') < step.run.indexOf(build));
  assert.ok(step.run.indexOf(build) >= 0 && step.run.indexOf(build) < step.run.indexOf(select));
  assert.ok(step.run.indexOf(select) < step.run.indexOf("PLAYWRIGHT=$run $image"));
  assert.ok(step.run.includes('PLAYWRIGHT_SOURCE=$run --user $(id -u):$(id -g) -e HOME=/tmp $image'));
  const sourceChecks = workflow.jobs.smoke.steps.find((entry) => entry.run?.includes("MIXED_BROWSER_TESTS=1 npm run check:groups:browser"));
  assert.equal(sourceChecks.run, "$PLAYWRIGHT_SOURCE env MIXED_BROWSER_TESTS=1 npm run check:groups:browser");
  assert.doesNotMatch(step.run, /safe\.directory/);
  const dockerfile = readFileSync(new URL("test-tools.Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /^ARG PLAYWRIGHT_IMAGE\r?\nFROM \$\{PLAYWRIGHT_IMAGE\}$/m);
  assert.match(dockerfile, /signed-by=\/etc\/apt\/keyrings\/corten-git-ppa.asc/);
  assert.match(dockerfile, /https:\/\/ppa.launchpadcontent.net\/git-core\/ppa\/ubuntu noble main/);
  assert.match(dockerfile, /test .* = F911AB184317630C59970973E363C90F8F1B6217/);
  assert.doesNotMatch(dockerfile, /&& add-apt-repository/);
  assert.match(dockerfile, /git --no-replace-objects --no-lazy-fetch --version/);
});

test("benchmark evidence supplies the installed, locked Playwright base explicitly", () => {
  const workflow = parse(readFileSync(new URL("../../.github/workflows/benchmark-evidence.yml", import.meta.url), "utf8"));
  const steps = workflow.jobs.evidence.steps;
  const build = steps.findIndex((entry) => entry.run?.includes("test-tools.Dockerfile"));
  const install = steps.findIndex((entry) => entry.run === "npm ci");
  // Tool replay also reads the bench package's locked classic TypeScript archive.
  const bench = steps.findIndex((entry) => entry.run === "npm --prefix bench ci");
  assert.ok(install >= 0 && bench > install && bench < build);
  assert.match(steps[build].run, /image="mcr\.microsoft\.com\/playwright:v\$\(node -p 'require\("@playwright\/test\/package\.json"\)\.version'\)-noble"/);
  assert.match(steps[build].run, /docker build --build-arg PLAYWRIGHT_IMAGE="\$image" -f bench\/workloads\/test-tools\.Dockerfile/);
});

test("Django qualification checks its Playwright install and resource cleanup without Docker", () => {
  const suite = fileURLToPath(new URL("../fullstack/apps/django/qualify-production.test.mjs", import.meta.url));
  const run = spawnSync(process.execPath, ["--experimental-vm-modules", "--test", suite], { encoding: "utf8", timeout: 30000 });
  assert.ifError(run.error);
  assert.equal(run.status, 0, run.stdout + run.stderr);
});
