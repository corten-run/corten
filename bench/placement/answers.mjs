// answers.mjs: the answers of a placement's two binaries, captured, checked, compared and kept,
// and each recorded turn's perf and wrk output read, for turns.sh and verify.sh (README.md,
// What it checks, Answers). Standard library, curl and diff. Node does what the shell cannot do
// safely: it creates every file it writes new (O_CREAT|O_EXCL, which on Linux, where the kit runs,
// follows no link, dangling or not, so anything already at its path, a link to /dev/null
// included, fails it), hashes the bytes captured and seals them, and reads perf's and wrk's output.
// An answer is captured by curl, once, the request as the kit has always sent it (curl's own
// Accept and User-Agent left out unless the plan's lines have one, no configuration file, no
// proxy, its URL taken literally (no globbing, and no dot segment removed: the path is the
// request target as the plan gives it, as wrk sends it under the kit's get.lua; a custom script
// can send another), 10 s), its header lines as curl writes them (-D), an interim 1xx response's
// included, and its body as received, straight into files this process has just created and
// holds open; its status is the final response's, as curl reports it and as the status line of
// the final response's block it wrote says (mask.mjs, finalBlock). The headers' difference is the
// system diff's, run once, on the masked headers' files, through those descriptors, under timeout
// of its own (10 s, KILL 2 s later), so neither curl (--max-time 10) nor diff outlives a stop of
// this process by more than its own bound. Every byte stays a Buffer from capture to file; text is made of it only to say something.
//
//   node answers.mjs compare <say> <answers dir> <A port> <B port> <path> <headers.txt> <status> <mask.json> [<expect>]
//       A's answer twice and B's once, each of the planned status. Writes <name>.raw-headers,
//       .body and .headers (masked) for A, A-again and B, then diff.txt, bodies.txt and
//       handoff.json, and prints "<same|expected|differ> <SHA-256 of handoff.json>". Exit 1,
//       saying why, for anything else.
//   node answers.mjs start <say> <port> <path> <headers.txt> <status> <out prefix>
//       one answer, of the planned status; writes <out prefix>.raw-headers and .body and prints
//       the headers' SHA-256
//   node answers.mjs starts <say> <mask.json> <file> <SHA-256> <file> <SHA-256>
//       two starts' headers, as start wrote and named them: every masked header differs (mask.mjs)
//   node answers.mjs verified <say> <answers dir> <turns log> <turns say>
//       a placement turns.sh passed: prints "<verdict>; <bodies line>" from what handoff() verifies
//   node answers.mjs turn <say> <perf output> <wrk output> <events> <pair> <version> <raw log> <csv>
//       appends the turn's two outputs, byte for byte, to the raw log and then, when they hold
//       exactly one complete RESULT line of decimal counts with no error and each event once in a
//       complete row, a count above zero at 100%, its row to the CSV
//   node answers.mjs put <say> <file> [<text>]
//       creates file, holding text and a newline, or nothing
// <say> starts each line this prints when it fails ("turns: <workload>", say).
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, constants, fstatSync, lstatSync, openSync, readSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { finalBlock, finalLines, problems, starts, stated } from "./mask.mjs";

/** A failure this module says as it is, with no stack. */
export class Refusal extends Error {}
const refuse = (why) => { throw new Refusal(why); };
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const KINDS = [["isFIFO", "a FIFO"], ["isDirectory", "a directory"], ["isSymbolicLink", "a symbolic link"], ["isSocket", "a socket"], ["isBlockDevice", "a block device"], ["isCharacterDevice", "a character device"]];

/** Every byte of the file open at fd, from its start, whatever offset the descriptor is at. */
function whole(fd) {
  const out = Buffer.alloc(fstatSync(fd).size);
  for (let at = 0; at < out.length;) { const n = readSync(fd, out, at, out.length - at, at); if (n === 0) return out.subarray(0, at); at += n; }
  return out;
}

