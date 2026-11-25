// park.mjs <strace output> none|timed <requests>: for the workloads `beside` and `besidemt`, reads
// what park.sh recorded of one watched turn: every wait for an event (epoll_wait, epoll_pwait or
// epoll_pwait2) the server's threads made while the turn's load ran, as
//   strace -f -e trace=epoll_wait,epoll_pwait,epoll_pwait2 -o <file> -p <server>
// writes them. The timeout a wait was given is what shows, from outside the process, whether a
// timer stands in the runtime's timer wheel: tokio's driver waits with no timeout (-1) while the
// wheel is empty and with one while any timer waits in it. A wait given a timeout of 0 cannot
// block and is no park: the multi-threaded scheduler looks for events that way between tasks,
// on either side, so such a wait is counted apart and tells nothing. The rule, on the waits that
// can block:
//   none    every one had no timeout (the base: its deadlines' timers are dropped with their
//           requests, so the idle connection leaves none behind)
//   timed   every one had a timeout (the head: the idle connection's kept timer was set by its
//           third request and stands for a deadline's length)
// and at least 100 of them were read, and no line is in a form this script does not know. Prints
//   PARK holds: <n> waits that can block in the turn, <r> a request of <requests>; every one with <what>; <z> more that cannot (a timeout of 0) passed over
// and exits 0, or a line that begins PARK FAILED and exit 1. A wait still unfinished when strace
// was stopped, or whose return was not seen, is not counted; a signal's or an exit's line is
// passed over. --selftest reads made-up outputs that hold each rule and that break it.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** One line of strace's output: null to pass over, { timeout } (ms, -1 for none) for a wait that
 * returned, or { error } for a line that is none of those. */
export function wait(line) {
  const m = /^(\d+) +(.*)$/.exec(line);
  if (!m) return line.trim() === "" ? null : { error: "no thread id" };
  const rest = m[2];
  if (/^(---|\+\+\+) /.test(rest) || /<unfinished \.\.\.>\s*$/.test(rest) || /<detached \.\.\.>/.test(rest)) return null;
  const call = /^(?:(epoll_wait|epoll_pwait|epoll_pwait2)\(|<\.\.\. (epoll_wait|epoll_pwait|epoll_pwait2) resumed>)/.exec(rest);
  if (!call) return { error: "not a wait for an event" };
  const name = call[1] ?? call[2];
  if (/\)\s+= \?\s*$/.test(rest)) return null;
  let t;
  if (name === "epoll_wait") t = /, (-?\d+)\)\s+= -?\d+/.exec(rest);
  else if (name === "epoll_pwait") t = /, (-?\d+), (?:NULL|~?\[[^\]]*\]), \d+\)\s+= -?\d+/.exec(rest);
  else {
    const p = /, (NULL|\{tv_sec=(\d+), tv_nsec=(\d+)\}), (?:NULL|~?\[[^\]]*\]), \d+\)\s+= -?\d+/.exec(rest);
    if (!p) return { error: "a wait whose timeout is not read" };
    return { timeout: p[1] === "NULL" ? -1 : Number(p[2]) * 1000 + Number(p[3]) / 1e6 };
  }
  if (!t) return { error: "a wait whose timeout is not read" };
  return { timeout: Number(t[1]) };
}

