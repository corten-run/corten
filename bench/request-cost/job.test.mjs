// node --test bench/request-cost/job.test.mjs
// job.sh, which the hosted job runs, run whole in a copy of the kit whose build.sh, count.mjs,
// idle.mjs and compare.mjs are stand-ins, in a checkout made here: what it builds and runs, and
// what it leaves when there is no merge base, a build fails, a run is refused or the time is
// spent. Nothing is built or counted. It is a bash script that uses git and timeout, so these run
// on Linux and are skipped elsewhere.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const kit = dirname(fileURLToPath(import.meta.url));
const linux = process.platform === "linux" && spawnSync("bash", ["-c", "git --version && timeout 1 true"]).status === 0;
const skip = !linux && "needs Linux with bash, git and timeout";

const standIns = {
  // sh build.sh <commit> <directory>: a probe that is a file, or a build that does not compile.
  "build.sh": [
    'echo "   Compiling probe v0.0.0"',
    'if [ "$1" = "${STAND_IN_FAILS:-}" ]; then echo "error: could not compile the probe" >&2; exit 101; fi',
    'mkdir -p "$2/bin"',
    'echo "#!/bin/sh" > "$2/bin/$1"',
    'chmod +x "$2/bin/$1"',
    'if [ "$1" = "${STAND_IN_WITHOUT:-}" ]; then echo without; else echo with; fi > "$2/bin/$1.own-http1"',
    'echo "built $2/bin/$1"',
  ],
  // node compare.mjs --readings: two runs to take on each build.
  "compare.mjs": ['console.log("count-get.json count.mjs --json --cases get\\nidle-silent-1.json idle.mjs --json --silent");'],
  // node count.mjs <probe> --cpu <cpu> <options>: notes the call, as `<commit> <options>`, and
  // does what STAND_IN_DOES says of that call's first time, second time and so on: "refuses" as
  // the kit does, "hangs" with part of a line printed, and otherwise prints a line and ends.
  "count.mjs": [
    'import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";',
    'import { basename, join } from "node:path";',
    "const [probe, , , ...options] = process.argv.slice(2);",
    'const call = `${basename(probe)} ${options.join(" ")}`;',
    "const calls = process.env.STAND_IN_CALLS;",
    'const before = existsSync(calls) ? readFileSync(calls, "utf8").split("\\n").filter((line) => line === call).length : 0;',
    "appendFileSync(calls, `${call}\\n`);",
    'const does = JSON.parse(process.env.STAND_IN_DOES ?? "{}")[call]?.[before];',
    'if (options[0] === "--answers") {',
    "  mkdirSync(options[1], { recursive: true });",
    '  writeFileSync(join(options[1], "get.http"), "an answer");',
    '} else if (does === "refuses") {',
    '  console.error("valgrind: a line that is not the reason\\nError: not a count: the stand-in refuses\\n    at a line of a stack");',
    "  process.exit(1);",
    '} else if (does === "hangs") {',
    '  process.stdout.write(\'{"kind":"instructions","case":"get","counts":[1001,\');',
    "  setInterval(() => {}, 1000);",
    "} else {",
    "  console.log(JSON.stringify({ call }));",
    "}",
  ],
};

/**
 * A copy of the kit that is job.sh and the stand-ins, and a checkout to run it in: a commit, a
 * change that left it, what the base gained since and, unless `merged` is false, their merge, as
 * a pull request's checkout is. `job(asked, ...args)` runs job.sh there.
 * @param {import("node:test").TestContext} t @param {{ merged?: boolean }} [given]
 */
