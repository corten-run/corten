import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import { request } from "node:http";
import { test } from "node:test";
import { allApps } from "./apps.mjs";
import { edgeBase, edgeBound, edgeCores, edgeOffset, nginxConf } from "./edge.mjs";
import { productionServer } from "./apps/nextjs/server-profile.mjs";

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
  // Next.js fixes serverActions.allowedOrigins when it builds, so its Dockerfile names the edge's host
  // and passes it to the build, whose config lists it only under the profile.
  const dockerfile = readFileSync(new URL("apps/nextjs/Dockerfile", import.meta.url), "utf8");
  const host = new URL(edgeBase(allApps.nextjs, "outside")).host;
  assert.equal(/^ARG EDGE_HOST=(\S+)$/m.exec(dockerfile)?.[1], host);
  // A build argument is in the environment of the RUN lines after it, so the build reads both.
  assert.match(dockerfile, /^ARG PROFILE=\nARG EDGE_HOST=\S+\nRUN npm run build$/m);
  const config = (/** @type {Record<string, string>} */ env) => {
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", 'const c = (await import("./apps/nextjs/next.config.mjs")).default; console.log(JSON.stringify({ origins: c.experimental?.serverActions?.allowedOrigins ?? null, proxy: c.pageExtensions ?? null }))'], { cwd: import.meta.dirname, encoding: "utf8", env: { PATH: process.env.PATH ?? "", ...env } });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const matched = config({ PROFILE: "matched", EDGE_HOST: host });
  assert.deepEqual(matched.origins, [host]);
  assert.ok(matched.proxy.includes("matched.ts"), "the matched build takes proxy.matched.ts");
  assert.deepEqual(config({ PROFILE: "", EDGE_HOST: host }), { origins: null, proxy: null }, "the defaults build's config is as before");
});

for (const PROFILE of ["", "matched"]) {
  test(`Next custom server sends actual ${PROFILE || "default"} HTTP headers and CSP`, async () => {
    const server = productionServer((req, res) => res.end(JSON.stringify({ nonce: req.headers["x-nonce"] ?? null, policy: req.headers["content-security-policy"] ?? null })), { PROFILE });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const get = () => new Promise((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port: server.address().port, path: "/marketplace/en-US/item_1", agent: false }, (res) => {
          let body = "";
          res.setEncoding("utf8").on("data", (part) => body += part);
          res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(body) }));
          res.on("error", reject);
        });
        req.on("error", reject);
        req.setTimeout(2000, () => req.destroy(new Error("header test timed out")));
        req.end();
      });
      const first = await get(), second = await get();
      assert.equal(first.status, 200);
      const expected = { "x-content-type-options": "nosniff", "referrer-policy": "strict-origin-when-cross-origin", "x-frame-options": "DENY", "cross-origin-opener-policy": "same-origin", "permissions-policy": "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()", "cache-control": "private, no-store" };
      for (const [key, value] of Object.entries(expected)) assert.equal(first.headers[key], PROFILE ? value : undefined, key);
      if (PROFILE) {
        assert.match(first.body.nonce, /^[A-Za-z0-9+/]{22}==$/);
        assert.notEqual(first.body.nonce, second.body.nonce);
        const policy = `default-src 'self'; script-src 'self' 'nonce-${first.body.nonce}'; style-src 'self' 'nonce-${first.body.nonce}'; img-src 'self' data: https:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`;
        assert.equal(first.headers["content-security-policy"], policy);
        assert.equal(first.body.policy, policy, "native handler receives the same trusted nonce policy");
      } else {
        assert.equal(first.headers["content-security-policy"], undefined);
        assert.deepEqual(first.body, { nonce: null, policy: null });
      }
    } finally {
      const closed = once(server, "close");
      server.close(); server.closeAllConnections(); await closed;
    }
  });
}