/** The verdict on a whole output: { ok, line }. */
export function verdict(text, rule, requests) {
  if (!["none", "timed"].includes(rule)) return { ok: false, line: `PARK FAILED: the rule is none or timed, not "${rule}"` };
  if (!(requests >= 1)) return { ok: false, line: "PARK FAILED: no requests in the turn" };
  const waits = [], lines = text.split("\n");
  let polls = 0;
  for (let i = 0; i < lines.length; i++) {
    const w = wait(lines[i]);
    if (w === null) continue;
    if (w.error) return { ok: false, line: `PARK FAILED: line ${i + 1} is ${w.error}: ${lines[i].slice(0, 120)}` };
    if (w.timeout === 0) polls++;
    else waits.push({ at: i + 1, timeout: w.timeout });
  }
  if (waits.length < 100) return { ok: false, line: `PARK FAILED: ${waits.length} waits that can block read (and ${polls} that cannot), fewer than 100: the turn was not watched` };
  const timed = waits.filter((w) => w.timeout !== -1), bad = rule === "none" ? timed : waits.filter((w) => w.timeout === -1);
  if (bad.length) return { ok: false, line: `PARK FAILED: ${bad.length} of ${waits.length} waits that can block had ${rule === "none" ? "a timeout" : "no timeout"}, the first at line ${bad[0].at} (${bad[0].timeout === -1 ? "none" : `${bad[0].timeout} ms`}): ${rule === "none" ? "a timer stood in the wheel where the workload is declared to have none" : "no timer stood in the wheel where the workload is declared to have the idle connection's"}` };
  const per = (waits.length / requests).toFixed(2);
  const what = rule === "none" ? "no timeout" : `a timeout, from ${Math.min(...timed.map((w) => w.timeout))} to ${Math.max(...timed.map((w) => w.timeout))} ms`;
  return { ok: true, line: `PARK holds: ${waits.length} waits that can block in the turn, ${per} a request of ${requests}; every one with ${what}; ${polls} more that cannot (a timeout of 0) passed over` };
}

