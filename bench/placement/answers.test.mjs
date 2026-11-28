// answers.mjs on its own: the one request turns.sh's and verify.sh's checks send, captured by
// curl into files created new, an answer of another status refused, each answer taken from the
// bytes curl wrote alone, its header lines compared as they are (whitespace and every line), the
// difference the system diff's, every file created new (a link put in its place first refused),
// the handoff the trend and verify.sh read a comparison by, and a recorded turn's perf and wrk
// output. The handoff and the turns on every platform; the captures on Linux, with curl, diff
// and timeout, and servers of its own.
import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as tcp } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { capture, compare, create, handoff, masked, Refusal, sha256, turn } from "./answers.mjs";
import { starts } from "./mask.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "placement-answers-")));
after(() => rmSync(tmp, { recursive: true, force: true }));
let made = 0;
const fresh = () => { const d = join(tmp, `a-${++made}`); mkdirSync(d); return d; };
const LINUX = { skip: process.platform === "linux" && spawnSync("sh", ["-c", "command -v curl && command -v diff && command -v timeout"]).status === 0 ? false : "needs Linux with curl, diff and timeout" };

/** A server on a port of its own: answer(q, s) answers each request. Resolves to { port, asked, close }. */
async function serving(answer) {
  const asked = [];
  const s = createServer((q, r) => { asked.push({ url: q.url, names: q.rawHeaders.filter((_, i) => i % 2 === 0) }); answer(q, r); });
  await new Promise((done) => s.listen(0, "127.0.0.1", done));
  return { port: s.address().port, asked, close: () => new Promise((done) => { s.closeAllConnections(); s.close(done); }) };
}
/** A server that answers every request with exactly the bytes of head (its status and header lines, CRLF each) and body. */
async function raw(head, body = "aaaa") {
  const s = tcp((c) => { let got = Buffer.alloc(0); c.on("data", (d) => { got = Buffer.concat([got, d]); if (got.includes("\r\n\r\n")) c.end(Buffer.concat([Buffer.from(head, "latin1"), Buffer.from(`content-length: ${body.length}\r\nconnection: close\r\n\r\n${body}`, "latin1")])); }); c.on("error", () => {}); });
  await new Promise((done) => s.listen(0, "127.0.0.1", done));
  return { port: s.address().port, close: () => new Promise((done) => s.close(done)) };
}
const plain = (body, more = {}) => (q, s) => { s.setHeader("content-type", "text/plain"); for (const [k, v] of Object.entries(more)) s.setHeader(k, v); s.end(body); };
const refused = (p, word) => p.then(() => assert.fail(`not refused (${word})`), (e) => { assert.ok(e instanceof Refusal, e?.stack); assert.ok(e.message.includes(word), e.message); });
const compared = (ports, more = {}) => compare({ dir: fresh(), ports, path: "/page", lines: [], status: 200, mask: [], say: () => {}, ...more });

test("the one request: Host and the plan's header lines alone, none of curl's own (no User-Agent or Accept), and the answer as curl wrote it", LINUX, async (t) => {
  const s = await serving(plain("aaaa", { "x-one": "1" }));
  t.after(s.close);
  const dir = fresh(), bare = await capture(s.port, "/page", [], join(dir, "bare"));
  const given = await capture(s.port, "/page?x=1", ["X-Plan: 1", "User-Agent: the plan's"], join(dir, "given"));
  assert.deepEqual(s.asked.map((a) => [a.url, a.names.map((n) => n.toLowerCase()).sort().join(",")]), [["/page", "host"], ["/page?x=1", "host,user-agent,x-plan"]]);
  assert.equal(bare.body.toString(), "aaaa");
  assert.match(bare.raw.toString("latin1"), /^HTTP\/1\.1 200 OK\r\n[^]*x-one: 1\r\n[^]*\r\n\r\n$/i);
  // The files curl wrote are the bytes returned.
  assert.deepEqual([readFileSync(join(dir, "bare.raw-headers")), readFileSync(join(dir, "bare.body"))], [bare.raw, bare.body]);
  assert.equal(given.body.toString(), "aaaa");
});

