// The edge: the one proxy every app of the matched tier is measured behind (README, "The matched
// tier"), as docs/design.md#limit-http1 expects of a deployed Corten. nginx, one pinned version
// and one config for every app, docs/guide/deploy.md#nginx's less its cache and with the app's own
// name as Host: TLS and HTTP/2
// (HTTP/1.1 for a client that asks for it, no HTTP/3) to k6 and Chromium, HTTP/1.1 to the app
// over kept connections. It runs on cores of its own (BENCH_EDGE_CPUS), and its CPU is counted
// beside each app's (run-ssr.mjs, ssr.mjs). The defaults tier stays direct, so its rounds compare
// with r1 on. Its certificate is made for the run (edgeCertImage), which k6 and Chromium are told
// to accept: a handshake costs what it would with a public one.
import { spawnSync } from "node:child_process";
import { request } from "node:https";

export const edgeImage = "nginx:1.29.8-alpine";
/** Makes the edge's key and certificate (P-256) into the edge's volume before it starts. */
export const edgeCertImage = "alpine/openssl@sha256:6821afa2476e11be343f29275f2ca24291720ff0a7148bd131fd8e314ff26d9e";
export const edgeContainer = "fsw-edge";
const certVolume = "fsw-edge-cert";
/** Each app's port at the edge: its own port plus this, the same inside the network and outside. */
export const edgeOffset = 1000;
/** The edge's cores on a bench host (BENCH_EDGE_CPUS), four CPUs' time otherwise. */
export const edgeCpus = process.env.BENCH_EDGE_CPUS ? ["--cpuset-cpus", process.env.BENCH_EDGE_CPUS] : ["--cpus", "4"];
/** How many CPUs the edge may use: the cores BENCH_EDGE_CPUS lists ("4-7", "4,6"), or four. */
export const edgeCores = (/** @type {string | undefined} */ set = process.env.BENCH_EDGE_CPUS) =>
  set ? set.split(",").reduce((n, part) => { const [a, b = a] = part.split("-").map(Number); return n + b - a + 1; }, 0) : 4;
/**
 * Whether the edge, not the app, may have set a phase's rate: it used at least 90% of the CPUs it
 * had. Such a phase measured the edge.
 * @param {number | null | undefined} edgeCpuUsedPct its share of one CPU, in percent
 * @param {number} cores
 */
export const edgeBound = (edgeCpuUsedPct, cores) => (edgeCpuUsedPct == null ? null : edgeCpuUsedPct >= 90 * cores);

/**
 * The nginx config: a worker a core, one server an app at its edge port, proxied to the app as k6
 * reaches it directly in the defaults tier (its container name, which Corten's host list has),
 * keeping up to 1,024 idle connections to it for less than Corten's header timeout (as
 * docs/guide/deploy.md#nginx does, with more connections, since k6 holds 256). No access log, no
 * compression of its own (the apps compress), no cache.
 * @param {[string, { port: number }][]} apps @param {number} [workers]
 */
export const nginxConf = (apps, workers = edgeCores()) => [
  `worker_processes ${workers};`,
  "events { worker_connections 8192; }",
  "http {",
  "  access_log off;",
  // nginx closes a kept connection after 1,000 requests by default, on both sides: at a load
  // phase's rates that is a new handshake to k6 and a new connection to the app every few seconds.
  "  keepalive_requests 1000000;",
  // The apps start after the edge, one at a time (run-ssr.mjs): `resolve` lets it start before
  // they are up, and reachApp reloads it once one is, so it resolves the app's address then.
  "  resolver 127.0.0.11 valid=1s ipv6=off;",
  ...apps.flatMap(([name, app]) => [
    `  upstream ${name} { zone ${name} 64k; server fsw-${name}:8080 resolve; keepalive 1024; keepalive_requests 1000000; keepalive_timeout 25s; }`,
    "  server {",
    // A socket a worker, so the kernel spreads new connections across the workers evenly.
    `    listen ${app.port + edgeOffset} ssl reuseport;`,
    "    http2 on;",
    "    ssl_certificate /cert/cert.pem;",
    "    ssl_certificate_key /cert/key.pem;",
    "    location / {",
    `      proxy_pass http://${name};`,
    "      proxy_http_version 1.1;",
    '      proxy_set_header Connection "";',
    `      proxy_set_header Host fsw-${name}:8080;`,
    "    }",
    "  }",
  ]),
  "}",
].join("\n") + "\n";

