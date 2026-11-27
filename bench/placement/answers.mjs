// answers.mjs: the answers of a placement's two binaries, fetched, checked, compared and kept,
// and each recorded turn's perf and wrk output read, for turns.sh and verify.sh (README.md,
// What it checks, Answers). Standard library only. Every fact about an answer (its status, its
// header lines with Date left out and the plan's mask applied, its body, the difference, the
// lengths and SHA-256s) comes from the bytes of that one answer as this process received them;
// nothing it writes is read back. Every file it writes is created new (O_CREAT|O_EXCL, which on
// Linux, where the kit runs, follows no link, dangling or not), so anything already at its path,
// a link to /dev/null included, fails it.
//
//   node answers.mjs compare <say> <answers dir> <A port> <B port> <path> <headers.txt> <status> <mask.json> [<expect>]
//       A's answer twice and B's once, each one request (request() below) bounded to 10 s, each
//       of the planned status. Writes <name>.raw-headers, .headers (masked) and .body for A,
//       A-again and B, then diff.txt, bodies.txt and handoff.json, and prints
//       "<same|expected|differ> <SHA-256 of handoff.json>". Exit 1, saying why, for anything else.
//   node answers.mjs start <say> <port> <path> <headers.txt> <status> <out prefix>
//       one answer, of the planned status; writes <out prefix>.raw-headers and prints its SHA-256
//   node answers.mjs starts <say> <mask.json> <file> <SHA-256> <file> <SHA-256>
//       two starts' headers, as start wrote and named them: every masked header differs (mask.mjs)
//   node answers.mjs verified <say> <answers dir> <turns log> <turns say>
//       a placement turns.sh passed: prints "<verdict>; <bodies line>" from what handoff() verifies
//   node answers.mjs turn <say> <perf output> <wrk output> <events> <pair> <version> <raw log> <csv>
//       appends the turn's two outputs, byte for byte, to the raw log and then, when they hold
//       exactly one complete RESULT line of decimal counts with no error and each event once, a
//       count above zero at 100%, its row to the CSV
//   node answers.mjs put <say> <file> <text>
//       creates file holding text and a newline
// <say> starts each line this prints when it fails ("turns: <workload>", say).
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { request as http } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { problems, starts, stated } from "./mask.mjs";

/** A failure this module says as it is, with no stack. */
export class Refusal extends Error {}
const refuse = (why) => { throw new Refusal(why); };
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const KINDS = [["isFIFO", "a FIFO"], ["isDirectory", "a directory"], ["isSymbolicLink", "a symbolic link"], ["isSocket", "a socket"], ["isBlockDevice", "a block device"], ["isCharacterDevice", "a character device"]];

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
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

/** Creates file, which must not be there in any form (on Linux a link, dangling or not, included), with bytes, once. */
export function create(file, bytes) {
  try { writeFileSync(file, bytes, { flag: "wx" }); } catch (e) {
    refuse(e.code === "EEXIST" ? `${file} cannot be written as a new file: something is there before the check made it` : `${file} cannot be written: ${e.message}`);
  }
}

/** A plan's header lines, "Name: value" each, from its headers.txt. */
export function headerLines(text) {
  const lines = text.split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l !== "");
  for (const l of lines) if (!/^[A-Za-z0-9-]+:/.test(l)) refuse(`the request's header line "${l.slice(0, 80)}" is not "Name: value"`);
  return lines;
}

/**
 * One answer of 127.0.0.1:port to the workload's request, the one request builder turns.sh's and
 * verify.sh's checks share: GET path over HTTP/1.1 with Host and the plan's header lines and
 * nothing else (no User-Agent, Accept or Connection header unless the plan's lines have one), no
 * proxy, no configuration file, on a connection of its own, the whole answer within bound ms.
 * Resolves to { status, head, body }: head, the status line and then each header line as
 * received, "Name: value", in order; body, the body as received (with any chunked framing
 * removed and no content coding undone), byte for byte.
 */