test("the one request goes to the path as written: curl globs nothing, so /{a,b} or /p[1-2] is one request, not two whose bodies are joined", LINUX, async (t) => {
  const s = await serving((q, r) => plain(`<${q.url}>`)(q, r));
  t.after(s.close);
  for (const path of ["/{a,b}", "/p[1-2]"]) {
    s.asked.length = 0;
    const r = await capture(s.port, path, [], join(fresh(), "x"));
    assert.deepEqual(s.asked.map((a) => a.url), [path], path);
    assert.equal(r.body.toString(), `<${path}>`);
  }
});

test("the one request's target is the plan's path byte for byte: curl removes no dot segment, so /root/../target is asked for as that, not as /target", LINUX, async (t) => {
  const s = await serving((q, r) => plain(`<${q.url}>`)(q, r));
  t.after(s.close);
  for (const path of ["/root/../target", "/a/./b", "/a/b/..", "/.."]) {
    s.asked.length = 0;
    const r = await capture(s.port, path, [], join(fresh(), "x"));
    assert.deepEqual(s.asked.map((a) => a.url), [path], path);
    assert.equal(r.body.toString(), `<${path}>`);
  }
  // Two servers that answer alike at /target and differently at the target the plan names: had
  // curl asked both for /target, the comparison would have sealed "same".
  const at = (body) => (q, r) => plain(q.url === "/target" ? "same" : body)(q, r);
  const a = await serving(at("aaaa")), b = await serving(at("bbbb"));
  t.after(a.close);
  t.after(b.close);
  const dir = fresh(), r = await compare({ dir, ports: [a.port, b.port], path: "/root/../target", lines: [], status: 200, mask: [], say: () => {} });
  assert.equal(r.outcome, "differ");
  assert.deepEqual([...a.asked, ...b.asked].map((x) => x.url), Array(3).fill("/root/../target"));
  assert.ok(readFileSync(join(dir, "diff.txt"), "latin1").endsWith(`sha256 ${sha256("aaaa")} and ${sha256("bbbb")}\n`));
});

test("a path curl would still rewrite, one with a fragment, is refused before any request", LINUX, async (t) => {
  const s = await serving(plain("aaaa"));
  t.after(s.close);
  const dir = fresh();
  await refused(capture(s.port, "/page#top", [], join(dir, "x")), "with no fragment (#)");
  assert.deepEqual(s.asked, []);
  assert.ok(!existsSync(join(dir, "x.raw-headers")));
});

test("a masked header's stated range is held by the final response's header lines alone: an interim 103's Age neither stands in for a final one nor is checked", LINUX, async (t) => {
  const mask = [{ header: "age", range: [0, 3] }];
  // Age in the 103 alone: the final 200 sends none, which is not once.
  const hinted = await raw("HTTP/1.1 103 Early Hints\r\nAge: 1\r\n\r\nHTTP/1.1 200 OK\r\n");
  t.after(hinted.close);
  await refused(compare({ dir: fresh(), ports: [hinted.port, hinted.port], path: "/page", lines: [], status: 200, mask, say: () => {} }), "a masked header is not within the range the plan states: A: age: sent 0 times, not once");
  // Age in the final 200, within the range, and an interim 103 that sends one out of it: the
  // final one is held to the range, and the interim block stays in the headers compared, its Age
  // unmasked: only the final block's is shown to differ between starts.
  const final = await raw("HTTP/1.1 103 Early Hints\r\nAge: 9\r\n\r\nHTTP/1.1 200 OK\r\nAge: 2\r\n");
  t.after(final.close);
  const dir = fresh();
  assert.equal((await compare({ dir, ports: [final.port, final.port], path: "/page", lines: [], status: 200, mask, say: () => {} })).outcome, "same");
  assert.ok(readFileSync(join(dir, "A.headers"), "latin1").startsWith("HTTP/1.1 103 Early Hints\nAge: 9\n\nHTTP/1.1 200 OK\nage: <masked>\n"));
});