/**
 * The bytes of a file the kit left, read only when it is a regular file of its own: never
 * through a link, and a FIFO or a device is never opened, so no read of one can hold the reader.
 * Throws an error with code ENOTREG for anything else, and lstat's when it is not there.
 */
export function regularBytes(file) {
  const not = (s) => { const e = new Error(`${file} is ${KINDS.find(([k]) => s[k]())?.[1] ?? "something else"}, not a regular file, so it is not read`); e.code = "ENOTREG"; return e; };
  const s = lstatSync(file);
  if (!s.isFile()) throw not(s);
  // Opened without following a link and without waiting, so one put in its place since is refused, not read.
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const f = fstatSync(fd);
    if (!f.isFile()) throw not(f);
    return whole(fd);
  } finally { closeSync(fd); }
}

/** Creates file, which must not be there in any form (on Linux a link, dangling or not, included), and returns its descriptor, open to read and write. */
function createFd(file) {
  try { return openSync(file, "wx+"); } catch (e) {
    return refuse(e.code === "EEXIST" ? `${file} cannot be written as a new file: something is there before the check made it` : `${file} cannot be written: ${e.message}`);
  }
}

/** Creates file, which must not be there in any form, with bytes, once. */
export function create(file, bytes) {
  const fd = createFd(file);
  try { writeFileSync(fd, bytes); } catch (e) { refuse(`${file} cannot be written: ${e.message}`); } finally { closeSync(fd); }
}

/** A plan's header lines, "Name: value" each, from its headers.txt. */
export function headerLines(text) {
  const lines = text.split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l !== "");
  for (const l of lines) if (!/^[A-Za-z0-9-]+:/.test(l)) refuse(`the request's header line "${l.slice(0, 80)}" is not "Name: value"`);
  return lines;
}

/**
 * Runs command with args, its standard input closed, its descriptors 1, 3 and up those given
 * (null: a pipe for its standard output), killed through its handle past bound ms. Resolves to
 * { code, signal, late, out, err }: out and err its standard output (when piped) and error, as bytes.
 */
function run(command, args, { out = null, fds = [], bound, env }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", out ?? "pipe", "pipe", ...fds], env });
    const said = [], errs = [];
    let late = false, failed = null;
    const timer = setTimeout(() => { late = true; child.kill("SIGKILL"); }, bound);
    child.stdout?.on("data", (c) => said.push(c));
    child.stderr.on("data", (c) => errs.push(c));
    child.on("error", (e) => { failed = e; });
    child.on("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, late, failed, out: Buffer.concat(said), err: Buffer.concat(errs) }); });
  });
}
const tools = () => ({ PATH: process.env.PATH ?? "", LC_ALL: "C" });
const brief = (err) => err.toString("latin1").trim().split("\n").at(-1)?.slice(0, 200) ?? "";

/**
 * One answer of 127.0.0.1:port to the workload's request, captured by curl, once, the one request
 * turns.sh's and verify.sh's checks share: Host and the plan's header lines, and curl's own
 * Accept and User-Agent left out unless those lines have one, with --disable (no .curlrc),
 * --noproxy '*', --globoff (no {a,b} or [1-2] makes it two requests), --path-as-is (no /./ or
 * /../ is removed, so /root/../target is asked for as that, not as /target) and --max-time 10:
 * the request target is the plan's path, byte for byte. A path curl would still rewrite (a
 * fragment, #..., which it never sends) is refused before any request. curl writes the header lines (-D), every response's (an interim 1xx's
 * included), and the body into <prefix>.raw-headers and <prefix>.body, which this process creates
 * new first and hands curl as its descriptors 3 and 4, so what it captured is in those very files,
 * whatever is put at their paths since; its standard output is the final response's status alone
 * (-w). Resolves to { raw, body, status, line }: the bytes as curl wrote them, the final status
 * and the status line of raw's final response block (mask.mjs, finalBlock), which must state it.
 */