function fixture(t, { merged = true } = {}) {
  const at = mkdtempSync(join(tmpdir(), "request-cost-job-"));
  t.after(() => rmSync(at, { recursive: true, force: true }));
  const [copy, checkout, builds, calls] = ["kit", "checkout", "builds", "calls"].map((name) => join(at, name));
  mkdirSync(copy);
  mkdirSync(checkout);
  copyFileSync(join(kit, "job.sh"), join(copy, "job.sh"));
  for (const [name, lines] of Object.entries(standIns)) writeFileSync(join(copy, name), `${name.endsWith(".sh") ? "#!/bin/sh\n" : ""}${lines.join("\n")}\n`);
  copyFileSync(join(copy, "count.mjs"), join(copy, "idle.mjs"));
  // The caller's GIT_DIR and the like would choose another repository.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
  const git = (/** @type {string[]} */ ...args) => {
    const run = spawnSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: checkout, env, encoding: "utf8" });
    assert.equal(run.status, 0, `git ${args.join(" ")}: ${run.stderr}`);
    return run.stdout.trim();
  };
  const commit = (/** @type {string} */ message) => git("commit", "-q", "--allow-empty", "-m", message) || git("rev-parse", "HEAD");
  git("init", "-q", "-b", "main");
  const base = commit("where the change left the base");
  let head = "";
  if (merged) {
    git("switch", "-q", "-c", "change");
    head = commit("the change");
    git("switch", "-q", "main");
    commit("what the base gained since");
    git("merge", "-q", "--no-ff", "--no-edit", "change");
  }
  const job = (/** @type {Record<string, string>} */ asked, /** @type {string[]} */ ...args) =>
    spawnSync("bash", [join(copy, "job.sh"), ...args], { cwd: checkout, env: { ...env, STAND_IN_CALLS: calls, ...asked }, encoding: "utf8" });
  /** The calls of the stand-in for count.mjs and idle.mjs, in order. */
  const called = () => (existsSync(calls) ? readFileSync(calls, "utf8").trimEnd().split("\n") : []);
  const left = (/** @type {string} */ file) => (existsSync(join(builds, file)) ? readFileSync(join(builds, file), "utf8") : null);
  return { builds, base, head, job, called, left };
}

/** An hour from now, and `seconds` from now, in seconds since the epoch. */
const later = (seconds = 3600) => String(Math.floor(Date.now() / 1000) + seconds);