/** Where k6 (inside the bench network) or Chromium (on the host) reaches an app through the edge. */
export const edgeBase = (/** @type {{ port: number }} */ app, /** @type {"inside" | "outside"} */ from) =>
  `https://${from === "inside" ? edgeContainer : "localhost"}:${app.port + edgeOffset}`;

/** Whether one HTTPS request to the edge was answered at all (any status: the app may not be up). */
const answers = (/** @type {number} */ port) => new Promise((done) => {
  const req = request({ host: "127.0.0.1", port, path: "/", rejectUnauthorized: false, timeout: 2000 }, (res) => { res.resume(); done(true); });
  req.on("timeout", () => req.destroy());
  req.on("error", () => done(false));
  req.end();
});

/**
 * Once an app is up, has the edge resolve it again (a reload) and waits until the app answers
 * `path` through it with a 200, up to 30 s; the error, if any.
 * @param {{ port: number }} app @param {string} path
 */
export const reachApp = async (app, path) => {
  const reload = spawnSync("docker", ["exec", edgeContainer, "nginx", "-s", "reload"], { encoding: "utf8" });
  if (reload.status !== 0) return `the edge did not reload: ${reload.stderr.trim()}`;
  const port = app.port + edgeOffset;
  let last = "no answer";
  for (const deadline = Date.now() + 30_000; Date.now() < deadline;) {
    const status = await new Promise((done) => {
      const req = request({ host: "127.0.0.1", port, path, rejectUnauthorized: false, timeout: 2000 }, (res) => { res.resume(); done(res.statusCode); });
      req.on("timeout", () => req.destroy());
      req.on("error", () => done(null));
      req.end();
    });
    if (status === 200) return null;
    last = status === null ? "no answer" : `${status}`;
    await new Promise((r) => setTimeout(r, 250));
  }
  return `the app did not answer ${path} through the edge within 30 s (${last})`;
};

export const stopEdge = () => spawnSync("docker", ["rm", "-f", edgeContainer], { encoding: "utf8" });

/**
 * Starts the edge for these apps on the network (removing one left from before), publishing each
 * app's edge port, and waits until it answers on the first, up to a minute; the error, if any
 * (with the edge removed).
 * @param {[string, { port: number }][]} apps @param {string} network
 */
export const startEdge = async (apps, network) => {
  const docker = (/** @type {string[]} */ ...args) => spawnSync("docker", args, { encoding: "utf8" });
  stopEdge();
  const cert = docker("run", "--rm", "-v", `${certVolume}:/cert`, edgeCertImage, "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", "/cert/key.pem", "-out", "/cert/cert.pem", "-days", "7", "-subj", "/CN=localhost", "-addext", `subjectAltName=DNS:localhost,DNS:${edgeContainer}`);
  if (cert.status !== 0) return `the edge's certificate: ${cert.stderr.trim()}`;
  const publish = apps.flatMap(([, app]) => ["-p", `${app.port + edgeOffset}:${app.port + edgeOffset}`]);
  // The config goes in by the environment, so the edge needs no file of the checkout mounted.
  const run = docker("run", "-d", "--name", edgeContainer, "--network", network, ...edgeCpus, "--memory", "1g", ...publish, "-v", `${certVolume}:/cert:ro`, "-e", `NGINX_CONF=${nginxConf(apps)}`, "--entrypoint", "sh", edgeImage, "-c", 'printf "%s" "$NGINX_CONF" > /etc/nginx/nginx.conf && exec nginx -g "daemon off;"');
  if (run.status !== 0) { stopEdge(); return `${edgeContainer}: ${run.stderr.trim()}`; }
  const port = apps[0][1].port + edgeOffset;
  for (const deadline = Date.now() + 60_000; Date.now() < deadline;) {
    if (await answers(port)) return null;
    await new Promise((r) => setTimeout(r, 250));
  }
  const logs = docker("logs", "--tail", "20", edgeContainer);
  stopEdge();
  return `${edgeContainer} did not answer on ${port} within a minute: ${(logs.stdout + logs.stderr).trim()}`;
};