export async function capture(port, path, lines, prefix, { bound = 15000 } = {}) {
  if (!/^\/[\x21-\x7e]*$/.test(path) || path.includes("#")) refuse(`the request's path ${JSON.stringify(path.slice(0, 80))} is not one curl sends as it is: a path from /, of printable ASCII, with no fragment (#)`);
  const has = (name) => lines.some((l) => l.toLowerCase().startsWith(`${name}:`));
  const args = ["--disable", "--noproxy", "*", "--globoff", "--path-as-is", "-sS", "--max-time", "10", "-D", "/dev/fd/3", "-o", "/dev/fd/4", "-w", "%{http_code}",
    ...(has("accept") ? [] : ["-H", "Accept:"]), ...(has("user-agent") ? [] : ["-H", "User-Agent:"]),
    ...lines.flatMap((l) => ["-H", l]), `http://127.0.0.1:${port}${path}`];
  const head = createFd(`${prefix}.raw-headers`);
  try {
    const body = createFd(`${prefix}.body`);
    try {
      const r = await run("curl", args, { fds: [head, body], bound, env: tools() });
      if (r.failed) refuse(`curl could not be run: ${r.failed.message}`);
      if (r.late) refuse(`no whole answer on ${port} within ${bound / 1000} s: curl was stopped`);
      if (r.code !== 0) refuse(`the answer on ${port} could not be taken whole: curl ended with ${r.signal ?? `status ${r.code}`}${r.err.length ? ` (${brief(r.err)})` : ""}`);
      const raw = whole(head), status = r.out.toString("latin1"), { line, code } = finalLine(raw);
      if (!/^[1-9]\d{2}$/.test(status)) refuse(`curl reported no final status for the answer on ${port}: ${JSON.stringify(status.slice(0, 40))}`);
      if (code !== status) refuse(`curl reported the final status ${status} on ${port}, and the status line of the final response it wrote, ${JSON.stringify(line.slice(0, 80))}, does not say so (${prefix}.raw-headers)`);
      return { raw, body: whole(body), status, line };
    } finally { closeSync(body); }
  } finally { closeSync(head); }
}

/**
 * The status line of the final response's block of headers as curl wrote them (mask.mjs,
 * finalBlock: after any interim 1xx block, never a line inside a block or a trailer after it), and
 * its status: { line, code }, "" and null when the headers start with no status line.
 */
function finalLine(raw) {
  const b = finalBlock(raw.toString("latin1"));
  return { line: b?.line ?? "", code: b?.code ?? null };
}

/**
 * An answer's header lines as compared, from the bytes curl wrote: each line's own CR before its
 * LF taken off, every Date line left out, each line of a header the plan masks in the final
 * response's block (mask.mjs, finalBlock) "<name>: <masked>", and every other byte as it is (no
 * whitespace folded, every line kept, however many). An interim 1xx response's block is part of
 * them, and so are any chunked trailers curl wrote after the final block, with no header masked
 * in either: the mask's checks show that a masked header differs between starts in the final
 * block alone (mask.mjs), and nothing shows it may differ in an interim block or a trailer. So an
 * answer sent with early hints differs from one sent without, and from one whose early hints
 * differ, even in a header the plan masks.
 */
export function masked(raw, mask) {
  const names = new Set(mask.map((m) => m.header.toLowerCase())), out = [];
  const final = finalLines(raw.toString("latin1"));
  for (let at = 0, i = 0; at < raw.length; i++) {
    const nl = raw.indexOf(0x0a, at), stop = nl < 0 ? raw.length : nl;
    let line = raw.subarray(at, stop);
    if (nl >= 0 && line.at(-1) === 0x0d) line = line.subarray(0, -1);
    // A header's name is ASCII: latin1 reads each byte as itself.
    const name = /^([^:]*):/.exec(line.toString("latin1"))?.[1].toLowerCase();
    const hidden = name !== undefined && names.has(name) && final !== null && i > final.at && i < final.end;
    if (name !== "date") out.push(hidden ? Buffer.from(`${name}: <masked>`) : line, nl < 0 ? Buffer.alloc(0) : Buffer.from("\n"));
    at = stop + 1;
  }
  return Buffer.concat(out);
}

