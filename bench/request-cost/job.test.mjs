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
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { allocatorReport, compare, readings } from "./compare.mjs";

const kit = dirname(fileURLToPath(import.meta.url));
const linux = process.platform === "linux" && spawnSync("bash", ["-c", "git --version"]).status === 0;
const skip = !linux && "needs Linux with bash and git";
const allocatorPlan = readings({ allocator: true });
const allocatorCases = Object.fromEntries(allocatorPlan.map(({ options, expect }) => [options.join(" "), expect]));

const standIns = {
  // sh build.sh <commit> <directory>: a probe that is a file, or a build that does not compile.
  "build.sh": [
    'echo "   Compiling probe v0.0.0"',
    'if [ "$1" = "${STAND_IN_FAILS:-}" ]; then echo "error: could not compile the probe" >&2; exit 101; fi',
    'if [ "$1" = "${STAND_IN_WAITS:-}" ]; then trap \'echo "build got TERM"; exit 0\' TERM; while :; do sleep 1; done; fi',
    'if [ "$1" = "${STAND_IN_HANGS:-}" ]; then trap \'\' TERM; echo "build waiting"; exec sleep 60; fi',
    'if [ "$1" = "${STAND_IN_KILLS:-}" ]; then sh -c \'echo "another process sent KILL"; kill -KILL "$1"\' killer "$$"; fi',
    'if [ "$1" = "${STAND_IN_EXITS_124:-}" ]; then echo "exiting 124" >&2; exit 124; fi',
    'mkdir -p "$2/bin"',
    'echo "#!/bin/sh" > "$2/bin/$1"',
    'if [ "$1" = "${STAND_IN_DIFFERS:-}" ]; then echo "# different probe" >> "$2/bin/$1"; fi',
    'chmod +x "$2/bin/$1"',
    'echo "built $2/bin/$1"',
  ],
  // node compare.mjs --readings: the two required runs or the separate idle diagnostic.
  "compare.mjs": [
    `if (process.argv.includes("--allocator")) console.log(${JSON.stringify(allocatorPlan.map(({ file, script, options }) => [file, script, ...options].join(" ")).join("\n"))});`,
    'else console.log("count-get.json count.mjs --json --cases get\\nidle-silent-1.json idle.mjs --json --allocator --silent");',
  ],
  // node count.mjs <probe> --cpu <cpu> <options>: notes the call, as `<commit> <options>`, and
  // does what STAND_IN_DOES says of that call's first time, second time and so on: refuses as the
  // kit does, exits 124, waits for or ignores TERM, or prints a line and ends. One allocator
  // stand-in can signal its own waiting job after writing the last complete line.
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
    '} else if (does === "exits 124") {',
    "  process.exit(124);",
    '} else if (does === "exits on TERM" || does === "ignores TERM") {',
    '  if (does === "exits on TERM") process.on("SIGTERM", () => process.exit(0));',
    '  if (does === "ignores TERM") {',
    '    process.on("SIGTERM", () => {});',
    '    console.error("Error: earlier output is not why this reading stopped");',
    '  }',
    '  process.stdout.write(\'{"kind":"instructions","case":"get","counts":[1001,\');',
    "  setInterval(() => {}, 1000);",
    '} else if (options.includes("--allocator")) {',
    `  const expect = ${JSON.stringify(allocatorCases)}[options.join(" ")];`,
    '  writeFileSync(1, JSON.stringify({ ...expect, page: 4096, before: 4096, after: 8192, grown: 4096, bytes: 1, allocator: { live: 17, threadNet: 1, active: 4096 }, sweepNanos: [1, 2] }) + "\\n");',
    '  if (does === "interrupts diagnostics") process.kill(Number(process.env.STAND_IN_JOB_PID), "SIGTERM");',
    "} else {",
    "  console.log(JSON.stringify({ call }));",
    "}",
  ],
};

/**
 * A copy of the kit that is job.sh and the stand-ins, and a checkout to run it in: a commit, a
 * change that left it, what the base gained since and, unless `merged` is false, their merge, as
 * a pull request's checkout is. `job(asked, ...args)` runs job.sh there.
 * @param {import("node:test").TestContext} t @param {{ merged?: boolean, escapedPath?: boolean }} [given]
 */