function selftest() {
  const ev = "[{events=EPOLLIN, data={u32=1, u64=1}}]";
  const many = (n, f) => Array.from({ length: n }, (_, i) => f(i)).join("\n") + "\n";
  const none = () => `4242 epoll_wait(5, ${ev}, 1024, -1) = 1`;
  const timed = (i) => `4242 epoll_wait(5, ${ev}, 1024, ${29990 - i}) = 1`;
  const poll = () => "4242  epoll_wait(5, [], 1024, 0)        = 0";
  const split = (t) => () => `4242 epoll_wait(5,  <unfinished ...>\n4243 +++ exited with 0 +++\n4242 <... epoll_wait resumed>${ev}, 1024, ${t}) = 1`;
  const CASES = [
    ["300 waits with no timeout, read as the base", many(300, none), "none", 300, /^PARK holds: 300 waits that can block in the turn, 1\.00 a request of 300; every one with no timeout; 0 more that cannot \(a timeout of 0\) passed over$/],
    ["300 waits with a timeout, read as the head", many(300, timed), "timed", 300, /^PARK holds: 300 waits that can block in the turn, 1\.00 a request of 300; every one with a timeout, from 29691 to 29990 ms; 0 more /],
    ["300 waits with no timeout, read as the head", many(300, none), "timed", 300, /^PARK FAILED: 300 of 300 waits that can block had no timeout, the first at line 1 \(none\): no timer stood in the wheel/],
    ["300 waits with a timeout, read as the base", many(300, timed), "none", 300, /^PARK FAILED: 300 of 300 waits that can block had a timeout, the first at line 1 \(29990 ms\): a timer stood in the wheel/],
    ["one wait of 300 with no timeout, read as the head", many(150, timed) + none() + "\n" + many(149, timed), "timed", 300, /^PARK FAILED: 1 of 300 waits that can block had no timeout, the first at line 151 /],
    ["one wait of 300 with a timeout of 5 ms, read as the base", many(150, none) + `4242 epoll_wait(5, ${ev}, 1024, 5) = 1\n` + many(149, none), "none", 300, /^PARK FAILED: 1 of 300 waits that can block had a timeout, the first at line 151 \(5 ms\)/],
    ["waits with no timeout and as many with a timeout of 0 between them, read as the base", many(300, (i) => none() + "\n" + poll()), "none", 300, /^PARK holds: 300 waits that can block in the turn, 1\.00 a request of 300; every one with no timeout; 300 more that cannot \(a timeout of 0\) passed over$/],
    ["the same, read as the head (a wait that cannot block is no sign of a timer)", many(300, (i) => none() + "\n" + poll()), "timed", 300, /^PARK FAILED: 300 of 300 waits that can block had no timeout/],
    ["waits with a timeout and as many with a timeout of 0, read as the head", many(300, (i) => timed(i) + "\n" + poll()), "timed", 300, /^PARK holds: 300 waits that can block in the turn, 1\.00 a request of 300; every one with a timeout, from 29691 to 29990 ms; 300 more /],
    ["300 waits with a timeout of 0 and nothing else", many(300, poll), "none", 300, /^PARK FAILED: 0 waits that can block read \(and 300 that cannot\), fewer than 100: the turn was not watched$/],
    ["waits written in two parts beside another thread's lines, with a timeout", many(120, split(250)), "timed", 100, /^PARK holds: 120 waits that can block in the turn, 1\.20 a request of 100; every one with a timeout, from 250 to 250 ms; 0 more /],
    ["waits written in two parts, with no timeout, read as the head", many(120, split(-1)), "timed", 100, /^PARK FAILED: 120 of 120 waits that can block had no timeout/],
    ["the last wait unfinished when strace was stopped, and a signal's line", many(200, timed) + "4242 --- SIGTERM {si_signo=SIGTERM, si_code=SI_USER, si_pid=1, si_uid=0} ---\n4242 epoll_wait(5,  <unfinished ...>\n", "timed", 200, /^PARK holds: 200 waits/],
    ["a wait strace was detached from", many(200, none) + "4242 epoll_wait(5, <detached ...>\n", "none", 200, /^PARK holds: 200 waits/],
    ["epoll_pwait with a timeout", many(200, () => `4242 epoll_pwait(5, ${ev}, 1024, 172, NULL, 8) = 1`), "timed", 200, /^PARK holds: 200 waits that can block in the turn, 1\.00 a request of 200; every one with a timeout, from 172 to 172 ms; 0 more /],
    ["epoll_pwait2 with no timeout, read as the head", many(200, () => `4242 epoll_pwait2(5, ${ev}, 1024, NULL, NULL, 8) = 1`), "timed", 200, /^PARK FAILED: 200 of 200 waits that can block had no timeout/],
    ["epoll_pwait2 with a timeout", many(200, () => `4242 epoll_pwait2(5, ${ev}, 1024, {tv_sec=29, tv_nsec=500000000}, NULL, 8) = 1`), "timed", 200, /every one with a timeout, from 29500 to 29500 ms; 0 more /],
    ["40 waits", many(40, timed), "timed", 40, /^PARK FAILED: 40 waits that can block read \(and 0 that cannot\), fewer than 100: the turn was not watched$/],
    ["an empty output", "", "none", 300, /^PARK FAILED: 0 waits that can block read \(and 0 that cannot\), fewer than 100/],
    ["a line of another call", many(200, none) + "4242 read(7, \"GET\", 8192) = 3\n", "none", 200, /^PARK FAILED: line 201 is not a wait for an event/],
    ["a wait whose arguments are cut", many(200, none) + "4242 epoll_wait(5, ...) = 1\n", "none", 200, /^PARK FAILED: line 201 is a wait whose timeout is not read/],
    ["no requests", many(200, none), "none", 0, /^PARK FAILED: no requests in the turn$/],
  ];
  let n = 0;
  for (const [what, text, rule, requests, want] of CASES) {
    const v = verdict(text, rule, requests);
    if (!want.test(v.line) || v.ok !== v.line.startsWith("PARK holds")) { console.log(`FAILED ${what}: ${v.line}`); break; }
    n++;
    console.log(`ok ${what}: ${v.line}`);
  }
  console.log(`${n} of ${CASES.length} cases`);
  process.exit(n === CASES.length ? 0 : 1);
}

if (!process.argv[1] || fileURLToPath(import.meta.url) !== process.argv[1]) {
  // imported: nothing runs
} else if (process.argv[2] === "--selftest") selftest();
else {
  const [file, rule, requests] = process.argv.slice(2);
  if (!file || !rule || !requests) { console.log("PARK FAILED: usage: node park.mjs <strace output> none|timed <requests>"); process.exit(1); }
  const v = verdict(readFileSync(file, "latin1"), rule, Number(requests));
  console.log(v.line);
  process.exit(v.ok ? 0 : 1);
}