test("the final response is its block alone: a line inside it that reads like a status line neither ends it nor is its status, and chunked trailers after it are no evidence for the mask", LINUX, async (t) => {
  const mask = [{ header: "age", range: [0, 3] }];
  // curl takes "HTTP/1.1 200 : x" inside the 200's block as a header line: Age is sent twice in
  // that block, and its status line is the block's first.
  const embedded = await raw("HTTP/1.1 200 OK\r\nAge: 99\r\nHTTP/1.1 200 : x\r\nAge: 2\r\n");
  t.after(embedded.close);
  assert.equal((await capture(embedded.port, "/page", [], join(fresh(), "x"))).line, "HTTP/1.1 200 OK");
  await refused(compare({ dir: fresh(), ports: [embedded.port, embedded.port], path: "/page", lines: [], status: 200, mask, say: () => {} }), "a masked header is not within the range the plan states: A: age: sent 2 times, not once");
  // A chunked answer whose trailers curl writes after the final block's blank line, kept in the
  // headers compared and read by neither mask check, even a trailer that reads like a status line.
  const chunked = async (head, trailers) => {
    const s = tcp((c) => { let got = Buffer.alloc(0); c.on("data", (d) => { got = Buffer.concat([got, d]); if (got.includes("\r\n\r\n")) c.end(`HTTP/1.1 200 OK\r\n${head}transfer-encoding: chunked\r\nconnection: close\r\n\r\n4\r\naaaa\r\n0\r\n${trailers}\r\n`, "latin1"); }); c.on("error", () => {}); });
    await new Promise((done) => s.listen(0, "127.0.0.1", done));
    t.after(() => new Promise((done) => s.close(done)));
    return s.address().port;
  };
  for (const trailers of ["Age: 2\r\n", "HTTP/1.1 200 : x\r\nAge: 2\r\n"]) {
    const port = await chunked("", trailers), dir = fresh();
    await refused(compare({ dir, ports: [port, port], path: "/page", lines: [], status: 200, mask, say: () => {} }), "a masked header is not within the range the plan states: A: age: sent 0 times, not once");
    assert.ok(readFileSync(join(dir, "A.raw-headers"), "latin1").endsWith(`\r\n\r\n${trailers}`), trailers);
  }
  const port = await chunked("Age: 2\r\n", "Age: 9\r\n"), dir = fresh();
  assert.equal((await compare({ dir, ports: [port, port], path: "/page", lines: [], status: 200, mask, say: () => {} })).outcome, "same");
  const kept = readFileSync(join(dir, "A.headers"), "latin1");
  assert.ok(kept.startsWith("HTTP/1.1 200 OK\nage: <masked>\n") && kept.endsWith("\n\nAge: 9\n"), kept);
});

test("two starts' proof of the mask reads each start's final response alone: an Age only interim 103s send, differing, does not show the final one differs", () => {
  const dir = fresh(), mask = join(dir, "mask.json"), early = (n, last = "") => `HTTP/1.1 103 Early Hints\r\nAge: ${n}\r\n\r\nHTTP/1.1 200 OK\r\n${last}content-type: text/plain\r\n\r\n`;
  writeFileSync(mask, JSON.stringify([{ header: "age", range: [0, 3] }]));
  const starts = (one, two) => {
    for (const [f, text] of [["start-1", one], ["start-2", two]]) { rmSync(join(dir, f), { force: true }); writeFileSync(join(dir, f), text); }
    return spawnSync(process.execPath, [join(here, "answers.mjs"), "starts", "verify", mask, join(dir, "start-1"), sha256(one), join(dir, "start-2"), sha256(two)], { encoding: "utf8" });
  };
  const no = starts(early(1), early(2));
  assert.equal(no.status, 1, no.stdout);
  assert.ok(no.stderr.includes("verify: age: two starts sent it 0 and 0 times"), no.stderr);
  const yes = starts(early(1, "Age: 1\r\n"), early(1, "Age: 2\r\n"));
  assert.equal(yes.status, 0, yes.stderr);
  assert.ok(yes.stdout.includes("every header the plan masks differs between them (age)"), yes.stdout);
});