function fixture(t, { merged = true, escapedPath = false } = {}) {
  const at = mkdtempSync(join(tmpdir(), "request-cost-job-"));
  t.after(() => rmSync(at, { recursive: true, force: true }));
  const [copy, checkout, builds, calls] = ["kit", "checkout", escapedPath ? "builds\\with a backslash" : "builds", "calls"].map((name) => join(at, name));
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
    spawnSync("bash", ["-c", 'export STAND_IN_JOB_PID=$$; exec bash "$@"', "job fixture", join(copy, "job.sh"), ...args], { cwd: checkout, env: { ...env, STAND_IN_CALLS: calls, ...asked }, encoding: "utf8" });
  /** The calls of the stand-in for count.mjs and idle.mjs, in order. */
  const called = () => (existsSync(calls) ? readFileSync(calls, "utf8").trimEnd().split("\n") : []);
  const left = (/** @type {string} */ file) => (existsSync(join(builds, file)) ? readFileSync(join(builds, file), "utf8") : null);
  const compared = (description = "Request path: counted") => compare(join(builds, "base"), join(builds, "head"), { description });
  return { builds, base, head, job, called, left, compared };
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
    const { builds, job, called, left, compared } = made;
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
    assert.deepEqual(called(), [`${made[other]} --answers ${join(builds, other, "answers")}`, `${made[other]} --json --cases get`, `${made[other]} --json --allocator --silent`]);
    assert.deepEqual([left(`${other}/count-get.json`), left(`${failing}/count-get.json`), left(`${failing}/count-get.json.refused`)], [`${JSON.stringify({ call: `${made[other]} --json --cases get` })}\n`, null, null]);
    const { markdown, status } = compared("Request path: measured");
    assert.equal(status, failing === "head" ? 1 : 0);
    assert.ok(markdown.includes(`the probe did not build against ${failing} (\`the build failed, error: could not compile the probe\`)`), markdown);
    assert.equal(markdown.includes("a change it no longer builds against"), failing === "head");
    assert.doesNotMatch(markdown, /Nothing compared:/);
  });
}

test("both successful builds leave the checksum of their own probe even in a path with a backslash", { skip }, (t) => {
  const { builds, head, job, left } = fixture(t, { escapedPath: true });
  const built = job({ STAND_IN_DIFFERS: head }, "build", builds);
  assert.equal(built.status, 0, built.stderr);
  const sum = (/** @type {string} */ text) => `${createHash("sha256").update(text).digest("hex")}\n`;
  assert.equal(left("base/sha256"), sum("#!/bin/sh\n"));
  assert.equal(left("head/sha256"), sum("#!/bin/sh\n# different probe\n"));
});

for (const [side, end, code, minimum, said] of /** @type {const} */ ([
  ["base", "STAND_IN_WAITS", 124, 1, /build got TERM/],
  ["head", "STAND_IN_HANGS", 137, 11, /build waiting/],
  ["head", "STAND_IN_EXITS_124", 124, null, /exiting 124/],
  ["base", "STAND_IN_KILLS", 137, null, /another process sent KILL/],
])) {
  test(`a build on ${side} (${end}) reports status ${code} and seconds to the real verdict`, { skip }, (t) => {
    const made = fixture(t);
    const { builds, job, left, compared } = made;
    const built = job({ REQUEST_COST_BUILD_LIMIT: "1", [end]: made[side] }, "build", builds);
    assert.equal(built.status, 0, built.stderr);
    assert.match(built.stdout, said);
    const record = String(left(`${side}/unbuilt`));
    const found = new RegExp(`^the build ended with status ${code} after (\\d+) s \\(limit 1 s\\)\\n$`).exec(record);
    assert.ok(found, record);
    // Independent exits do not bound elapsed time: the caller might be scheduled late.
    if (minimum !== null) assert.ok(Number(found[1]) >= minimum, record);
    assert.equal(left(`${side}/sha256`), null);
    const { markdown, status } = compared("Request path: measured");
    assert.equal(status, 1);
    assert.ok(markdown.includes(`**Nothing compared:** no probe from ${side} (\`${record.trim()}\`).`), markdown);
    assert.match(markdown, /may be run again/);
    assert.doesNotMatch(markdown, /a change it no longer builds against/);
  });
}