/**
 * The system diff of the two files open at a and b, reading them through its descriptors 3 and 4,
 * under timeout of its own: seconds, and KILL 2 s later. That bound is timeout's, not this
 * process's, so it holds when this process is stopped first (as its caller's timeout stops it);
 * this process's own, later, is a last resort. timeout runs in the foreground, in this process's
 * group, so a signal to the group reaches diff too.
 */
const diffRun = (a, b, seconds) => run("timeout", ["--foreground", "-k", "2", String(seconds), "diff", "/dev/fd/3", "/dev/fd/4"], { fds: [a, b], bound: (seconds + 5) * 1000, env: tools() });

/**
 * The system diff's difference of the two files open at a and b, in its normal format, run once,
 * reading those very files through its descriptors 3 and 4: { same, text }. Fails unless diff
 * says 0 or 1 and its output agrees with that and with the bytes compared (x and y).
 */
async function difference(a, b, x, y, seconds) {
  const r = await diffRun(a, b, seconds);
  if (r.failed) refuse(`diff could not be run: ${r.failed.message}`);
  const late = r.late || r.code === 124 || r.code === 137;
  if (late || r.code === null || r.code > 1) refuse(`diff could not compare the two answers' headers (${late ? `not within ${seconds} s` : r.signal ?? `status ${r.code}`}${r.err.length ? `: ${brief(r.err)}` : ""})`);
  if ((r.code === 0) !== x.equals(y)) refuse(`diff found the two answers' headers ${r.code === 0 ? "the same" : "different"}, and they are not`);
  if ((r.code === 0) !== (r.out.length === 0)) refuse(r.code === 0 ? "diff reported that the two answers' headers are the same and printed a difference" : "diff reported that the two answers' headers differ and printed no difference: missing evidence");
  return { same: r.code === 0, text: r.out };
}

/** The verdict turns.sh publishes for an outcome that passes. */
export const VERDICT = { same: "answers: same", expected: "answers: differ only as the plan's expected difference says" };

/** The one form of a handoff: these keys in this order, as JSON.stringify writes them, and a newline. */
const sealOf = ({ outcome, diff, bodies }) => Buffer.from(`${JSON.stringify({ outcome, diff, bodies })}\n`);

/**
 * A's answer twice and B's once, compared, kept and sealed (the usage above): { outcome, seal },
 * the SHA-256 of handoff.json. dir must hold none of the files it writes. expect: the plan's
 * expected difference, as bytes, and expected, its file (for diff to show a difference from it).
 * say: where it writes a difference that is not expected, and how one differs from the expected
 * one (stderr). diffSeconds: diff's own bound.
 */
