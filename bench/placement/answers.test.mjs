// answers.mjs on its own: the one request turns.sh's and verify.sh's checks send, an answer of
// another status refused, each answer taken from the bytes received alone, every file created new
// (a link put in its place first refused), the handoff the trend and verify.sh read a comparison
// by, and a recorded turn's perf and wrk output. On every platform, with servers of its own.
import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { compare, create, difference, handoff, masked, Refusal, request, sha256, turn } from "./answers.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "placement-answers-")));
after(() => rmSync(tmp, { recursive: true, force: true }));
let made = 0;
const fresh = () => { const d = join(tmp, `a-${++made}`); mkdirSync(d); return d; };

/** A server on a port of its own: answer(q, s) answers each request. Resolves to { port, asked, close }. */
async function serving(answer) {
  const asked = [];
  const s = createServer((q, r) => { asked.push({ url: q.url, names: q.rawHeaders.filter((_, i) => i % 2 === 0) }); answer(q, r); });
  await new Promise((done) => s.listen(0, "127.0.0.1", done));
  return { port: s.address().port, asked, close: () => new Promise((done) => { s.closeAllConnections(); s.close(done); }) };
}
const plain = (body, more = {}) => (q, s) => { s.setHeader("content-type", "text/plain"); for (const [k, v] of Object.entries(more)) s.setHeader(k, v); s.end(body); };
const refused = (p, word) => p.then(() => assert.fail(`not refused (${word})`), (e) => { assert.ok(e instanceof Refusal, e?.stack); assert.ok(e.message.includes(word), e.message); });

test("the one request: Host and the plan's header lines alone, none of a client's own (no User-Agent, Accept or Connection), and the answer as received", async (t) => {
  const s = await serving(plain("aaaa", { "x-one": "1" }));
  t.after(s.close);
  const bare = await request(s.port, "/page", []);
  const given = await request(s.port, "/page?x=1", ["X-Plan: 1", "User-Agent: the plan's"]);
  assert.deepEqual(s.asked.map((a) => [a.url, a.names.map((n) => n.toLowerCase()).sort().join(",")]), [["/page", "host"], ["/page?x=1", "host,user-agent,x-plan"]]);
  assert.equal(bare.status, 200);
  assert.equal(bare.body.toString(), "aaaa");
  assert.equal(bare.head[0], "HTTP/1.1 200 OK");
  assert.ok(bare.head.includes("x-one: 1") && bare.head.some((l) => /^date: /i.test(l)), bare.head.join("\n"));
  assert.equal(given.status, 200);
});

test("the one request goes to 127.0.0.1 itself, whatever proxy the environment names, NODE_USE_ENV_PROXY included", async (t) => {
  const target = await serving(plain("target")), proxy = await serving(plain("proxy"));
  t.after(target.close);
  t.after(proxy.close);
  const url = `http://127.0.0.1:${proxy.port}`, env = { ...process.env, NODE_USE_ENV_PROXY: "1", http_proxy: url, HTTP_PROXY: url, NO_PROXY: "", no_proxy: "" };
  const code = `import(${JSON.stringify(new URL("./answers.mjs", import.meta.url).href)}).then(async (m) => process.stdout.write((await m.request(${target.port}, "/page", [])).body))`;
  const child = spawn(process.execPath, ["-e", code], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { err += d; });
  const status = await new Promise((done) => child.on("close", done));
  assert.equal(status, 0, err);
  assert.equal(out, "target");
  assert.deepEqual(proxy.asked, []);
});