test("a run the kit refuses is taken again, once, with why kept, and a run that gave its output is not taken again", { skip }, (t) => {
  const { builds, base, head, job, called, left, compared } = fixture(t);
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
    `${base} --json --allocator --silent`,
    `${head} --json --allocator --silent`,
  ]);
  // The second attempt's output, the first's reason and nothing else of either.
  assert.equal(left("head/count-get.json"), `${JSON.stringify({ call: refused })}\n`);
  assert.equal(left("head/count-get.json.refused"), "Error: not a count: the stand-in refuses\n");
  assert.match(compared().markdown, /^- `count-get\.json` on head: `not a count: the stand-in refuses`$/m);
  assert.deepEqual(readdirSync(join(builds, "head")).sort(), ["answers", "build.log", "commit", "count-get.json", "count-get.json.refused", "idle-silent-1.json", "sha256"]);
  assert.deepEqual(readdirSync(join(builds, "base")).sort(), ["answers", "build.log", "commit", "count-get.json", "idle-silent-1.json", "sha256"]);
});

test("explicit diagnostics run only the observer-on idle plan on both builds and leave the required readings intact", { skip }, (t) => {
  const { builds, base, head, job, called, left } = fixture(t);
  assert.equal(job({ STAND_IN_DIFFERS: head }, "build", builds).status, 0);
  const env = { STOP_AT: later() };
  assert.equal(job(env, "read", builds, "3").status, 0);
  const required = called();
  const counted = ["base", "head"].map((side) => left(`${side}/idle-silent-1.json`));
  assert.ok(counted.every((receipt) => receipt && JSON.parse(receipt).allocator?.live === 17));
  assert.equal(left("base/idle-allocator-silent-1.json"), null);
  const directory = join(builds, "fresh diagnostics");
  const diagnose = job(env, "diagnose", builds, "3", directory);
  assert.equal(diagnose.status, 0, diagnose.stderr);
  assert.deepEqual(called().slice(required.length), allocatorPlan.flatMap(({ options }) => [base, head].map((commit) => [commit, ...options].join(" "))));
  const report = allocatorReport(directory);
  assert.equal(report.status, 0, report.markdown);
  assert.match(report.markdown, /Every diagnostic pair is present/);
  assert.equal(report.markdown.split("\n")[0], `## Idle allocator diagnostics: \`${head.slice(0, 9)}\` and \`${base.slice(0, 9)}\``);
  assert.deepEqual(["base", "head"].map((side) => left(side + "/idle-silent-1.json")), counted);
  assert.equal(left("base/idle-allocator-silent-1.json"), null);

  // Seed the former locations with valid receipts, then point the build record at an absent
  // executable. Neither those old files nor the old complete directory may supply a new pair.
  for (const side of ["base", "head"]) for (const { file } of allocatorPlan) {
    copyFileSync(join(directory, side, file), join(builds, side, file));
  }
  assert.equal(allocatorReport(builds).status, 1);
  writeFileSync(join(builds, "head", "commit"), "f".repeat(40) + "\n");
  const before = called();
  const reused = job(env, "diagnose", builds, "3", directory);
  assert.equal(reused.status, 1, reused.stderr);
  assert.match(reused.stderr, /give a new diagnostic directory/);
  assert.deepEqual(allocatorReport(directory), report);
  const next = join(builds, "missing executable");
  const absent = job(env, "diagnose", builds, "3", next);
  assert.equal(absent.status, 1, absent.stderr);
  assert.match(absent.stderr, /no executable probe for head/);
  assert.equal(allocatorReport(next).status, 1);
  assert.ok(!existsSync(join(next, "complete")));
  assert.deepEqual(called(), before);
});

for (const failure of ["replaced executable", "missing checksum"]) {
  test(`diagnostics do not launch either probe with a ${failure} on head`, { skip }, (t) => {
    const { builds, head, job, called } = fixture(t);
    assert.equal(job({}, "build", builds).status, 0);
    // Base is valid. Resolve and check head before letting even the base probe run.
    if (failure === "replaced executable") {
      writeFileSync(join(builds, "bin", head), "#!/bin/sh\n# replacement probe\n");
    } else {
      rmSync(join(builds, "head", "sha256"));
    }
    const directory = join(builds, "refused diagnostics");
    const result = job({ STOP_AT: later() }, "diagnose", builds, "3", directory);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, failure === "replaced executable" ? /probe checksum does not match the build for head/ : /no build checksum for head/);
    assert.deepEqual(called(), []);
    assert.equal(allocatorReport(directory).status, 1);
  });
}

