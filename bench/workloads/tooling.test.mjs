import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
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
  const dockerfile = readFileSync(new URL("test-tools.Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /^FROM \$\{PLAYWRIGHT_IMAGE\}$/m);
  assert.match(dockerfile, /add-apt-repository -y ppa:git-core\/ppa/);
  assert.match(dockerfile, /git --no-replace-objects --no-lazy-fetch --version/);
});