test("the mask hides a header in the final block alone: two binaries whose 103s preload different stylesheets, their final Link differing as two starts showed, do not compare the same", LINUX, async (t) => {
  const mask = [{ header: "link" }];
  const hinted = (css, n) => `HTTP/1.1 103 Early Hints\r\nLink: </${css}.css>; rel=preload\r\n\r\nHTTP/1.1 200 OK\r\nLink: <${n}>\r\ncontent-type: text/plain\r\n`;
  // The final Link differs between two starts, so the startup check takes it as masked.
  assert.deepEqual(starts(mask, `${hinted("a", 1)}\r\n`, `${hinted("a", 2)}\r\n`), []);
  const a = await raw(hinted("a", 1)), b = await raw(hinted("b", 2)), again = await raw(hinted("a", 2));
  t.after(a.close);
  t.after(b.close);
  t.after(again.close);
  const dir = fresh(), said = [], r = await compare({ dir, ports: [a.port, b.port], path: "/page", lines: [], status: 200, mask, say: (x) => said.push(String(x)) });
  assert.equal(r.outcome, "differ");
  const diff = readFileSync(join(dir, "diff.txt"), "latin1");
  assert.match(diff, /^< Link: <\/a\.css>; rel=preload$/m);
  assert.match(diff, /^> Link: <\/b\.css>; rel=preload$/m);
  assert.ok(!/^[<>] link: <masked>$/m.test(diff), diff);
  assert.ok(diff.endsWith(`bodies same: 4 bytes, sha256 ${sha256("aaaa")}\n`), diff);
  assert.deepEqual(said, [diff]);
  // The same 103 and a final Link that differs only as masked: the same.
  assert.equal((await compare({ dir: fresh(), ports: [a.port, again.port], path: "/page", lines: [], status: 200, mask, say: () => {} })).outcome, "same");
});

test("the final response's status is the answer's, an interim 1xx's header lines kept and compared: 103 then 503 refused as 103, 103 then 200 accepted as 200", LINUX, async (t) => {
  const hinted = (code) => (q, s) => { s.writeEarlyHints({ link: "</a.css>; rel=preload" }); s.statusCode = code; plain("aaaa")(q, s); };
  const busy = await serving(hinted(503)), ok = await serving(hinted(200)), none = await serving(plain("aaaa"));
  t.after(busy.close);
  t.after(ok.close);
  t.after(none.close);
  await refused(compared([busy.port, busy.port], { status: 103 }), "HTTP/1.1 503 Service Unavailable from A");
  const dir = fresh(), r = await compared([ok.port, ok.port], { dir });
  assert.equal(r.outcome, "same");
  assert.match(readFileSync(join(dir, "A.headers"), "latin1"), /^HTTP\/1\.1 103 Early Hints\nLink: <\/a\.css>; rel=preload\n\nHTTP\/1\.1 200 OK\n/);
  // Early hints are part of the headers compared: an answer sent with them differs from one sent without.
  assert.equal((await compared([ok.port, none.port])).outcome, "differ");
  // A start too, run as verify.sh runs it.
  const headers = join(dir, "headers.txt");
  writeFileSync(headers, "");
  const start = (port, st, prefix) => new Promise((done) => execFile(process.execPath, [join(here, "answers.mjs"), "start", "verify", String(port), "/page", headers, st, join(dir, prefix)], (e, stdout, stderr) => done({ status: e?.code ?? 0, stdout, stderr })));
  const no = await start(busy.port, "103", "start-busy");
  assert.equal(no.status, 1, no.stderr);
  assert.ok(no.stderr.includes("verify: HTTP/1.1 503 Service Unavailable on "), no.stderr);
  const yes = await start(ok.port, "200", "start-ok");
  assert.equal(yes.status, 0, yes.stderr);
  assert.equal(yes.stdout, `${sha256(readFileSync(join(dir, "start-ok.raw-headers")))}\n`);
});

