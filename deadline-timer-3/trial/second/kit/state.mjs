// state.mjs: reads the packets of one turn of the workload `after` (a pcap file of every packet
// with data sent to the server's port, as state.sh's tcpdump writes it) and says whether the load
// reached the state the plan declares the workload for:
//   node state.mjs <pcap file> <server port> <answered>   prints the verdict; exit 0 it holds, 1 not
//   node state.mjs --selftest                    made-up captures that break each rule must fail
// <answered> is the number of requests wrk counted answered in the turn (its RESULT line).
// The rule, for the 64 connections of `wrk -t2 -c64`:
//   1. the capture holds exactly 64 connections (client ports), and every packet with data begins
//      a request, `GET /wait HTTP/1.1` or `GET /private HTTP/1.1`;
//   2. every connection sends at least MIN_WAITS (3) requests for /wait before its first for
//      /private, so on the head it has set its kept timer before any request that does not wait;
//   3. no connection sends a request for /wait after its first for /private, so nothing in the
//      rest of the turn changes that state (the kept timer stays set for a deadline's length);
//   4. every connection sends at least one request for /private;
//   5. the capture holds at least as many requests as wrk counted answered, so it is the whole
//      turn: an answered request was sent, and tcpdump stopped before it has read its last
//      packets reports none dropped and still lacks the turn's end.
// A request of this load is one write of under 100 bytes, so it is one packet; a packet that
// begins anything else fails rule 1 rather than being guessed at.
import { readFileSync } from "node:fs";

export const MIN_WAITS = 3, CONNECTIONS = 64;
const WAIT = "GET /wait HTTP/1.1\r\n", PLAIN = "GET /private HTTP/1.1\r\n";

/** The requests of a capture, in order: { port, kind: "wait" | "plain" | "other", t (seconds) }. */
export function requests(buf, serverPort) {
  const magic = buf.readUInt32LE(0);
  const unit = magic === 0xa1b2c3d4 ? 1e-6 : magic === 0xa1b23c4d ? 1e-9 : null;
  if (unit === null) throw new Error(`not a little-endian pcap file (magic ${magic.toString(16)})`);
  const link = buf.readUInt32LE(20);
  if (link !== 1) throw new Error(`link type ${link}, not Ethernet (1)`);
  const out = [];
  for (let at = 24; at + 16 <= buf.length; ) {
    const t = buf.readUInt32LE(at) + buf.readUInt32LE(at + 4) * unit, len = buf.readUInt32LE(at + 8);
    const p = buf.subarray(at + 16, at + 16 + len);
    at += 16 + len;
    if (p.length < 34 || p.readUInt16BE(12) !== 0x0800 || p[23] !== 6) throw new Error("a packet that is not TCP over IPv4");
    const ip = 14, tcp = ip + (p[ip] & 0x0f) * 4;
    if (p.readUInt16BE(tcp + 2) !== serverPort) throw new Error(`a packet to port ${p.readUInt16BE(tcp + 2)}`);
    const data = p.subarray(tcp + (p[tcp + 12] >> 4) * 4).toString("latin1");
    if (data.length === 0) continue;
    out.push({ port: p.readUInt16BE(tcp), kind: data.startsWith(WAIT) ? "wait" : data.startsWith(PLAIN) ? "plain" : "other", t });
  }
  return out;
}

/** The verdict on a capture's requests: { ok, why: [...], summary }. */
export function verdict(reqs, answered) {
  const by = new Map(), why = [];
  if (reqs.length < answered) why.push(`the capture holds ${reqs.length} requests and wrk counted ${answered} answered: it is not the whole turn`);
  for (const r of reqs) {
    if (!by.has(r.port)) by.set(r.port, { waits: 0, plains: 0, waitAfterPlain: 0, other: 0 });
    const c = by.get(r.port);
    if (r.kind === "other") c.other++;
    else if (r.kind === "plain") c.plains++;
    else if (c.plains) c.waitAfterPlain++;
    else c.waits++;
  }
  const cs = [...by.values()], sum = (f) => cs.reduce((a, c) => a + f(c), 0);
  const least = (f) => (cs.length ? Math.min(...cs.map(f)) : 0), most = (f) => (cs.length ? Math.max(...cs.map(f)) : 0);
  if (cs.length !== CONNECTIONS) why.push(`${cs.length} connections, not ${CONNECTIONS}`);
  if (sum((c) => c.other)) why.push(`${sum((c) => c.other)} packets with data that begin neither request`);
  const few = cs.filter((c) => c.waits < MIN_WAITS).length;
  if (few) why.push(`${few} connections sent fewer than ${MIN_WAITS} requests for /wait before their first for /private (least ${least((c) => c.waits)})`);
  const late = cs.filter((c) => c.waitAfterPlain).length;
  if (late) why.push(`${late} connections sent a request for /wait after one for /private`);
  const none = cs.filter((c) => !c.plains).length;
  if (none) why.push(`${none} connections sent no request for /private`);
  const t0 = reqs.length ? reqs[0].t : 0, waits = reqs.filter((r) => r.kind === "wait"), plains = reqs.filter((r) => r.kind === "plain");
  const ms = (t) => ((t - t0) * 1000).toFixed(1);
  const summary = `${reqs.length} requests captured of ${answered} answered; ${cs.length} connections; requests for /wait before a connection's first for /private: least ${least((c) => c.waits)}, most ${most((c) => c.waits)}, ` +
    `${sum((c) => c.waits)} in all, the last sent ${waits.length ? ms(waits[waits.length - 1].t) : "-"} ms after the turn's first request; ` +
    `requests for /private: least ${least((c) => c.plains)}, most ${most((c) => c.plains)}, ${sum((c) => c.plains)} in all, ` +
    `the first sent at ${plains.length ? ms(plains[0].t) : "-"} ms and the last at ${plains.length ? ms(plains[plains.length - 1].t) : "-"} ms`;
  return { ok: why.length === 0, why, summary };
}

