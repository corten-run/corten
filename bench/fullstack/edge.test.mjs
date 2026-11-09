import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { allApps } from "./apps.mjs";
import { edgeBase, edgeBound, edgeCores, edgeOffset, nginxConf } from "./edge.mjs";

const apps = /** @type {[string, { port: number }][]} */ ([["corten", { port: 18410 }], ["axum-maud", { port: 18427 }]]);

test("one server an app at its edge port, over TLS and HTTP/2, proxied to the app as k6 reaches it directly", () => {
  const text = nginxConf(apps, 4);
  for (const [name, app] of apps) {
    assert.ok(text.includes(`    listen ${app.port + edgeOffset} ssl reuseport;\n    http2 on;`), name);
    assert.ok(text.includes(`  upstream ${name} { zone ${name} 64k; server fsw-${name}:8080 resolve; keepalive 1024; keepalive_requests 1000000; keepalive_timeout 25s; }`), name);
    assert.ok(text.includes(`      proxy_pass http://${name};`), name);
    assert.ok(text.includes(`      proxy_set_header Host fsw-${name}:8080;`), `${name} sees the Host it is listed under`);
  }
  // Kept connections need HTTP/1.1 and no Connection: close (docs/guide/deploy.md#nginx).
  assert.equal(text.match(/proxy_http_version 1\.1;\n      proxy_set_header Connection "";/g)?.length, apps.length);
});

test("a worker a core, no access log, compression, cache or HTTP/3 of its own", () => {
  const text = nginxConf(apps, 4);
  assert.match(text, /^worker_processes 4;$/m);
  assert.match(text, /^  access_log off;$/m);
  assert.match(text, /^  keepalive_requests 1000000;$/m, "k6's connections are kept for the whole phase");
  assert.match(text, /^  resolver 127\.0\.0\.11 valid=1s ipv6=off;$/m, "an app started after the edge is found");
  assert.doesNotMatch(text, /gzip|proxy_cache|quic|http3/);
});

test("k6 reaches an app at the edge's name on the network, Chromium at localhost, both at its edge port", () => {
  assert.equal(edgeBase({ port: 18410 }, "inside"), "https://fsw-edge:19410");
  assert.equal(edgeBase({ port: 18410 }, "outside"), "https://localhost:19410");
});

test("the edge's cores are counted from BENCH_EDGE_CPUS, and a phase that used 90% of them measured the edge", () => {
  assert.equal(edgeCores("4-7"), 4);
  assert.equal(edgeCores("4,6"), 2);
  assert.equal(edgeCores("4-5,8"), 3);
  assert.equal(edgeCores(""), 4, "off a bench host, four CPUs' time");
  assert.equal(edgeBound(359, 4), false);
  assert.equal(edgeBound(360, 4), true);
  assert.equal(edgeBound(null, 4), null, "a phase reached directly says nothing");
});

test("Next.js's matched build allows the origin a browser posts its server action from through the edge", () => {
  // Next.js fixes serverActions.allowedOrigins when it builds, so its Dockerfile names the edge's host.
  const dockerfile = readFileSync(new URL("apps/nextjs/Dockerfile", import.meta.url), "utf8");
  assert.equal(/^ARG EDGE_HOST=(\S+)$/m.exec(dockerfile)?.[1], new URL(edgeBase(allApps.nextjs, "outside")).host);
});