test("an answer of another status than the plan's is refused, by the comparison and by a start, kept as received but never mask evidence", async (t) => {
  // Two 503s that differ in a header the plan masks: no evidence that the header varies in the answer the plan asks for.
  let n = 0;
  const s = await serving((q, r) => { r.statusCode = 503; r.setHeader("x-nonce", String(++n)); r.end("busy"); });
  t.after(s.close);
  const dir = fresh(), headers = join(dir, "headers.txt");
  await refused(compare({ dir, ports: [s.port, s.port], path: "/page", lines: [], status: 200, mask: [{ header: "x-nonce" }], say: () => {} }), "HTTP/1.1 503 Service Unavailable from A");
  assert.ok(existsSync(join(dir, "A.raw-headers")) && !existsSync(join(dir, "A-again.raw-headers")) && !existsSync(join(dir, "diff.txt")) && !existsSync(join(dir, "handoff.json")));
  writeFileSync(headers, "");
  // Run as verify.sh runs it, as a command of its own (and not waited for in this process, whose server answers it).
  const start = await new Promise((done) => execFile(process.execPath, [join(here, "answers.mjs"), "start", "verify", String(s.port), "/page", headers, "200", join(dir, "start-1")], (e, stdout, stderr) => done({ status: e?.code ?? 0, stdout, stderr })));
  assert.equal(start.status, 1, start.stderr);
  assert.ok(start.stderr.includes("verify: HTTP/1.1 503 Service Unavailable on ") && start.stderr.includes("an answer of another status is no evidence for the plan's mask"), start.stderr);
  assert.equal(start.stdout, "");
});

test("a comparison takes every fact from the answers as received, once each: the difference, the lengths, the SHA-256s and the kept bodies", async (t) => {
  const a = await serving(plain("aaaa", { "x-side": "a" })), b = await serving(plain("bbbb", { "x-side": "b" }));
  t.after(a.close);
  t.after(b.close);
  const dir = fresh(), said = [];
  const r = await compare({ dir, ports: [a.port, b.port], path: "/page", lines: [], status: 200, mask: [], say: (x) => said.push(x) });
  assert.equal(r.outcome, "differ");
  assert.deepEqual([a.asked.length, b.asked.length], [2, 1], "each answer is one request");
  const diff = readFileSync(join(dir, "diff.txt"), "utf8"), bodies = readFileSync(join(dir, "bodies.txt"), "utf8");
  assert.match(diff, /^(\d+)c\1\n< x-side: a\n---\n> x-side: b\nbodies differ: 4 and 4 bytes, sha256 [0-9a-f]{64} and [0-9a-f]{64}\n$/);
  assert.ok(diff.endsWith(`sha256 ${sha256("aaaa")} and ${sha256("bbbb")}\n`), diff);
  assert.equal(bodies, `body 4 bytes as received, sha256 ${sha256("aaaa").slice(0, 16)} A and ${sha256("bbbb").slice(0, 16)} B\n`);
  assert.deepEqual(["A", "A-again", "B"].map((x) => readFileSync(join(dir, `${x}.body`), "utf8")), ["aaaa", "aaaa", "bbbb"]);
  assert.equal(sha256(readFileSync(join(dir, "handoff.json"))), r.seal);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "handoff.json"), "utf8")), { outcome: "differ", diff: sha256(diff), bodies: sha256(bodies) });
  assert.equal(said.join(""), diff);
  // That difference expected: the same answers pass, and a third body of B's length does not.
  const held = await compare({ dir: fresh(), ports: [a.port, b.port], path: "/page", lines: [], status: 200, mask: [], expect: Buffer.from(diff), say: () => {} });
  assert.equal(held.outcome, "expected");
  const c = await serving(plain("cccc", { "x-side": "b" }));
  t.after(c.close);
  await refused(compare({ dir: fresh(), ports: [a.port, c.port], path: "/page", lines: [], status: 200, mask: [], expect: Buffer.from(diff), say: () => {} }), "the answers differ other than as the plan's expected difference says");
  // The same answers, masked headers that differ included, leave an empty difference.
  let n = 0;
  const m = await serving((q, s) => plain("aaaa", { etag: String(++n) })(q, s));
  t.after(m.close);
  const same = fresh(), sealed = await compare({ dir: same, ports: [m.port, m.port], path: "/page", lines: [], status: 200, mask: [{ header: "ETag" }], say: () => {} });
  assert.equal(sealed.outcome, "same");
  assert.equal(readFileSync(join(same, "diff.txt"), "utf8"), "");
  assert.ok(readFileSync(join(same, "A.headers"), "utf8").includes("etag: <masked>\n"));
});