export function request(port, path, lines, { bound = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false, timer = null;
    const end = (f, v) => { if (!settled) { settled = true; clearTimeout(timer); f(v); } };
    const req = http({ host: "127.0.0.1", port, path, method: "GET", agent: false, maxHeaderSize: 102400, setHost: !lines.some((l) => /^host:/i.test(l)) });
    for (const l of lines) {
      const at = l.indexOf(":"), name = l.slice(0, at), value = l.slice(at + 1).replace(/^[ \t]+/, ""), had = req.getHeader(name);
      req.setHeader(name, had === undefined ? value : [].concat(had, value));
    }
    // Node adds a Connection header of its own unless one is removed; the plan's, if it has one, is kept.
    if (!lines.some((l) => /^connection:/i.test(l))) req.removeHeader("connection");
    timer = setTimeout(() => req.destroy(new Refusal(`no whole answer on ${port} within ${bound / 1000} s`)), bound);
    req.on("error", (e) => end(reject, e instanceof Refusal ? e : new Refusal(`the request to ${port} failed: ${e.message}`)));
    req.on("response", (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("error", (e) => end(reject, e instanceof Refusal ? e : new Refusal(`the answer on ${port} was cut short (${e.message})`)));
      res.on("close", () => {
        if (!res.complete) return end(reject, new Refusal(`the answer on ${port} was cut short`));
        const head = [`HTTP/${res.httpVersion} ${res.statusCode} ${res.statusMessage}`];
        for (let i = 0; i < res.rawHeaders.length; i += 2) head.push(`${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}`);
        end(resolve, { status: res.statusCode, head, body: Buffer.concat(chunks) });
      });
    });
    req.end();
  });
}

/** An answer's header lines as compared: every one but Date, each the plan masks as "<name>: <masked>". */
export function masked(head, mask) {
  const names = new Set(mask.map((m) => m.header.toLowerCase()));
  return head.filter((l) => !/^date:/i.test(l)).map((l) => {
    const name = /^([^:]+):/.exec(l)?.[1].toLowerCase();
    return name !== undefined && names.has(name) ? `${name}: <masked>` : l;
  });
}

/**
 * The difference of two lists of lines as POSIX diff's default (normal) format prints it, from a
 * longest common subsequence: "" when they are the same.
 */
export function difference(a, b) {
  const n = a.length, m = b.length, lcs = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const range = (from, to) => (to - from > 1 ? `${from + 1},${to}` : `${to}`);
  let out = "", i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { i++; j++; continue; }
    const i0 = i, j0 = j;
    while ((i < n || j < m) && !(i < n && j < m && a[i] === b[j])) {
      if (j >= m || (i < n && lcs[i + 1][j] >= lcs[i][j + 1])) i++; else j++;
    }
    const gone = a.slice(i0, i).map((l) => `< ${l}\n`).join(""), come = b.slice(j0, j).map((l) => `> ${l}\n`).join("");
    if (i > i0 && j > j0) out += `${range(i0, i)}c${range(j0, j)}\n${gone}---\n${come}`;
    else if (i > i0) out += `${range(i0, i)}d${j0}\n${gone}`;
    else out += `${i0}a${range(j0, j)}\n${come}`;
  }
  return out;
}

/** The verdict turns.sh publishes for an outcome that passes. */
export const VERDICT = { same: "answers: same", expected: "answers: differ only as the plan's expected difference says" };

/**
 * A's answer twice and B's once, compared, kept and sealed (the usage above): { outcome, seal },
 * the SHA-256 of handoff.json. dir must hold none of the files it writes. say: where it writes a
 * difference that is not expected, and how one differs from the expected one (stderr).
 */
