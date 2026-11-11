// Measures what Nagle's algorithm does to a burst of small live events. Three copies of the app
// (app/, image corten-nodelay) in their own containers: NODELAY unset (Corten's listeners as they
// are), on and off. nginx in front of them in a fourth, and the client in a fifth, all on one
// Docker network, so every hop is a real TCP connection between network namespaces (loopback
// acknowledges differently). The client (client.mjs) opens each (app, gap) stream REPEAT times in
// a row, ROUNDS rounds after one it discards. A stream whose stream before went to the same app
// reuses nginx's connection to it soon after its last use, as on a proxy with steady traffic
// ("busy"); one whose stream before went to another app follows a pause on that connection while
// the other apps ran ("after idle", how long is reported as idleMs). The order comes from the
// streams as they ran, not from their place in a block. This writes results/<name>.json and
// prints, for each, the median and range of: how long after the headers the first event came (the
// app makes it at once), and how late the second event and the latest one came (arrival after the
// first, less when the app made it after the first).
// Usage: node run.mjs <name> [rounds=20] [repeat=5] [gaps=0,1000,10000] [--image corten-nodelay]
// [--label key=value]... (a label goes on every container and the network it creates).
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const labels = [];
for (let i = args.indexOf("--label"); i >= 0; i = args.indexOf("--label")) labels.push("--label", args.splice(i, 2)[1]);
const imageAt = args.indexOf("--image");
const image = imageAt >= 0 ? args.splice(imageAt, 2)[1] : "corten-nodelay";
const [name = "run", rounds = "20", repeat = "5", gapsArg = "0,1000,10000"] = args;
const gaps = gapsArg.split(",").map(Number);
const apps = ["default", "on", "off"];
const network = "nodelay";
const docker = (...a) => {
  const run = spawnSync("docker", a, { encoding: "utf8", maxBuffer: 1 << 28 });
  if (run.status !== 0) throw new Error(`docker ${a.join(" ")}: ${run.stderr}`);
  return run.stdout;
};
const containers = [...apps.map((app) => `nodelay-${app}`), "nodelay-nginx"];
const cleanUp = () => {
  spawnSync("docker", ["rm", "-f", "-v", ...containers], { encoding: "utf8" });
  spawnSync("docker", ["network", "rm", network], { encoding: "utf8" });
};