export async function compare({ dir, ports: [aport, bport], path, lines, status, mask, expect = null, expected = null, say = (t) => process.stderr.write(t), diffSeconds = 10 }) {
  const why = problems(mask);
  if (why.length) refuse(`the plan's mask is not usable: ${why.join("; ")}`);
  const answers = {}, open = [];
  try {
    for (const [name, port] of [["A", aport], ["A-again", aport], ["B", bport]]) {
      const at = join(dir, name), { raw, body, status: got, line } = await capture(port, path, lines, at), headers = masked(raw, mask);
      const fd = createFd(`${at}.headers`);
      open.push(fd);
      writeFileSync(fd, headers);
      if (got !== String(status)) refuse(`${line} from ${name === "B" ? "B" : "A"} on ${port} (${at}.raw-headers), not status ${status}`);
      const out = stated(mask, raw.toString("latin1"));
      if (out.length) refuse(`a masked header is not within the range the plan states: ${name}: ${out.join("; ")}`);
      answers[name] = { headers, body, fd };
    }
    const { A, B } = answers, again = answers["A-again"];
    if (!A.headers.equals(again.headers)) refuse(`two answers of A differ in their headers after the mask: ${join(dir, "A*.headers")}`);
    if (!A.body.equals(again.body)) refuse(`two answers of A differ in their bodies: ${join(dir, "A*.body")}`);
    const headers = await difference(A.fd, B.fd, A.headers, B.headers, diffSeconds), same = A.body.equals(B.body);
    const da = sha256(A.body), db = sha256(B.body), na = A.body.length, nb = B.body.length;
    const line = same ? `bodies same: ${na} bytes, sha256 ${da}` : `bodies differ: ${na} and ${nb} bytes, sha256 ${da} and ${db}`;
    // The difference: diff's output and then the bodies line, or nothing when neither differs.
    // These bytes alone are compared with the expected difference and written, once, as diff.txt.
    const text = headers.same && same ? Buffer.alloc(0) : Buffer.concat([headers.text, Buffer.from(`${line}\n`)]);
    const bodies = Buffer.from(`body ${na} bytes as received, sha256 ${da.slice(0, 16)} A and ${db.slice(0, 16)} B\n`);
    const fd = createFd(join(dir, "diff.txt"));
    open.push(fd);
    writeFileSync(fd, text);
    create(join(dir, "bodies.txt"), bodies);
    let outcome;
    if (expect !== null) {
      if (!text.equals(expect)) {
        // Shown as diff shows it, the expected difference against this one; only said, never read.
        let shown = null;
        try { shown = openSync(expected, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); } catch { /* nothing to show it from */ }
        if (shown !== null) try { if (fstatSync(shown).isFile()) say((await diffRun(shown, fd, diffSeconds)).out); } finally { closeSync(shown); }
        refuse("the answers differ other than as the plan's expected difference says");
      }
      outcome = "expected";
    } else outcome = text.length === 0 ? "same" : "differ";
    if (outcome === "differ") say(text);
    const seal = sealOf({ outcome, diff: sha256(text), bodies: sha256(bodies) });
    create(join(dir, "handoff.json"), seal);
    return { outcome, seal: sha256(seal) };
  } finally { for (const fd of open) closeSync(fd); }
}

const BODIES = /^body (\d+) bytes as received, sha256 ([0-9a-f]{16}) A and ([0-9a-f]{16}) B$/;

/**
 * What a comparison turns.sh made, and then stopped its servers after, left in dir, verified: the
 * line "<say>: handoff sha256 <hex>" it printed after that stop, once, in log (its output); the
 * handoff.json of that SHA-256, in the one form compare() writes (so no key twice, and nothing
 * else); diff.txt and bodies.txt of the SHA-256s it names; an outcome among allowed, with a
 * diff.txt empty for "same" and not for the others, and one body for "same". Returns
 * { outcome, diff, bodies: { line, bytes, a, b } }, diff diff.txt's bytes, or why not as a
 * string. Throws for a file that is not a regular file (code ENOTREG) or not there (lstat's error).
 */
export function handoff(dir, log, say, allowed) {
  const said = log.split("\n").filter((l) => l.startsWith(`${say}: handoff `));
  if (said.length !== 1 || !/^[0-9a-f]{64}$/.test(said[0].slice(-64)) || said[0] !== `${say}: handoff sha256 ${said[0].slice(-64)}`) return `turns.sh did not say once, after its stop, which handoff its comparison sealed (${said.length} such lines)`;
  const seal = regularBytes(join(dir, "handoff.json"));
  if (sha256(seal) !== said[0].slice(-64)) return `${join(dir, "handoff.json")} is not the handoff turns.sh said it sealed`;
  let h = null;
  try { h = JSON.parse(seal.toString("utf8")); } catch { /* not one */ }
  if (h === null || typeof h !== "object" || Array.isArray(h) || ![h.outcome, h.diff, h.bodies].every((v) => typeof v === "string") || !seal.equals(sealOf(h)) || ![h.diff, h.bodies].every((d) => /^[0-9a-f]{64}$/.test(d))) return `${join(dir, "handoff.json")} is not a handoff the kit writes`;
  if (!allowed.includes(h.outcome)) return `the comparison sealed the outcome ${JSON.stringify(h.outcome)}, not ${allowed.join(" or ")}`;
  const diff = regularBytes(join(dir, "diff.txt")), bodies = regularBytes(join(dir, "bodies.txt"));
  if (sha256(diff) !== h.diff) return `${join(dir, "diff.txt")} is not the difference the comparison sealed`;
  if (sha256(bodies) !== h.bodies) return `${join(dir, "bodies.txt")} is not the bodies line the comparison sealed`;
  const text = bodies.toString("latin1"), m = text.endsWith("\n") ? BODIES.exec(text.slice(0, -1)) : null;
  if (!m) return `${join(dir, "bodies.txt")} is not a bodies line the kit writes`;
  if ((h.outcome === "same") !== (diff.length === 0) || (h.outcome === "same" && m[2] !== m[3])) return `the comparison sealed the outcome ${h.outcome} with a difference that does not say so`;
  return { outcome: h.outcome, diff, bodies: { line: m[0], bytes: Number(m[1]), a: m[2], b: m[3] } };
}

