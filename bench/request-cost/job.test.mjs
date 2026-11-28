// node --test bench/request-cost/job.test.mjs
// job.sh, which the hosted job runs, run whole in a copy of the kit whose build.sh, count.mjs,
// idle.mjs and compare.mjs are stand-ins, in a checkout made here: what it builds and runs, and
// what it leaves when there is no merge base, a build fails, a run is refused or the time is
// spent. The real compare.mjs reads the recorded failures. Nothing is built or counted. It is a
// bash script that uses git and Linux process groups, so these run on Linux only.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { compare } from "./compare.mjs";

const kit = dirname(fileURLToPath(import.meta.url));
const linux = process.platform === "linux" && spawnSync("bash", ["-c", "git --version"]).status === 0;
const skip = !linux && "needs Linux with bash and git";

const standIns = {
  // sh build.sh <commit> <directory>: a probe that is a file, or a build that does not compile.
  "build.sh": [
    'echo "   Compiling probe v0.0.0"',
    'if [ "$1" = "${STAND_IN_FAILS:-}" ]; then echo "error: could not compile the probe" >&2; exit 101; fi',
    'if [ "$1" = "${STAND_IN_HANGS:-}" ]; then trap \'\' TERM; echo "build waiting"; while :; do sleep 1; done; fi',
    'if [ "$1" = "${STAND_IN_KILLS:-}" ]; then echo "build killed itself"; kill -KILL "$$"; fi',
    'if [ "$1" = "${STAND_IN_EXITS_124:-}" ]; then echo deadline >&2; exit 124; fi',
    'if [ "$1" = "${STAND_IN_CANCELS:-}" ]; then trap \'\' TERM; echo "build cancelled the wrapper"; kill -TERM "$PPID"; while :; do sleep 1; done; fi',
    'mkdir -p "$2/bin"',
    'echo "#!/bin/sh" > "$2/bin/$1"',
    'if [ "$1" = "${STAND_IN_DIFFERS:-}" ]; then echo "# different probe" >> "$2/bin/$1"; fi',
    'chmod +x "$2/bin/$1"',
    'echo "built $2/bin/$1"',
  ],
  // node compare.mjs --readings: two runs to take on each build.
  "compare.mjs": ['console.log("count-get.json count.mjs --json --cases get\\nidle-silent-1.json idle.mjs --json --silent");'],
  // node count.mjs <probe> --cpu <cpu> <options>: notes the call, as `<commit> <options>`, and
  // does what STAND_IN_DOES says of that call's first time, second time and so on: "refuses" as
  // the kit does, waits for or ignores TERM with part of a line printed, and otherwise prints a line and ends.
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
    '} else if (does === "exits on TERM" || does === "ignores TERM") {',
    '  if (does === "exits on TERM") process.on("SIGTERM", () => process.exit(0));',
    '  if (does === "ignores TERM") {',
    '    process.on("SIGTERM", () => {});',
    '    console.error("Error: earlier output is not why this reading stopped");',
    '  }',
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
  for (const file of ["job.sh", "deadline.mjs"]) copyFileSync(join(kit, file), join(copy, file));
  for (const [name, lines] of Object.entries(standIns)) writeFileSync(join(copy, name), `${name.endsWith(".sh") ? "#!/bin/sh\n" : ""}${lines.join("\n")}\n`);
  copyFileSync(join(copy, "count.mjs"), join(copy, "idle.mjs"));
  // Shorten long waits but run the real wrapper, including both of its signals and its status.
  writeFileSync(join(copy, "node"), `#!/bin/sh
case "$1" in
  */deadline.mjs)
    script=$1 limit=$2
    shift 3
    if [ "$limit" = 420 ]; then limit=1; fi
    set -- "$script" "$limit" 0.2 "$@"
    ;;
esac
exec "$STAND_IN_REAL_NODE" "$@"
`, { mode: 0o755 });
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
  const fast = { PATH: `${copy}${delimiter}${env.PATH}`, STAND_IN_REAL_NODE: process.execPath };
  /** The calls of the stand-in for count.mjs and idle.mjs, in order. */
  const called = () => (existsSync(calls) ? readFileSync(calls, "utf8").trimEnd().split("\n") : []);
  const left = (/** @type {string} */ file) => (existsSync(join(builds, file)) ? readFileSync(join(builds, file), "utf8") : null);
  const compared = (description = "Request path: counted") => compare(join(builds, "base"), join(builds, "head"), { description });
  return { builds, base, head, job, called, left, fast, compared };
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
    // A build that built leaves its probe's checksum, and one that failed none.
    assert.deepEqual([left(`${failing}/sha256`), left(`${other}/sha256`)], [null, `${createHash("sha256").update("#!/bin/sh\n").digest("hex")}\n`]);
    assert.deepEqual(readdirSync(join(builds, "bin")), [made[other]]);
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

test("both successful builds leave the checksum of their own probe", { skip }, (t) => {
  const { builds, head, job, left } = fixture(t);
  const built = job({ STAND_IN_DIFFERS: head }, "build", builds);
  assert.equal(built.status, 0, built.stderr);
  const sum = (/** @type {string} */ text) => `${createHash("sha256").update(text).digest("hex")}\n`;
  assert.equal(left("base/sha256"), sum("#!/bin/sh\n"));
  assert.equal(left("head/sha256"), sum("#!/bin/sh\n# different probe\n"));
});

test("a build killed by the wrapper after its deadline leaves the timeout for the real verdict", { skip }, (t) => {
  for (const side of /** @type {const} */ (["base", "head"])) {
    const made = fixture(t);
    const { builds, job, left, fast, compared } = made;
    const built = job({ ...fast, STAND_IN_HANGS: made[side] }, "build", builds);
    assert.equal(built.status, 0, built.stderr);
    assert.match(built.stdout, /^build waiting$/m);
    const { markdown, status } = compared();
    assert.equal(status, 1);
    if (side === "head") {
      assert.match(markdown, /^\*\*Nothing compared:\*\* the probe's build against head did not end in its time \(`the build did not end in 420 s`\), which says nothing of the change\..*may be run again:/m);
      assert.doesNotMatch(markdown, /a change it no longer builds against/);
    } else {
      assert.match(markdown, /^\*\*Does not pass as counted:\*\* the probe did not build against base \(`the build did not end in 420 s`\)/m);
    }
    assert.equal(left(`${side}/unbuilt`), "the build did not end in 420 s\n");
    assert.equal(left(`${side}/sha256`), null);
  }
});

test("a build killed independently, returning 124 or cancelled externally is not a deadline", { skip }, (t) => {
  for (const [end, reason] of [["STAND_IN_KILLS", "build killed itself"], ["STAND_IN_EXITS_124", "deadline"], ["STAND_IN_CANCELS", "build cancelled the wrapper"]]) {
    const { builds, head, job, left, fast, compared } = fixture(t);
    const built = job({ ...fast, [end]: head }, "build", builds);
    assert.equal(built.status, 0, built.stderr);
    assert.equal(left("head/unbuilt"), `the build failed, ${reason}\n`);
    const { markdown, status } = compared("Request path: measured");
    assert.equal(status, 1);
    assert.match(markdown, /a change it no longer builds against/);
    assert.doesNotMatch(markdown, /Nothing compared:|did not end in its time/);
  }
});

test("a run the kit refuses is taken again, once, with why kept, and a run that gave its output is not taken again", { skip }, (t) => {
  const { builds, base, head, job, called, left } = fixture(t);
  const built = job({}, "build", builds);
  assert.equal(built.status, 0);
  // Two builds whose probes are the same bytes leave the same checksum, which the log gives.
  const sum = `${createHash("sha256").update("#!/bin/sh\n").digest("hex")}\n`;
  assert.deepEqual([left("base/sha256"), left("head/sha256")], [sum, sum]);
  for (const side of ["base", "head"]) assert.match(built.stdout, new RegExp(`^the probe built against ${side}: sha256 ${sum.trim()}$`, "m"));
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
  assert.deepEqual(readdirSync(join(builds, "head")).sort(), ["answers", "build.log", "commit", "count-get.json", "count-get.json.refused", "idle-silent-1.json", "sha256"]);
  assert.deepEqual(readdirSync(join(builds, "base")).sort(), ["answers", "build.log", "commit", "count-get.json", "idle-silent-1.json", "sha256"]);
});

for (const how of ["exits on TERM", "ignores TERM"]) {
  test(`a run that ${how} when the time is spent leaves no figure, and no run starts after it`, { skip }, (t) => {
    const { builds, base, head, job, called, left, fast, compared } = fixture(t);
    assert.equal(job({ STAND_IN_DIFFERS: head }, "build", builds).status, 0);
    const hung = `${base} --json --cases get`;
    const read = job({ ...fast, STOP_AT: later(4), STAND_IN_DOES: JSON.stringify({ [hung]: [how, how] }) }, "read", builds, "3");
    assert.equal(read.status, 0, read.stderr);
    // Stopped with part of a line printed: no file, so no figure, and it is not taken again.
    assert.equal(left("base/count-get.json"), null);
    assert.match(String(left("base/count-get.json.refused")), /^Error: did not end in [1-4] s\n$/);
    assert.match(compared().markdown, /^- `count-get\.json` on base: `did not end in [1-4] s`$/m);
    assert.deepEqual(called().slice(2), [hung]);
    for (const file of ["head/count-get.json", "base/idle-silent-1.json", "head/idle-silent-1.json"]) {
      assert.deepEqual([left(file), left(`${file}.refused`)], [null, "not attempted, the job's time for readings was spent\n"], file);
    }
  });
}