cleanUp();
docker("network", "create", ...labels, network);
try {
  for (const app of apps) {
    // HOSTS: the host the client asks nginx for, which nginx passes on.
    const env = ["-e", "HOSTS=nodelay-nginx", ...(app === "default" ? [] : ["-e", `NODELAY=${app}`])];
    docker("run", "-d", "--rm", "--name", `nodelay-${app}`, "--network", network, ...labels, ...env, image);
  }
  docker("run", "-d", "--rm", "--name", "nodelay-nginx", "--network", network, ...labels, "-v", `${join(here, "nginx.conf")}:/etc/nginx/nginx.conf:ro`, "nginx:1.29-alpine");
  const urls = gaps.flatMap((gap) => apps.map((app) => `http://nodelay-nginx/${app}/burst/${gap}`));
  const client = (rounds, repeat) =>
    docker("run", "--rm", "--network", network, ...labels, "-v", `${here}:/nodelay:ro`, "node:24-alpine", "node", "/nodelay/client.mjs", String(rounds), String(repeat), ...urls);
  // The first round warms up the apps and opens nginx's connections to them; it also waits for them.
  for (let tries = 0; ; tries += 1) {
    try { client(1, 1); break; } catch (error) { if (tries === 30) throw error; await new Promise((r) => setTimeout(r, 1000)); }
  }
  const streams = client(rounds, repeat).trim().split("\n").map((line) => JSON.parse(line));
  const summary = {};
  const stats = (xs) => {
    const sorted = [...xs].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    return { median: +median.toFixed(2), min: +sorted[0].toFixed(2), max: +sorted.at(-1).toFixed(2) };
  };
  // How late each event came after the first, against when the app made it after the first.
  const late = (s, i) => s.arrived[i] - s.arrived[0] - s.made[i];
  const appOf = (url) => new URL(url).pathname.split("/")[1];
  // Busy or after idle from the stream that ran just before; idleMs, how long the app's connection
  // from nginx had been unused (null for the run's first stream on each app).
  const lastEnded = {};
  streams.forEach((s, i) => {
    const app = appOf(s.url);
    s.idle = i === 0 || appOf(streams[i - 1].url) !== app;
    s.idleMs = app in lastEnded ? +(s.sent - lastEnded[app]).toFixed(1) : null;
    lastEnded[app] = s.ended;
  });
  for (const url of urls) {
    const [, app, , gap] = new URL(url).pathname.split("/");
    for (const [regime, idle] of [["busy", false], ["after idle", true]]) {
      const mine = streams.filter((s) => s.url === url && s.idle === idle);
      if (!mine.length) continue;
      const idleFor = mine.map((s) => s.idleMs).filter((ms) => ms !== null);
      const first = mine.map((s) => s.arrived[0]);
      const worst = mine.map((s) => Math.max(...s.arrived.slice(1).map((_, i) => late(s, i + 1))));
      // Over 20 ms: the first event more than 20 ms after the headers, or a later one more than 20
      // ms late. Held: the second event more than 20 ms late. For a held stream, how many events
      // came with the second (within 0.5 ms of it, the second included), counted by bursts.
      const over = (i) => first[i] > 20 || worst[i] > 20;
      const held = mine.filter((s) => late(s, 1) > 20);
      const withSecond = {};
      for (const s of held) {
        const n = s.arrived.slice(1).filter((t) => Math.abs(t - s.arrived[1]) < 0.5).length;
        withSecond[n] = (withSecond[n] ?? 0) + 1;
      }
      const cell = {
        runs: mine.length,
        events: mine[0].arrived.length,
        idleMs: idleFor.length ? stats(idleFor) : null,
        firstAfterHeadMs: stats(first),
        firstOver20ms: first.filter((ms) => ms > 20).length,
        secondLateMs: stats(mine.map((s) => late(s, 1))),
        worstLateMs: stats(worst),
        over20ms: mine.filter((_, i) => over(i)).length,
        held: held.length,
        heldEventsWithSecond: withSecond,
      };
      if (idle) {
        // After idle, split at 150 ms unused, and each stream over 20 ms with how long its
        // connection had been unused (null: the run's first stream on that app) and how late.
        const split = (keep) => {
          const is = mine.map((s, i) => i).filter((i) => keep(mine[i].idleMs));
          return { runs: is.length, over20ms: is.filter(over).length };
        };
        cell.idleUnder150ms = split((ms) => ms === null || ms < 150);
        cell.idle150msOrMore = split((ms) => ms !== null && ms >= 150);
        cell.over20 = mine.flatMap((s, i) => (over(i) ? [{ idleMs: s.idleMs, lateMs: +Math.max(first[i], worst[i]).toFixed(1) }] : []));
      }
      summary[`${app} gap=${gap}us ${regime}`] = cell;
    }
  }
  const result = {
    name,
    image,
    taken: new Date().toISOString(),
    nginx: spawnSync("docker", ["run", "--rm", ...labels, "nginx:1.29-alpine", "nginx", "-v"], { encoding: "utf8" }).stderr.trim(),
    kernel: docker("run", "--rm", ...labels, "alpine:3", "uname", "-r").trim(),
    rounds: Number(rounds),
    repeat: Number(repeat),
    summary,
  };
  mkdirSync(join(here, "results"), { recursive: true });
  writeFileSync(join(here, "results", `${name}.json`), JSON.stringify(result, null, 1) + "\n");
  writeFileSync(join(here, "results", `${name}.streams.jsonl`), streams.map((s) => JSON.stringify(s)).join("\n") + "\n");
  const range = ({ median, min, max }) => `${median} ms (${min}..${max})`;
  for (const [key, s] of Object.entries(summary)) {
    console.log(`${key.padEnd(30)} runs ${s.runs}  first after head ${range(s.firstAfterHeadMs)}  second late ${range(s.secondLateMs)}  worst late ${range(s.worstLateMs)}  runs with one over 20 ms: ${s.over20ms}`);
  }
} finally {
  cleanUp();
}