/**
 * A recorded turn's perf and wrk output, as bytes: { requests, values } (each count as perf wrote
 * it), or throws a Refusal saying why it is not a turn to record. at: "pair <pair> <version>".
 * Only complete rows are read: perf's output must end with a newline, and a counter's
 * percentage is perf's own "100.00" (or "100"), as a string, not any number that reads as 100.
 */
export function turn(perf, wrk, events, at) {
  const text = (b) => b.toString("latin1");
  const lines = text(wrk).split("\n"), last = lines.pop();
  if (last.startsWith("RESULT")) refuse(`wrk's RESULT line in ${at} is not complete: ${JSON.stringify(last.slice(0, 120))}`);
  const results = lines.filter((l) => l.startsWith("RESULT"));
  if (results.length !== 1) refuse(`${results.length === 0 ? "no RESULT line" : `${results.length} RESULT lines`} from wrk in ${at}`);
  const r = /^RESULT (\d+) (\d+) (\d+) (\d+) (\d+) (\d+)$/.exec(results[0]);
  if (!r) refuse(`wrk's RESULT line in ${at} is not six decimal counts: ${JSON.stringify(results[0].slice(0, 120))}`);
  if (r.slice(2).some((c) => BigInt(c) !== 0n)) refuse(`errors in ${at}: requests ${r[1]}, connect ${r[2]}, read ${r[3]}, write ${r[4]}, status ${r[5]}, timeout ${r[6]}`);
  if (BigInt(r[1]) === 0n) refuse(`no requests in ${at}`);
  const all = text(perf).split("\n"), cut = all.pop();
  if (cut !== "") refuse(`perf's output in ${at} does not end with a complete row: ${JSON.stringify(cut.slice(0, 120))}`);
  const rows = all.map((l) => l.split(",")), values = [];
  for (const e of events.split(",")) {
    // perf names a cache event without its :u (L1-icache-load-misses), though it counts user space only.
    const bare = e.replace(/:u$/, ""), mine = rows.filter((f) => f[2] === e || f[2] === bare);
    if (mine.length !== 1) refuse(`${e} not reported once in ${at}: ${JSON.stringify(text(perf).slice(0, 400))}`);
    const [v, , , , pct] = mine[0];
    if (!/^\d+$/.test(v) || BigInt(v) === 0n) refuse(`unusable counter ${e} in ${at} (not a count above zero): ${JSON.stringify(v)}`);
    if (pct !== "100.00" && pct !== "100") refuse(`counter not at 100% in ${at}: ${e} ${JSON.stringify(pct ?? null)}`);
    values.push(v);
  }
  return { requests: r[1], values };
}