export async function compare({ dir, ports: [aport, bport], path, lines, status, mask, expect = null, say = (t) => process.stderr.write(t) }) {
  const why = problems(mask);
  if (why.length) refuse(`the plan's mask is not usable: ${why.join("; ")}`);
  const answers = {};
  for (const [name, port] of [["A", aport], ["A-again", aport], ["B", bport]]) {
    const r = await request(port, path, lines), headers = masked(r.head, mask);
    // Kept as received, before anything is checked, so a refusal leaves what it refused.
    create(join(dir, `${name}.raw-headers`), `${r.head.join("\n")}\n`);
    create(join(dir, `${name}.headers`), `${headers.join("\n")}\n`);
    create(join(dir, `${name}.body`), r.body);
    if (r.status !== status) refuse(`${r.head[0]} from ${name === "B" ? "B" : "A"} on ${port} (${join(dir, `${name}.raw-headers`)}), not status ${status}`);
    const out = stated(mask, r.head.join("\n"));
    if (out.length) refuse(`a masked header is not within the range the plan states: ${name}: ${out.join("; ")}`);
    answers[name] = { headers, body: r.body };
  }
  const { A, B } = answers, again = answers["A-again"];
  if (A.headers.join("\n") !== again.headers.join("\n")) refuse(`two answers of A differ in their headers after the mask: ${join(dir, "A*.headers")}`);
  if (!A.body.equals(again.body)) refuse(`two answers of A differ in their bodies: ${join(dir, "A*.body")}`);
  const headers = difference(A.headers, B.headers), same = A.body.equals(B.body);
  const da = sha256(A.body), db = sha256(B.body), na = A.body.length, nb = B.body.length;
  const line = same ? `bodies same: ${na} bytes, sha256 ${da}` : `bodies differ: ${na} and ${nb} bytes, sha256 ${da} and ${db}`;
  // The difference: the headers' and then the bodies line, or nothing when neither differs. These
  // bytes alone are compared with the expected difference and written, once, as diff.txt.
  const text = Buffer.from(headers === "" && same ? "" : `${headers}${line}\n`, "latin1");
  const bodies = Buffer.from(`body ${na} bytes as received, sha256 ${da.slice(0, 16)} A and ${db.slice(0, 16)} B\n`);
  create(join(dir, "diff.txt"), text);
  create(join(dir, "bodies.txt"), bodies);
  let outcome;
  if (expect !== null) {
    if (!text.equals(expect)) {
      const lines = (t) => { const l = t.toString("latin1").split("\n"); if (l.at(-1) === "") l.pop(); return l; };
      say(difference(lines(expect), lines(text)));
      refuse("the answers differ other than as the plan's expected difference says");
    }
    outcome = "expected";
  } else outcome = text.length === 0 ? "same" : "differ";
  if (outcome === "differ") say(text.toString("latin1"));
  const seal = Buffer.from(`${JSON.stringify({ outcome, diff: sha256(text), bodies: sha256(bodies) })}\n`);
  create(join(dir, "handoff.json"), seal);
  return { outcome, seal: sha256(seal) };
}

const BODIES = /^body (\d+) bytes as received, sha256 ([0-9a-f]{16}) A and ([0-9a-f]{16}) B$/;

/**
 * What a comparison turns.sh made, and then stopped its servers after, left in dir, verified: the
 * line "<say>: handoff sha256 <hex>" it printed after that stop, once, in log (its output); the
 * handoff.json of that SHA-256; diff.txt and bodies.txt of the SHA-256s it names; an outcome
 * among allowed, with a diff.txt empty for "same" and not for the others, and one body for
 * "same". Returns { outcome, diff, bodies: { line, bytes, a, b } }, or why not as a string.
 * Throws for a file that is not a regular file (code ENOTREG) or not there (lstat's error).
 */
export function handoff(dir, log, say, allowed) {
  const said = log.split("\n").filter((l) => l.startsWith(`${say}: handoff `));
  if (said.length !== 1 || !/^[0-9a-f]{64}$/.test(said[0].slice(-64)) || said[0] !== `${say}: handoff sha256 ${said[0].slice(-64)}`) return `turns.sh did not say once, after its stop, which handoff its comparison sealed (${said.length} such lines)`;
  const seal = regularBytes(join(dir, "handoff.json"));
  if (sha256(seal) !== said[0].slice(-64)) return `${join(dir, "handoff.json")} is not the handoff turns.sh said it sealed`;
  let h = null;
  try { h = JSON.parse(seal.toString("utf8")); } catch { /* not one */ }
  if (h === null || typeof h !== "object" || Object.keys(h).join(",") !== "outcome,diff,bodies" || ![h.diff, h.bodies].every((d) => typeof d === "string" && /^[0-9a-f]{64}$/.test(d))) return `${join(dir, "handoff.json")} is not a handoff the kit writes`;
  if (!allowed.includes(h.outcome)) return `the comparison sealed the outcome ${JSON.stringify(h.outcome)}, not ${allowed.join(" or ")}`;
  const diff = regularBytes(join(dir, "diff.txt")), bodies = regularBytes(join(dir, "bodies.txt"));
  if (sha256(diff) !== h.diff) return `${join(dir, "diff.txt")} is not the difference the comparison sealed`;
  if (sha256(bodies) !== h.bodies) return `${join(dir, "bodies.txt")} is not the bodies line the comparison sealed`;
  const text = bodies.toString("utf8"), m = text.endsWith("\n") ? BODIES.exec(text.slice(0, -1)) : null;
  if (!m) return `${join(dir, "bodies.txt")} is not a bodies line the kit writes`;
  if ((h.outcome === "same") !== (diff.length === 0) || (h.outcome === "same" && m[2] !== m[3])) return `the comparison sealed the outcome ${h.outcome} with a difference that does not say so`;
  return { outcome: h.outcome, diff: diff.toString("utf8"), bodies: { line: m[0], bytes: Number(m[1]), a: m[2], b: m[3] } };
}