test("a diff that stalls is gone within its own bound after the timeout around answers.mjs has stopped it", LINUX, async (t) => {
  const s = await serving(plain("aaaa"));
  t.after(s.close);
  const stub = fresh(), pidFile = join(stub, "diff.pid");
  // The stand-in ends by itself (a sleep of 30 s) if the bound under test fails to end it: the
  // test sends it no signal, since by then its number need no longer name it.
  writeFileSync(join(stub, "diff"), `#!/bin/sh\necho $$ >'${pidFile}'\nexec sleep 30\n`, { mode: 0o755 });
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  let pid = 0;
  const code = `import(${JSON.stringify(new URL("./answers.mjs", import.meta.url).href)}).then((m) => m.compare({ dir: ${JSON.stringify(fresh())}, ports: [${s.port}, ${s.port}], path: "/page", lines: [], status: 200, mask: [], say: () => {}, diffSeconds: 5 }))`;
  // As turns.sh runs answers.mjs, with an environment of PATH alone, but stopped at 2 s, before diff's own 5 s.
  const wrapper = spawn("timeout", ["--foreground", "-k", "1", "2", process.execPath, "-e", code], { env: { PATH: `${stub}:${process.env.PATH}` }, stdio: "ignore" });
  const status = await new Promise((done) => wrapper.on("close", done));
  assert.equal(status, 124, "answers.mjs ended before the timeout around it");
  pid = Number(readFileSync(pidFile, "utf8"));
  assert.ok(alive(pid), "the stand-in diff was not running when answers.mjs was stopped");
  const by = Date.now() + 8000;
  while (alive(pid) && Date.now() < by) await new Promise((done) => setTimeout(done, 100));
  assert.ok(!alive(pid), "the stand-in diff outlived answers.mjs past its own bound");
});

test("the one request goes to 127.0.0.1 itself, whatever proxy the environment names", LINUX, async (t) => {
  const target = await serving(plain("target")), proxy = await serving(plain("proxy"));
  t.after(target.close);
  t.after(proxy.close);
  const url = `http://127.0.0.1:${proxy.port}`, env = { ...process.env, http_proxy: url, HTTP_PROXY: url, ALL_PROXY: url, all_proxy: url, NO_PROXY: "", no_proxy: "" };
  const code = `import(${JSON.stringify(new URL("./answers.mjs", import.meta.url).href)}).then(async (m) => process.stdout.write((await m.capture(${target.port}, "/page", [], ${JSON.stringify(join(fresh(), "x"))})).body))`;
  const child = spawn(process.execPath, ["-e", code], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { err += d; });
  const status = await new Promise((done) => child.on("close", done));
  assert.equal(status, 0, err);
  assert.equal(out, "target");
  assert.deepEqual(proxy.asked, []);
});