test("with no merge base job.sh fails, and builds nothing", { skip }, (t) => {
  const { builds, job } = fixture(t, { merged: false });
  const built = job({}, "build", builds);
  assert.equal(built.status, 1, built.stderr);
  assert.match(built.stdout, /^::error::the checkout is not the pull request's merge, or its parents have no merge base/m);
  assert.ok(!existsSync(builds), "something was made");
});

for (const failing of /** @type {const} */ (["base", "head"])) {
  test(`a build against ${failing} that fails leaves why, fails nothing, and that build is not run at all`, { skip }, (t) => {
    const made = fixture(t);
    const { builds, job, called, left } = made;
    const other = failing === "base" ? "head" : "base";
    const built = job({ STAND_IN_FAILS: made[failing] }, "build", builds);
    assert.equal(built.status, 0, built.stderr);
    // The merge base and the merge's second parent, not the base's branch as it now is.
    assert.deepEqual([left("base/commit"), left("head/commit")], [`${made.base}\n`, `${made.head}\n`]);
    assert.deepEqual([left(`${failing}/unbuilt`), left(`${other}/unbuilt`)], ["the build failed, error: could not compile the probe\n", null]);
    assert.deepEqual(readdirSync(join(builds, "bin")).sort(), [made[other], `${made[other]}.own-http1`]);
    assert.match(built.stdout, new RegExp(`^::warning::the probe did not build against ${failing} ${made[failing]}$`, "m"));
    // A build that was stopped can have left a binary: it is still not run.
    writeFileSync(join(builds, "bin", made[failing]), "#!/bin/sh\n");
    chmodSync(join(builds, "bin", made[failing]), 0o755);
    const read = job({ STOP_AT: later() }, "read", builds, "3");
    assert.equal(read.status, 0, read.stderr);
    assert.deepEqual(called(), [`${made[other]} --answers ${join(builds, other, "answers")}`, `${made[other]} --json --cases get`, `${made[other]} --json --silent`]);
    assert.deepEqual([left(`${other}/count-get.json`), left(`${failing}/count-get.json`), left(`${failing}/count-get.json.refused`)], [`${JSON.stringify({ call: `${made[other]} --json --cases get` })}\n`, null, null]);
  });
}

test("a run the kit refuses is taken again, once, with why kept, and a run that gave its output is not taken again", { skip }, (t) => {
  const { builds, base, head, job, called, left } = fixture(t);
  assert.equal(job({ STAND_IN_WITHOUT: base }, "build", builds).status, 0);
  const refused = `${head} --json --cases get`;
  const read = job({ STOP_AT: later(), STAND_IN_DOES: JSON.stringify({ [refused]: ["refuses"] }) }, "read", builds, "3");
  assert.equal(read.status, 0, read.stderr);
  assert.deepEqual(called(), [
    `${base} --answers ${join(builds, "base", "answers")}`,
    `${head} --answers ${join(builds, "head", "answers")}`,
    `${base} --json --cases get`,
    refused,
    refused,
    `${base} --json --silent`,
    `${head} --json --silent`,
  ]);
  // The second attempt's output, the first's reason and nothing else of either.
  assert.equal(left("head/count-get.json"), `${JSON.stringify({ call: refused })}\n`);
  assert.equal(left("head/count-get.json.refused"), "Error: not a count: the stand-in refuses\n");
  assert.deepEqual([left("base/own-http1"), left("head/own-http1")], ["without\n", "with\n"]);
  assert.deepEqual(readdirSync(join(builds, "head")).sort(), ["answers", "build.log", "commit", "count-get.json", "count-get.json.refused", "idle-silent-1.json", "own-http1"]);
  assert.deepEqual(readdirSync(join(builds, "base")).sort(), ["answers", "build.log", "commit", "count-get.json", "idle-silent-1.json", "own-http1"]);
});

for (const skipHead of ["without an executable", "with unbuilt", "past the cutoff"]) {
  test(`a second read ${skipHead} leaves no evidence from the first read`, { skip }, (t) => {
    const { builds, base, head, job, called, left } = fixture(t);
    assert.equal(job({}, "build", builds).status, 0);
    const count = `${head} --json --cases get`;
    const first = job({ STOP_AT: later(), STAND_IN_DOES: JSON.stringify({ [count]: ["refuses"] }) }, "read", builds, "3");
    assert.equal(first.status, 0, first.stderr);
    assert.equal(left("head/answers/get.http"), "an answer");
    assert.ok(left("head/count-get.json"));
    assert.ok(left("head/idle-silent-1.json"));
    assert.equal(left("head/count-get.json.refused"), "Error: not a count: the stand-in refuses\n");
    assert.equal(left("head/own-http1"), "with\n");
    writeFileSync(join(builds, "head/answers/get-own.unsupported"), "an old refusal\n");
    writeFileSync(join(builds, "head/idle-silent-1.json.said"), "an interrupted write\n");
    writeFileSync(join(builds, "head/notes"), "leave unrelated files alone\n");
    if (skipHead === "without an executable") rmSync(join(builds, "bin", head));
    if (skipHead === "with unbuilt") writeFileSync(join(builds, "head/unbuilt"), "the probe did not build\n");
    const cutoff = skipHead === "past the cutoff";
    const before = called().length;
    const second = job({ STOP_AT: later(cutoff ? -1 : 3600) }, "read", builds, "3");
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(called().slice(before), cutoff ? [] : [`${base} --answers ${join(builds, "base", "answers")}`, `${base} --json --cases get`, `${base} --json --silent`]);
    for (const file of ["answers/get.http", "answers/get-own.unsupported", "count-get.json", "idle-silent-1.json", "idle-silent-1.json.said"]) assert.equal(left(`head/${file}`), null, file);
    assert.equal(left("head/count-get.json.refused"), cutoff ? "not attempted, the job's time for readings was spent\n" : null);
    assert.equal(left("head/own-http1"), cutoff ? "with\n" : null);
    if (cutoff) {
      assert.equal(left("base/answers/get.http"), null);
      assert.equal(left("base/count-get.json"), null);
    }
    assert.equal(left("head/notes"), "leave unrelated files alone\n");
    assert.equal(left("head/commit"), `${head}\n`);
    assert.match(String(left("head/build.log")), /built /);
    assert.equal(left("head/unbuilt"), skipHead === "with unbuilt" ? "the probe did not build\n" : null);
  });
}

test("a run stopped when the time is spent leaves none of what it had printed, and no run starts after it", { skip }, (t) => {
  const { builds, base, job, called, left } = fixture(t);
  assert.equal(job({}, "build", builds).status, 0);
  const hung = `${base} --json --cases get`;
  const read = job({ STOP_AT: later(4), STAND_IN_DOES: JSON.stringify({ [hung]: ["hangs", "hangs"] }) }, "read", builds, "3");
  assert.equal(read.status, 0, read.stderr);
  // Stopped with part of a line printed: no file, so no figure, and it is not taken again.
  assert.equal(left("base/count-get.json"), null);
  assert.match(String(left("base/count-get.json.refused")), /^Error: did not end in [1-4] s\n$/);
  assert.deepEqual(called().slice(2), [hung]);
  for (const file of ["head/count-get.json", "base/idle-silent-1.json", "head/idle-silent-1.json"]) {
    assert.deepEqual([left(file), left(`${file}.refused`)], [null, "not attempted, the job's time for readings was spent\n"], file);
  }
});