async function main([mode, say, ...a]) {
  const usage = () => { console.error("usage: node answers.mjs compare|start|starts|verified|turn|put <say> ... (its header says each)"); process.exit(2); };
  // The plan's files, read only as regular files of their own, so none can hold this process.
  const json = (f) => { try { return JSON.parse(regularBytes(f).toString("utf8")); } catch (e) { return refuse(`${f} cannot be read: ${e.message}`); } };
  const lines = (f) => { let t; try { t = new TextDecoder("utf-8", { fatal: true }).decode(regularBytes(f)); } catch (e) { refuse(`${f} cannot be read as UTF-8 header lines: ${e.message}`); } return headerLines(t); };
  const status = (s) => (/^\d{3}$/.test(s) ? Number(s) : refuse(`the planned status ${JSON.stringify(s)} is not a status`));
  const port = (p) => (/^\d+$/.test(p) && Number(p) > 0 && Number(p) < 65536 ? Number(p) : refuse(`${JSON.stringify(p)} is not a port`));
  if (!say) usage();
  try {
    if (mode === "compare" && (a.length === 7 || a.length === 8)) {
      const [dir, ap, bp, path, headers, st, mask, expect = ""] = a;
      let want = null;
      if (expect !== "") try { want = regularBytes(expect); } catch (e) { refuse(`the plan's expected difference, ${expect}, cannot be read: ${e.message}`); }
      const r = await compare({ dir, ports: [port(ap), port(bp)], path, lines: lines(headers), status: status(st), mask: json(mask), expect: want, expected: expect || null });
      process.stdout.write(`${r.outcome} ${r.seal}\n`);
    } else if (mode === "start" && a.length === 5) {
      const [p, path, headers, st, prefix] = a, wanted = status(st), r = await capture(port(p), path, lines(headers), prefix);
      if (r.status !== String(wanted)) refuse(`${r.line} on ${p} (${prefix}.raw-headers), not status ${st}: an answer of another status is no evidence for the plan's mask`);
      process.stdout.write(`${sha256(r.raw)}\n`);
    } else if (mode === "starts" && a.length === 5) {
      const [file, one, s1, two, s2] = a, mask = json(file), bad = problems(mask);
      if (bad.length) refuse(`the plan's mask is not usable: ${bad.join("; ")}`);
      const [x, y] = [[one, s1], [two, s2]].map(([f, s]) => { const b = regularBytes(f); if (sha256(b) !== s) refuse(`${f} is not the headers its start recorded`); return b.toString("latin1"); });
      const why = starts(mask, x, y);
      if (why.length) refuse(why.join("; "));
      process.stdout.write(`two starts of base: every header the plan masks differs between them (${mask.map((m) => m.header).join(", ") || "none masked"})\n`);
    } else if (mode === "verified" && a.length === 3) {
      const [dir, log, turns] = a, h = handoff(dir, regularBytes(log).toString("utf8"), turns, ["same", "expected"]);
      if (typeof h === "string") refuse(h);
      if (!regularBytes(join(dir, "verdict.txt")).equals(Buffer.from(`${VERDICT[h.outcome]}\n`))) refuse(`${join(dir, "verdict.txt")} is not the verdict of the outcome turns.sh sealed, ${h.outcome}`);
      process.stdout.write(`${VERDICT[h.outcome]}; ${h.bodies.line}\n`);
    } else if (mode === "turn" && a.length === 7) {
      const [perfFile, wrkFile, events, pair, version, raw, csv] = a, perf = regularBytes(perfFile), wrk = regularBytes(wrkFile);
      appendFileSync(raw, Buffer.concat([Buffer.from(`## pair ${pair} ${version}\n`), perf, wrk]));
      const t = turn(perf, wrk, events, `pair ${pair} ${version}`);
      appendFileSync(csv, `${pair},${version},${t.requests},${t.values.join(",")}\n`);
    } else if (mode === "put" && (a.length === 1 || a.length === 2)) create(a[0], a.length === 2 ? `${a[1]}\n` : "");
    else usage();
  } catch (e) {
    console.error(`${say}: ${e instanceof Refusal || e?.code === "ENOTREG" || e?.code === "ENOENT" ? e.message : e?.stack ?? e}`);
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main(process.argv.slice(2));