test("an answer cut short, or one never sent within the bound, fails the comparison rather than reading as an answer", async (t) => {
  const cut = await serving((q, s) => { s.setHeader("content-length", "10"); s.write("aaaa"); setTimeout(() => s.socket.destroy(), 20); });
  t.after(cut.close);
  await refused(request(cut.port, "/page", []), "cut short");
  const hang = await serving(() => {});
  t.after(hang.close);
  await refused(request(hang.port, "/page", [], { bound: 300 }), "no whole answer on");
});

// Something put at diff.txt as B answers, after every other file but before diff.txt is made:
// no check of the path comes before the create, which is itself exclusive (O_CREAT|O_EXCL, wx),
// so nothing is written through a link, to /dev/null (which takes every write and stays empty)
// or to the expected difference, and the comparison fails.
const links = (() => { const d = join(tmp, "probe"); mkdirSync(d); try { symlinkSync(join(d, "x"), join(d, "l")); return true; } catch { return false; } })();
test("something put at diff.txt just before the comparison makes it, a link to /dev/null or to the expected difference or a file, is refused and never written through", { skip: links ? false : "needs symbolic links" }, async (t) => {
  const a = await serving(plain("aaaa"));
  t.after(a.close);
  const expected = join(fresh(), "expect.txt"), want = `bodies differ: 4 and 4 bytes, sha256 ${sha256("aaaa")} and ${sha256("bbbb")}\n`;
  writeFileSync(expected, want);
  // Windows, where the kit does not run, follows a dangling link when it creates a file, so that case is Linux's alone.
  const sink = process.platform === "win32" ? join(tmp, "sink") : "/dev/null", puts = [["devnull", (f) => symlinkSync(sink, f)], ["expected", (f) => symlinkSync(expected, f)], ["file", (f) => writeFileSync(f, "")]];
  if (process.platform === "win32") writeFileSync(sink, ""); else puts.push(["dangling", (f) => symlinkSync(join(tmp, "nowhere", "diff.txt"), f)]);
  for (const [name, put] of puts) {
    const dir = fresh();
    const b = await serving((q, s) => { put(join(dir, "diff.txt")); plain("bbbb")(q, s); });
    t.after(b.close);
    await refused(compare({ dir, ports: [a.port, b.port], path: "/page", lines: [], status: 200, mask: [], expect: Buffer.from(want), say: () => {} }), `${join(dir, "diff.txt")} cannot be written as a new file: something is there before the check made it`);
    assert.equal(readFileSync(expected, "utf8"), want, `${name}: the expected difference was written through the link`);
    assert.ok(!existsSync(join(dir, "handoff.json")) && !existsSync(join(dir, "bodies.txt")), name);
  }
  const there = fresh();
  writeFileSync(join(there, "x"), "there");
  assert.throws(() => create(join(there, "x"), "y"), (e) => e instanceof Refusal && e.message.includes("cannot be written as a new file"));
  assert.equal(readFileSync(join(there, "x"), "utf8"), "there");
});

/** A comparison's files, sealed as compare() seals them, and the handoff line turns.sh prints for them. */
function sealed({ outcome = "same", diff = "", bodies = `body 4 bytes as received, sha256 ${"1".repeat(16)} A and ${"1".repeat(16)} B\n` } = {}) {
  const dir = fresh();
  writeFileSync(join(dir, "diff.txt"), diff);
  writeFileSync(join(dir, "bodies.txt"), bodies);
  const seal = `${JSON.stringify({ outcome, diff: sha256(diff), bodies: sha256(bodies) })}\n`;
  writeFileSync(join(dir, "handoff.json"), seal);
  return { dir, log: `answers: same\nturns: plain: handoff sha256 ${sha256(seal)}\n` };
}

