import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmdirSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
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
  const build = steps.findIndex((entry) => entry.run?.includes("evidence-tools.Dockerfile"));
  const install = steps.findIndex((entry) => entry.run === "npm ci");
  // Tool replay also reads the bench package's locked classic TypeScript archive.
  const bench = steps.findIndex((entry) => entry.run === "npm --prefix bench ci");
  assert.ok(install >= 0 && bench > install && bench < build);
  assert.match(steps[build].run, /image="mcr\.microsoft\.com\/playwright:v\$\(node -p 'require\("@playwright\/test\/package\.json"\)\.version'\)-noble"/);
  assert.equal(steps[build].env.IMAGE, "${{ needs.git-packages.outputs.image }}");
  assert.equal(steps[build].env.CHECKSUM, "${{ needs.git-packages.outputs.checksum }}");
  assert.match(steps[build].run, /test "\$\{checksum%% \*\}" = "\$CHECKSUM"[\s\S]+docker build --pull --build-arg PLAYWRIGHT_IMAGE="\$IMAGE"/);
  const download = steps.find(entry => entry.uses?.startsWith("actions/download-artifact@"));
  assert.deepEqual(download.with, { "artifact-ids": "${{ needs.git-packages.outputs.artifact }}", path: "${{ runner.temp }}/packages", "merge-multiple": true });
  const tools = workflow.jobs["git-packages"].steps;
  assert.equal(tools.find(entry => entry.uses?.startsWith("actions/cache/save@")).if,
    "github.event_name == 'push' && github.ref == 'refs/heads/main' && steps.cache.outputs.cache-hit != 'true'");
  assert.equal(tools.find(entry => entry.id === "cache").with["restore-keys"], undefined);
  const dockerfile = readFileSync(new URL("evidence-tools.Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /RUN --network=none[\s\S]+git --no-replace-objects --no-lazy-fetch -C "\$repo" cat-file blob/);
});

test("Django qualification checks its Playwright install and resource cleanup without Docker", () => {
  const suite = fileURLToPath(new URL("../fullstack/apps/django/qualify-production.test.mjs", import.meta.url));
  const run = spawnSync(process.execPath, ["--experimental-vm-modules", "--test", suite], { encoding: "utf8", timeout: 30000 });
  assert.ifError(run.error);
  assert.equal(run.status, 0, run.stdout + run.stderr);
});

test("the harness's classic compiler loads only from the bench install, and its absence names the install", async (t) => {
  const repo = fileURLToPath(new URL("../../", import.meta.url));
  // Every harness importer goes through bench/typescript.mjs: a bare import beside only the
  // root install would load 7.0.2, which has no classic API. Nested apps have their own
  // packages; the validation test's sources are evaluated by the worker's pinned loader,
  // and this test's own probe below shows the fallback.
  const nested = spawnSync("git", ["-C", repo, "ls-files", "bench/**/package.json"], { encoding: "utf8" }).stdout.split("\n")
    .filter((path) => path && path !== "bench/package.json").map((path) => dirname(path) + "/");
  const grep = spawnSync("git", ["-C", repo, "grep", "-l", "-E", "(from |import\\(|require\\()[\"']typescript[\"']", "--", "bench"], { encoding: "utf8" });
  assert.ok([0, 1].includes(grep.status));
  assert.deepEqual(grep.stdout.split("\n").filter((path) => path && !nested.some((dir) => path.startsWith(dir))),
    ["bench/workloads/cloud-validation.test.mjs", "bench/workloads/tooling.test.mjs"]);

  const temp = mkdtempSync(join(tmpdir(), "bench-classic-compiler-")), links = [];
  t.after(() => {
    // Remove only our links, nonrecursively, so neither real install can be touched.
    for (const link of links) { assert.ok(lstatSync(link).isSymbolicLink()); if (process.platform === "win32") rmdirSync(link); else unlinkSync(link); }
    rmSync(temp, { recursive: true, force: true });
  });
  const link = (target, path) => { mkdirSync(dirname(path), { recursive: true }); symlinkSync(target, path, "junction"); links.push(path); };
  const root7 = realpathSync(join(repo, "node_modules/typescript")), bench6 = realpathSync(join(repo, "bench/node_modules/typescript"));
  // Each case is its own checkout layout with the root's 7.0.2 installed and the real entry point.
  const layout = (name, benchCompiler) => {
    const checkout = join(temp, name);
    link(root7, join(checkout, "node_modules/typescript"));
    if (benchCompiler) link(benchCompiler, join(checkout, "bench/node_modules/typescript"));
    mkdirSync(join(checkout, "bench"), { recursive: true });
    copyFileSync(join(repo, "bench/typescript.mjs"), join(checkout, "bench/typescript.mjs"));
    return pathToFileURL(join(checkout, "bench/typescript.mjs")).href;
  };
  const absent = layout("absent");
  // The control is real: from bench/, a bare import resolves the root's compiler.
  const probe = spawnSync(process.execPath, ["--input-type=module", "-e", 'import ts from "typescript"; console.log(ts.version, typeof ts.createSourceFile);'],
    { cwd: join(temp, "absent/bench"), encoding: "utf8" });
  assert.equal(probe.stdout.trim(), "7.0.2 undefined");
  const install = /run npm --prefix bench ci/;
  await assert.rejects(import(absent), install);
  await assert.rejects(import(layout("root-compiler-at-bench-path", root7)), install);
  const ts = (await import(layout("installed", bench6))).default;
  assert.equal(ts.version, JSON.parse(readFileSync(join(repo, "bench/package-lock.json"), "utf8")).packages["node_modules/typescript"].version);
  assert.equal(ts.createSourceFile("probe.js", "let x = 1;", ts.ScriptTarget.Latest).statements.length, 1);
});