test("diagnostics do not run either probe when one side was skipped by the build", { skip }, (t) => {
  const { builds, base, head, job, called } = fixture(t);
  assert.equal(job({ STAND_IN_FAILS: head }, "build", builds).status, 0);
  // A failed build may leave an executable. The unbuilt marker still makes it ineligible.
  copyFileSync(join(builds, "bin", base), join(builds, "bin", head));
  chmodSync(join(builds, "bin", head), 0o755);
  const directory = join(builds, "skipped diagnostics");
  const result = job({ STOP_AT: later() }, "diagnose", builds, "3", directory);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /no executable probe for head/);
  assert.deepEqual(called(), []);
  assert.equal(allocatorReport(directory).status, 1);
});

test("interrupting diagnostics after the last JSON cannot publish a complete pair", { skip }, (t) => {
  const { builds, head, job } = fixture(t);
  assert.equal(job({}, "build", builds).status, 0);
  const directory = join(builds, "interrupted diagnostics");
  const last = allocatorPlan.at(-1);
  assert.ok(last);
  const call = [head, ...last.options].join(" ");
  const result = job({
    STOP_AT: later(),
    STAND_IN_DOES: JSON.stringify({ [call]: ["", "", "interrupts diagnostics"] }),
  }, "diagnose", builds, "3", directory);
  assert.equal(result.signal, "SIGTERM", result.stderr);
  for (const side of ["base", "head"]) for (const { file } of allocatorPlan) {
    assert.equal(JSON.parse(readFileSync(join(directory, side, file), "utf8")).kind, "idle-allocator");
  }
  assert.ok(!existsSync(join(directory, "complete")));
  const report = allocatorReport(directory);
  assert.equal(report.status, 1);
  assert.match(report.markdown, /No valid completion record/);
});

test("a reading that exits 124 early records its status and seconds and is taken again", { skip }, (t) => {
  const { builds, head, job, left, compared } = fixture(t);
  assert.equal(job({ STAND_IN_DIFFERS: head }, "build", builds).status, 0);
  const call = `${head} --json --cases get`;
  const read = job({ STOP_AT: later(), STAND_IN_DOES: JSON.stringify({ [call]: ["exits 124"] }) }, "read", builds, "3");
  assert.equal(read.status, 0, read.stderr);
  const record = String(left("head/count-get.json.refused"));
  const found = /^Error: (the reading ended with status 124 after \d+ s \(limit 120 s\))\n$/.exec(record);
  assert.ok(found, record);
  assert.equal(left("head/count-get.json"), `${JSON.stringify({ call })}\n`);
  assert.ok(compared().markdown.includes(`- \`count-get.json\` on head: \`${found[1]}\`\n`));
});

for (const [how, code, grace] of /** @type {const} */ ([["exits on TERM", 124, 0], ["ignores TERM", 137, 10]])) {
  test(`a run that ${how} when the time is spent leaves no figure, and no run starts after it`, { skip }, (t) => {
    const { builds, base, head, job, called, left, compared } = fixture(t);
    assert.equal(job({ STAND_IN_DIFFERS: head }, "build", builds).status, 0);
    const hung = `${base} --json --cases get`;
    const read = job({ STOP_AT: later(4), STAND_IN_DOES: JSON.stringify({ [hung]: [how, how] }) }, "read", builds, "3");
    assert.equal(read.status, 0, read.stderr);
    // Stopped with part of a line printed: no file, so no figure, and it is not taken again.
    assert.equal(left("base/count-get.json"), null);
    const record = String(left("base/count-get.json.refused"));
    const found = new RegExp(`^Error: (the reading ended with status ${code} after (\\d+) s \\(limit ([1-4]) s\\))\\n$`).exec(record);
    assert.ok(found, record);
    assert.ok(Number(found[2]) >= Number(found[3]) + grace, record);
    assert.ok(compared().markdown.includes(`- \`count-get.json\` on base: \`${found[1]}\`\n`));
    assert.deepEqual(called().slice(2), [hung]);
    for (const file of ["head/count-get.json", "base/idle-silent-1.json", "head/idle-silent-1.json"]) {
      assert.deepEqual([left(file), left(`${file}.refused`)], [null, "not attempted, the job's time for readings was spent\n"], file);
    }
  });
}