test("a handoff binds the outcome, diff.txt and bodies.txt: a regular file put in place of any of them, or another outcome, is refused", () => {
  const ok = sealed(), one = "1".repeat(16);
  assert.deepEqual(handoff(ok.dir, ok.log, "turns: plain", ["same"]), { outcome: "same", diff: "", bodies: { line: `body 4 bytes as received, sha256 ${one} A and ${one} B`, bytes: 4, a: one, b: one } });
  const has = (r, word) => { assert.equal(typeof r, "string", JSON.stringify(r)); assert.ok(r.includes(word), r); };
  has(handoff(ok.dir, ok.log, "turns: plain", ["differ"]), 'sealed the outcome "same", not differ');
  for (const [file, text, word] of [["diff.txt", "1c1\n< a\n---\n> b\nbodies same: 4 bytes, sha256 x\n", "is not the difference the comparison sealed"], ["bodies.txt", `body 4 bytes as received, sha256 ${"2".repeat(16)} A and ${"2".repeat(16)} B\n`, "is not the bodies line the comparison sealed"], ["handoff.json", '{"outcome":"same","diff":"x","bodies":"y"}\n', "is not the handoff turns.sh said it sealed"]]) {
    const s = sealed();
    writeFileSync(join(s.dir, file), text);
    has(handoff(s.dir, s.log, "turns: plain", ["same"]), word);
  }
  // A handoff named twice, not at all, or by another workload's line is no handoff.
  has(handoff(ok.dir, `${ok.log}${ok.log}`, "turns: plain", ["same"]), "(2 such lines)");
  has(handoff(ok.dir, "answers: same\n", "turns: plain", ["same"]), "(0 such lines)");
  has(handoff(ok.dir, ok.log.replace("plain", "other"), "turns: plain", ["same"]), "(0 such lines)");
  // An outcome the files do not say, sealed consistently: "same" with a difference, a difference with none, "same" with two bodies.
  const forged = sealed({ outcome: "same", diff: "1c1\n< a\n---\n> b\nbodies same: 4 bytes, sha256 x\n" });
  has(handoff(forged.dir, forged.log, "turns: plain", ["same"]), "with a difference that does not say so");
  const empty = sealed({ outcome: "differ" });
  has(handoff(empty.dir, empty.log, "turns: plain", ["differ"]), "with a difference that does not say so");
  const two = sealed({ bodies: `body 4 bytes as received, sha256 ${one} A and ${"2".repeat(16)} B\n` });
  has(handoff(two.dir, two.log, "turns: plain", ["same"]), "with a difference that does not say so");
  const odd = sealed({ bodies: "body 4 bytes\n" });
  has(handoff(odd.dir, odd.log, "turns: plain", ["same"]), "is not a bodies line the kit writes");
});

const RESULT = "RESULT 100 0 0 0 0 0\n", PERF = "12345,,cycles:u,1000,100.00,,\n";
test("a turn is recorded only from exactly one complete RESULT line of decimal counts and each event once, a count above zero at 100%", () => {
  const ok = (perf, wrk, events = "cycles:u") => turn(Buffer.from(perf, "latin1"), Buffer.from(wrk, "latin1"), events, "pair 1 base");
  const no = (perf, wrk, word, events) => assert.throws(() => ok(perf, wrk, events), (e) => e instanceof Refusal && e.message.includes(word), `${word}: ${JSON.stringify([perf, wrk])}`);
  assert.deepEqual(ok(PERF, RESULT), { requests: "100", values: ["12345"] });
  assert.deepEqual(ok("7,,L1-icache-load-misses,9,100,,\n", RESULT, "L1-icache-load-misses:u"), { requests: "100", values: ["7"] });
  assert.deepEqual(ok(`# started\n\0\n${PERF}`, `noise\n${RESULT}`), { requests: "100", values: ["12345"] });
  // Two incomplete RESULT lines, which joined would make six counts; one cut short at the end; none.
  no(PERF, "RESULT 100 0 0\nRESULT 0 0 0\n", "2 RESULT lines");
  no(PERF, "RESULT 100 0 0 0 0 0", "is not complete");
  no(PERF, `${RESULT}RESULT 1`, "is not complete");
  no(PERF, "", "no RESULT line");
  for (const r of ["RESULT 100 0 0 0 0\n", "RESULT 1e3 0 0 0 0 0\n", "RESULT 100 0 0 0 0 0 \n", "RESULT 100\t0 0 0 0 0\n", "RESULT 100 0 0 0 0 0\r\n"]) no(PERF, r, "is not six decimal counts");
  no(PERF, "RESULT 100 0 1 0 0 0\n", "errors in pair 1 base");
  no(PERF, "RESULT 0 0 0 0 0 0\n", "no requests in pair 1 base");
  // A percentage that is not one, or not 100; a count that is not one, or zero; an event twice or not at all.
  for (const pct of ["100oops", "99.99", "100.01", "", "1e2", "+100", "100 ", "0x64"]) no(PERF.replace("100.00", pct), RESULT, "counter not at 100%");
  for (const v of ["0", "12a", "<not counted>", "-1", ""]) no(PERF.replace("12345", v), RESULT, "unusable counter");
  no(`${PERF}${PERF}`, RESULT, "not reported once");
  no("", RESULT, "not reported once");
});