/**
 * A recorded turn's perf and wrk output, as bytes: { requests, values } (each count as perf wrote
 * it), or throws a Refusal saying why it is not a turn to record. at: "pair <pair> <version>".
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
  const rows = text(perf).split("\n").map((l) => l.split(",")), values = [];
  for (const e of events.split(",")) {
    // perf names a cache event without its :u (L1-icache-load-misses), though it counts user space only.
    const bare = e.replace(/:u$/, ""), mine = rows.filter((f) => f[2] === e || f[2] === bare);
    if (mine.length !== 1) refuse(`${e} not reported once in ${at}: ${JSON.stringify(text(perf).slice(0, 400))}`);
    const [v, , , , pct] = mine[0];
    if (!/^\d+$/.test(v) || BigInt(v) === 0n) refuse(`unusable counter ${e} in ${at} (not a count above zero): ${JSON.stringify(v)}`);
    if (!/^\d+(\.\d+)?$/.test(pct ?? "") || Number(pct) !== 100) refuse(`counter not at 100% in ${at}: ${e} ${JSON.stringify(pct ?? null)}`);
    values.push(v);
  }
  return { requests: r[1], values };
}

async function main([mode, say, ...a]) {
  const usage = () => { console.error("usage: node answers.mjs compare|start|starts|verified|turn|put <say> ... (its header says each)"); process.exit(2); };
  const json = (f) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch (e) { return refuse(`${f} cannot be read: ${e.message}`); } };
  const plain = (f) => { try { return readFileSync(f, "utf8"); } catch (e) { return refuse(`${f} cannot be read: ${e.message}`); } };
  const status = (s) => (/^\d{3}$/.test(s) ? Number(s) : refuse(`the planned status ${JSON.stringify(s)} is not a status`));
  const port = (p) => (/^\d+$/.test(p) && Number(p) > 0 && Number(p) < 65536 ? Number(p) : refuse(`${JSON.stringify(p)} is not a port`));
  if (!say) usage();
  try {
    if (mode === "compare" && (a.length === 7 || a.length === 8)) {
      const [dir, ap, bp, path, headers, st, mask, expect = ""] = a;
      let want = null;
      if (expect !== "") try { want = readFileSync(expect); } catch (e) { refuse(`the plan's expected difference, ${expect}, cannot be read: ${e.message}`); }
      const r = await compare({ dir, ports: [port(ap), port(bp)], path, lines: headerLines(plain(headers)), status: status(st), mask: json(mask), expect: want });
      process.stdout.write(`${r.outcome} ${r.seal}\n`);
    } else if (mode === "start" && a.length === 5) {
      const [p, path, headers, st, prefix] = a, r = await request(port(p), path, headerLines(plain(headers))), raw = Buffer.from(`${r.head.join("\n")}\n`, "latin1");
      create(`${prefix}.raw-headers`, raw);
      if (r.status !== status(st)) refuse(`${r.head[0]} on ${p} (${prefix}.raw-headers), not status ${st}: an answer of another status is no evidence for the plan's mask`);
      process.stdout.write(`${sha256(raw)}\n`);
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
    } else if (mode === "put" && a.length === 2) create(a[0], `${a[1]}\n`);
    else usage();
  } catch (e) {
    console.error(`${say}: ${e instanceof Refusal || e?.code === "ENOTREG" || e?.code === "ENOENT" ? e.message : e?.stack ?? e}`);
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main(process.argv.slice(2));
