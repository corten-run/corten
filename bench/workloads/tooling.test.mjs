import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
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
  const [command, ...rest] = sourceChecks.run.trimEnd().split("\n");
  assert.equal(command, "$PLAYWRIGHT_SOURCE env MIXED_BROWSER_TESTS=1 npm run check:groups:browser");
  assert.deepEqual(rest, ['echo group-apparatus >> "$RUNNER_TEMP/ran"']);
  // The group whose step replays sources is the one that builds the test-tools image.
  assert.equal(sourceChecks.if, "contains(env.PARTS, ' group-apparatus ')");
  assert.ok(step.run.includes('if [[ "$PARTS" == *" group-apparatus "* ]]; then'));
  assert.doesNotMatch(step.run, /safe\.directory/);
  const dockerfile = readFileSync(new URL("test-tools.Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /^ARG PLAYWRIGHT_IMAGE\r?\nFROM \$\{PLAYWRIGHT_IMAGE\} AS playwright\r?\nFROM playwright AS build/m);
  assert.doesNotMatch(dockerfile, /launchpad|add-apt-repository/);
  assert.match(dockerfile, /RUN sh \/tmp\/verify-git\.sh\r?\nRUN --network=none tar -xf git\.tar/);
  assert.match(dockerfile, /FROM playwright\r?\nCOPY --from=build \/out\/ \/\r?\nRUN --network=none/);
  assert.match(dockerfile, /if git --no-replace-objects --no-lazy-fetch [^\n]+then exit 1/);
});

test("a substituted CI Git archive fails before extraction or another download", { skip: process.platform !== "linux" }, t => {
  const cwd = mkdtempSync(join(tmpdir(), "ci-git-release-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(join(cwd, "curl"), '#!/bin/sh\nset -eu\nwhile test "$1" != -o; do shift; done\necho "$2" >> calls\nprintf substitute > "$2"\n', { mode: 0o700 });
  symlinkSync("/usr/bin/sha256sum", join(cwd, "sha256sum"));
  const script = fileURLToPath(new URL("../../scripts/benchmark-evidence-git.sh", import.meta.url));
  const r = spawnSync("/bin/sh", [script], { cwd, env: { PATH: cwd, HOME: cwd }, encoding: "utf8", timeout: 5000 });
  assert.ifError(r.error); assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /git.tar.xz: FAILED/);
  assert.equal(readFileSync(join(cwd, "calls"), "utf8"), "git.tar.xz\n");
  assert.equal(existsSync(join(cwd, "git.tar")), false);
});

test("CI requires gpgv success and the pinned Git signing subkey and primary", { skip: process.platform !== "linux" }, t => {
  const root = mkdtempSync(join(tmpdir(), "ci-git-signer-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // The preceding test exercises the actual archive hash. Here drive the verifier's
  // status interface without a live keyserver or the release signer's private key.
  const signing = "E1F036B1FEE7221FC778ECEFB0B5E88696AFE6CB", primary = "96E07AF25771955980DAD10020D04E5A713660A7";
  for (const [command, body] of Object.entries({
    curl: 'while test "$1" != -o; do shift; done; touch "$2"', sha256sum: "cat >/dev/null", gpg: "exit 0", xz: "exit 0",
    gpgv: 'test "$1 $2 $3 $4 $5 $6" = "--status-fd 1 --keyring $PWD/release-key.gpg git.tar.sign git.tar" || exit 8\necho "[GNUPG:] VALIDSIG $SIGNING ... $PRIMARY"\nexit "$CODE"',
  })) writeFileSync(join(root, command), `#!/bin/sh\n${body}\n`, { mode: 0o700 });
  for (const command of ["awk", "cat", "mkdir", "touch"]) symlinkSync("/usr/bin/" + command, join(root, command));
  for (const [label, key, signer, code, expected] of [
    ["approved", signing, primary, 0, 0], ["bad signature", signing, primary, 1, 1],
    ["foreign primary", signing, "OTHER", 0, 1], ["foreign subkey", "OTHER", primary, 0, 1],
  ]) {
    const cwd = join(root, label); mkdirSync(cwd);
    const script = fileURLToPath(new URL("../../scripts/benchmark-evidence-git.sh", import.meta.url));
    const r = spawnSync("/bin/sh", [script], { cwd, env: { PATH: root, HOME: cwd,
      SIGNING: key, PRIMARY: signer, CODE: String(code) }, timeout: 5000, encoding: "utf8" });
    assert.ifError(r.error); assert.equal(r.status, expected, label + ": " + r.stderr);
  }
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