test("a turn's perf and wrk output go to the raw log byte for byte, a NUL included, and its row to the CSV only when it is one to record", () => {
  const dir = fresh(), perf = join(dir, "turn.perf"), wrk = join(dir, "turn.wrk"), raw = join(dir, "raw.log"), csv = join(dir, "counts.csv");
  const run = (p, w) => { writeFileSync(perf, p); writeFileSync(wrk, w); return spawnSync(process.execPath, [join(here, "answers.mjs"), "turn", "turns: plain", perf, wrk, "cycles:u", "1", "base", raw, csv], { encoding: "utf8" }); };
  const odd = Buffer.from(`# \0 \xff\n${PERF}`, "latin1"), good = run(odd, RESULT);
  assert.equal(good.status, 0, good.stderr);
  assert.deepEqual(readFileSync(raw), Buffer.concat([Buffer.from("## pair 1 base\n"), odd, Buffer.from(RESULT)]));
  assert.equal(readFileSync(csv, "utf8"), "1,base,100,12345\n");
  const bad = run(PERF.replace("100.00", "100oops"), RESULT);
  assert.equal(bad.status, 1);
  assert.ok(bad.stderr.includes("turns: plain: counter not at 100% in pair 1 base: cycles:u"), bad.stderr);
  assert.equal(readFileSync(csv, "utf8"), "1,base,100,12345\n", "a row was recorded for a turn that is not one");
});

test("the difference is in diff's normal format, as POSIX diff prints it where diff is there to ask", () => {
  const cases = [[["a", "b", "c"], ["a", "x", "c"]], [["a", "b", "c", "d", "e"], ["a", "x", "c", "d", "y"]], [["a"], ["a", "b"]], [["a", "b"], ["a"]], [["a", "b"], []], [[], ["a"]], [["a", "b"], ["a", "b"]], [["s", "h1", "h2", "h3"], ["s", "h2", "h3", "h4"]], [["s", "a", "b", "c"], ["s", "x", "y"]]];
  assert.equal(difference(...cases[0]), "2c2\n< b\n---\n> x\n");
  assert.equal(difference(...cases[1]), "2c2\n< b\n---\n> x\n5c5\n< e\n---\n> y\n");
  assert.equal(difference(...cases[2]), "1a2\n> b\n");
  assert.equal(difference(...cases[3]), "2d1\n< b\n");
  assert.equal(difference(...cases[4]), "1,2d0\n< a\n< b\n");
  assert.equal(difference(...cases[6]), "");
  if (spawnSync("diff", ["--version"]).status === null) return;
  for (const [x, y] of cases) {
    const dir = fresh(), f = (n, l) => { writeFileSync(join(dir, n), l.map((s) => `${s}\n`).join("")); return join(dir, n); };
    assert.equal(difference(x, y), spawnSync("diff", [f("a", x), f("b", y)], { encoding: "utf8" }).stdout, JSON.stringify([x, y]));
  }
});

test("masked: Date left out, each masked header's line its name and <masked>, whatever case it was sent in", () => {
  assert.deepEqual(masked(["HTTP/1.1 200 OK", "Date: x", "ETag: 1", "etag: 2", "x-a: 1"], [{ header: "etag" }]), ["HTTP/1.1 200 OK", "etag: <masked>", "etag: <masked>", "x-a: 1"]);
});