test("an answer of another status than the plan's is refused, by the comparison and by a start, kept as received but never mask evidence", LINUX, async (t) => {
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

test("a comparison takes every fact from the answers curl wrote, once each: the difference, the lengths, the SHA-256s and the kept bodies", LINUX, async (t) => {
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
  assert.equal(readFileSync(join(dir, "handoff.json"), "utf8"), `${JSON.stringify({ outcome: "differ", diff: sha256(diff), bodies: sha256(bodies) })}\n`);
  assert.equal(Buffer.concat(said.map((x) => Buffer.from(x))).toString(), diff);
  // The difference is the system diff's, of the masked headers' files.
  assert.equal(diff.slice(0, diff.indexOf("bodies differ")), spawnSync("diff", [join(dir, "A.headers"), join(dir, "B.headers")], { encoding: "utf8" }).stdout);
  // That difference expected: the same answers pass, and a third body of B's length does not.
  const held = await compared([a.port, b.port], { expect: Buffer.from(diff) });
  assert.equal(held.outcome, "expected");
  const c = await serving(plain("cccc", { "x-side": "b" }));
  t.after(c.close);
  await refused(compared([a.port, c.port], { expect: Buffer.from(diff) }), "the answers differ other than as the plan's expected difference says");
  // The same answers, masked headers that differ included, leave an empty difference.
  let n = 0;
  const m = await serving((q, s) => plain("aaaa", { etag: String(++n) })(q, s));
  t.after(m.close);
  const same = fresh(), sealed = await compare({ dir: same, ports: [m.port, m.port], path: "/page", lines: [], status: 200, mask: [{ header: "ETag" }], say: () => {} });
  assert.equal(sealed.outcome, "same");
  assert.equal(readFileSync(join(same, "diff.txt"), "utf8"), "");
  assert.ok(readFileSync(join(same, "A.headers"), "utf8").includes("etag: <masked>\n"));
});

test("header lines are compared as curl wrote them: whitespace that differs, and a difference after the thousandth line, are differences", LINUX, async (t) => {
  // Both read as "X-Test: alpha" once a client parses them, as Node's does.
  const tab = await raw("HTTP/1.1 200 OK\r\nX-Test:\t alpha  \r\n"), bare = await raw("HTTP/1.1 200 OK\r\nX-Test: alpha\r\n");
  t.after(tab.close);
  t.after(bare.close);
  const one = fresh(), r = await compare({ dir: one, ports: [tab.port, bare.port], path: "/page", lines: [], status: 200, mask: [], say: () => {} });
  assert.equal(r.outcome, "differ");
  assert.ok(readFileSync(join(one, "diff.txt"), "latin1").startsWith("2c2\n< X-Test:\t alpha  \n---\n> X-Test: alpha\n"), readFileSync(join(one, "diff.txt"), "latin1"));
  // 1,001 header lines, the last of which differs.
  const many = (last) => `HTTP/1.1 200 OK\r\n${Array.from({ length: 1000 }, (_, i) => `x-${i}: ${i}\r\n`).join("")}x-last: ${last}\r\n`;
  const x = await raw(many("a")), y = await raw(many("b"));
  t.after(x.close);
  t.after(y.close);
  const two = fresh();
  assert.equal((await compare({ dir: two, ports: [x.port, y.port], path: "/page", lines: [], status: 200, mask: [], say: () => {} })).outcome, "differ");
  assert.ok(readFileSync(join(two, "diff.txt"), "latin1").startsWith("1002c1002\n< x-last: a\n---\n> x-last: b\n"));
});

test("the difference is the system diff's: B,A,B against A,A,B is one change, as diff prints it", LINUX, async (t) => {
  const x = await raw("HTTP/1.1 200 OK\r\nx: B\r\nx: A\r\nx: B\r\n"), y = await raw("HTTP/1.1 200 OK\r\nx: A\r\nx: A\r\nx: B\r\n");
  t.after(x.close);
  t.after(y.close);
  const dir = fresh();
  await compare({ dir, ports: [x.port, y.port], path: "/page", lines: [], status: 200, mask: [], say: () => {} });
  const diff = readFileSync(join(dir, "diff.txt"), "latin1");
  assert.ok(diff.startsWith("2c2\n< x: B\n---\n> x: A\nbodies same: "), diff);
});

test("a header byte that is not UTF-8 is kept as received, in the headers, the difference and the expected difference it is held to", LINUX, async (t) => {
  const x = await raw("HTTP/1.1 200 OK\r\nx-name: cafe\r\n"), y = await raw("HTTP/1.1 200 OK\r\nx-name: caf\xe9\r\n");
  t.after(x.close);
  t.after(y.close);
  const dir = fresh();
  await compare({ dir, ports: [x.port, y.port], path: "/page", lines: [], status: 200, mask: [], say: () => {} });
  const diff = readFileSync(join(dir, "diff.txt"));
  assert.ok(diff.includes(Buffer.from("> x-name: caf\xe9\n", "latin1")), diff.toString("latin1"));
  assert.equal((await compared([x.port, y.port], { expect: diff })).outcome, "expected");
});

test("an answer cut short, or one never sent within the bound, fails the capture rather than reading as an answer", LINUX, async (t) => {
  const cut = await serving((q, s) => { s.setHeader("content-length", "10"); s.write("aaaa"); setTimeout(() => s.socket.destroy(), 20); });
  t.after(cut.close);
  await refused(capture(cut.port, "/page", [], join(fresh(), "cut")), `the answer on ${cut.port} could not be taken whole: curl ended with status 18`);
  const hang = await serving(() => {});
  t.after(hang.close);
  await refused(capture(hang.port, "/page", [], join(fresh(), "hang"), { bound: 300 }), "no whole answer on");
});

// Something put at diff.txt as B answers, after every other file but before diff.txt is made:
// no check of the path comes before the create, which is itself exclusive (O_CREAT|O_EXCL, wx),
// so nothing is written through a link, to /dev/null (which takes every write and stays empty)
// or to the expected difference, and the comparison fails. A capture's own files likewise.
test("something put at diff.txt or a capture's files just before the comparison makes them, a link to /dev/null or to the expected difference or a file, is refused and never written through", LINUX, async (t) => {
  const a = await serving(plain("aaaa"));
  t.after(a.close);
  const expected = join(fresh(), "expect.txt"), want = `bodies differ: 4 and 4 bytes, sha256 ${sha256("aaaa")} and ${sha256("bbbb")}\n`;
  writeFileSync(expected, want);
  const puts = [["devnull", (f) => symlinkSync("/dev/null", f)], ["expected", (f) => symlinkSync(expected, f)], ["file", (f) => writeFileSync(f, "")], ["dangling", (f) => symlinkSync(join(tmp, "nowhere", "diff.txt"), f)]];
  for (const [name, put] of puts) {
    const dir = fresh();
    const b = await serving((q, s) => { put(join(dir, "diff.txt")); plain("bbbb")(q, s); });
    t.after(b.close);
    await refused(compare({ dir, ports: [a.port, b.port], path: "/page", lines: [], status: 200, mask: [], expect: Buffer.from(want), say: () => {} }), `${join(dir, "diff.txt")} cannot be written as a new file: something is there before the check made it`);
    assert.equal(readFileSync(expected, "utf8"), want, `${name}: the expected difference was written through the link`);
    assert.ok(!existsSync(join(dir, "handoff.json")) && !existsSync(join(dir, "bodies.txt")), name);
    const early = fresh();
    put(join(early, "A.body"));
    await refused(capture(a.port, "/page", [], join(early, "A")), `${join(early, "A.body")} cannot be written as a new file`);
    assert.equal(readFileSync(expected, "utf8"), want, `${name}: the expected difference was written through a capture`);
  }
  const there = fresh();
  writeFileSync(join(there, "x"), "there");
  assert.throws(() => create(join(there, "x"), "y"), (e) => e instanceof Refusal && e.message.includes("cannot be written as a new file"));
  assert.equal(readFileSync(join(there, "x"), "utf8"), "there");
});

/** A comparison's files, sealed as compare() seals them, and the handoff line turns.sh prints for them. */
function sealed({ outcome = "same", diff = "", bodies = `body 4 bytes as received, sha256 ${"1".repeat(16)} A and ${"1".repeat(16)} B\n`, form = (h) => `${JSON.stringify(h)}\n` } = {}) {
  const dir = fresh();
  writeFileSync(join(dir, "diff.txt"), diff);
  writeFileSync(join(dir, "bodies.txt"), bodies);
  const seal = form({ outcome, diff: sha256(diff), bodies: sha256(bodies) });
  writeFileSync(join(dir, "handoff.json"), seal);
  return { dir, log: `answers: same\nturns: plain: handoff sha256 ${sha256(seal)}\n` };
}

test("a handoff binds the outcome, diff.txt and bodies.txt: a regular file put in place of any of them, or another outcome, is refused", () => {
  const ok = sealed(), one = "1".repeat(16);
  assert.deepEqual(handoff(ok.dir, ok.log, "turns: plain", ["same"]), { outcome: "same", diff: Buffer.alloc(0), bodies: { line: `body 4 bytes as received, sha256 ${one} A and ${one} B`, bytes: 4, a: one, b: one } });
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
  // A handoff in any other form than the one the kit writes, a key twice (JSON.parse keeps the
  // last, so the first would never be read), other spacing or order, is no handoff, though the line names its bytes.
  for (const form of [(h) => `{"outcome":"differ","outcome":"${h.outcome}","diff":"${h.diff}","bodies":"${h.bodies}"}\n`, (h) => `${JSON.stringify(h, null, 1)}\n`, (h) => `${JSON.stringify({ diff: h.diff, outcome: h.outcome, bodies: h.bodies })}\n`, (h) => JSON.stringify(h)]) {
    const s = sealed({ form });
    has(handoff(s.dir, s.log, "turns: plain", ["same"]), "is not a handoff the kit writes");
  }
  // diff.txt's bytes come back as they are, not as text.
  const bytes = Buffer.from("1c1\n< x: cafe\n---\n> x: caf\xe9\nbodies same: 4 bytes, sha256 x\n", "latin1"), kept = sealed({ outcome: "differ", diff: bytes });
  assert.deepEqual(handoff(kept.dir, kept.log, "turns: plain", ["differ"]).diff, bytes);
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
  for (const pct of ["100oops", "99.99", "100.01", "", "1e2", "+100", "100 ", "0x64", "99.99999999999999999", "100.000", "100.0"]) no(PERF.replace("100.00", pct), RESULT, "counter not at 100%");
  // A row that does not end with a newline is not a complete row, however it ends.
  no("12345,,cycles:u,1000,100", RESULT, "does not end with a complete row");
  no(`${PERF}12345,,cycles:u,1000,100`, RESULT, "does not end with a complete row");
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

test("masked: Date left out, each masked header's line its name and <masked>, whatever case it was sent in, and every other byte as received", () => {
  const raw = Buffer.from("HTTP/1.1 200 OK\r\nDate: x\r\nETag: 1\r\netag: 2\r\nx-a:\t1 \r\nx-b: caf\xe9\r\n\r\n", "latin1");
  assert.deepEqual(masked(raw, [{ header: "etag" }]), Buffer.from("HTTP/1.1 200 OK\netag: <masked>\netag: <masked>\nx-a:\t1 \nx-b: caf\xe9\n\n", "latin1"));
});

test("masked: a masked header is hidden in the final response's block alone, never in an interim 1xx block or a trailer after the final block, so two answers whose early hints differ in it differ", () => {
  const mask = [{ header: "link" }];
  const raw = (css, n, trailer) => Buffer.from(`HTTP/1.1 103 Early Hints\r\nLink: </${css}.css>; rel=preload\r\nDate: x\r\n\r\nHTTP/1.1 200 OK\r\nLink: <${n}>\r\nDate: y\r\n\r\nLink: ${trailer}\r\n`, "latin1");
  assert.deepEqual(masked(raw("a", 1, "t1"), mask), Buffer.from("HTTP/1.1 103 Early Hints\nLink: </a.css>; rel=preload\n\nHTTP/1.1 200 OK\nlink: <masked>\n\nLink: t1\n", "latin1"));
  assert.ok(!masked(raw("a", 1, "t"), mask).equals(masked(raw("b", 1, "t"), mask)), "103s that differ in a masked header compared the same");
  assert.ok(!masked(raw("a", 1, "t1"), mask).equals(masked(raw("a", 1, "t2"), mask)), "trailers that differ in a masked header compared the same");
  assert.ok(masked(raw("a", 1, "t"), mask).equals(masked(raw("a", 2, "t"), mask)), "final blocks that differ only in a masked header compared different");
  // Two interim blocks: both left as sent.
  const two = Buffer.from("HTTP/1.1 100 Continue\r\nLink: 0\r\n\r\nHTTP/1.1 103 Early Hints\r\nLink: 1\r\n\r\nHTTP/1.1 200 OK\r\nLink: 2\r\n\r\n", "latin1");
  assert.deepEqual(masked(two, mask), Buffer.from("HTTP/1.1 100 Continue\nLink: 0\n\nHTTP/1.1 103 Early Hints\nLink: 1\n\nHTTP/1.1 200 OK\nlink: <masked>\n\n", "latin1"));
});