/** A made-up capture: packets [port, payload] to serverPort, one millisecond apart. */
function fake(packets, serverPort) {
  const parts = [Buffer.alloc(24)];
  parts[0].writeUInt32LE(0xa1b2c3d4, 0); parts[0].writeUInt32LE(1, 20);
  packets.forEach(([port, payload], k) => {
    const data = Buffer.from(payload, "latin1"), p = Buffer.alloc(14 + 20 + 20 + data.length), h = Buffer.alloc(16);
    p.writeUInt16BE(0x0800, 12); p[14] = 0x45; p[23] = 6;
    p.writeUInt16BE(port, 34); p.writeUInt16BE(serverPort, 36); p[46] = 0x50;
    data.copy(p, 54);
    h.writeUInt32LE(Math.floor(k / 1000), 0); h.writeUInt32LE((k % 1000) * 1000, 4); h.writeUInt32LE(p.length, 8); h.writeUInt32LE(p.length, 12);
    parts.push(h, p);
  });
  return Buffer.concat(parts);
}

function selftest() {
  // 64 connections, connection c sending waits(c) requests for /wait and then two for /private.
  const good = (waits = () => 3) => {
    const ps = [];
    for (let c = 0; c < 64; c++) for (let i = 0; i < waits(c); i++) ps.push([40000 + c, WAIT]);
    for (let c = 0; c < 64; c++) ps.push([40000 + c, PLAIN], [40000 + c, PLAIN]);
    return ps;
  };
  const cases = [
    ["three waits then plain on 64 connections", good(), true],
    ["sixteen waits then plain on 64 connections", good(() => 16), true],
    ["two waits only on every connection", good(() => 2), false],
    ["one connection with two waits", good((c) => (c === 7 ? 2 : 16)), false],
    ["a wait after a plain", [...good(), [40003, WAIT]], false],
    ["63 connections", good().filter(([p]) => p !== 40063), false],
    ["65 connections", [...good(), [41000, WAIT], [41000, WAIT], [41000, WAIT], [41000, PLAIN]], false],
    ["a packet that begins no request", [...good(), [40001, "POST /private HTTP/1.1\r\n"]], false],
    ["a connection with no plain request", good().filter(([p, d]) => !(p === 40010 && d === PLAIN)), false],
    ["as many requests as were answered", good(), true, good().length],
    ["one request fewer than were answered", good(), false, good().length + 1],
  ];
  let bad = 0;
  for (const [name, packets, want, answered = 0] of cases) {
    const v = verdict(requests(fake(packets, 18083), 18083), answered);
    const ok = v.ok === want;
    if (!ok) bad++;
    console.log(`${ok ? "ok  " : "BAD "} ${name}: ${v.ok ? "holds" : "fails: " + v.why.join("; ")}`);
  }
  console.log(bad ? `STATE-SELFTEST FAILED: ${bad}` : "STATE-SELFTEST-OK");
  process.exit(bad ? 1 : 0);
}

if (process.argv[2] === "--selftest") selftest();
else {
  const [file, port, answered] = process.argv.slice(2);
  if (!file || !Number(port) || !Number(answered)) { console.error("usage: node state.mjs <pcap file> <server port> <answered> | --selftest"); process.exit(2); }
  let v;
  try { v = verdict(requests(readFileSync(file), Number(port)), Number(answered)); }
  catch (e) { console.log(`STATE failed: ${e.message}`); process.exit(1); }
  console.log(`STATE ${v.ok ? "holds" : "fails"}: ${v.summary}`);
  for (const w of v.why) console.log(`STATE fails: ${w}`);
  process.exit(v.ok ? 0 : 1);
}
