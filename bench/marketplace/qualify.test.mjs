import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { nativeProbe, qualify } from "./qualify.mjs";
import { qualificationProbes } from "./qualification-fixture.mjs";

async function withControl(fn) {
  const controls = [];
  const server = createServer(async (req, res) => {
    assert.equal(req.url, "/__marketplace/control");
    assert.equal(req.headers.connection, "close");
    let body = ""; for await (const part of req) body += part;
    controls.push(JSON.parse(body)); res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { await fn(`http://127.0.0.1:${server.address().port}`, controls); }
  finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
}
function probeFixture(controls) {
  const p = qualificationProbes(), calls = [];
  const html = '<form method="post"><input type="hidden" name="__RequestVerificationToken" value="secret"><input type="hidden" name="public_record" value="item_1"><input name="email"><input name="target_price"></form>';
  p.page.body = Buffer.from(html).toString("base64"); p.page.bodyLength = Buffer.byteLength(html);
  return { calls, probe(script, input) {
    calls.push([script, input]);
    if (script === "conform-hold") return input.mode === "head" ? p.unfinishedHead : p.cap;
    const { path, headers, method } = input;
    if (path.startsWith("/health")) return p.live;
    if (path.endsWith("/missing")) return path.startsWith("/api") ? p.json404 : p.page404;
    if (headers.host === "unrecognized.invalid") return p.badHost;
    if (headers["x-qualification"]) return p.bigHead;
    if (method === "POST") return headers.origin !== "http://localhost:8080" ? p.crossSite : input.body.length > 2 ** 20 ? p.bigBody : p.ownPost;
    if (method === "DELETE") return p.json405;
    if (method === "HEAD") return p.head;
    if (controls.at(-1)?.hang) return p.slow;
    if (controls.at(-1)?.status === 503) return path.startsWith("/api") ? p.json500 : p.page500;
    if (headers["accept-encoding"] !== "identity") return path.startsWith("/api") ? p.jsonGzip : p.pageBr;
    return path.startsWith("/api") ? p.json : p.page;
  } };
}
test("qualification probes native features, resets upstream failures, and admits no missing capability", async () => {
  await withControl(async (upstream, controls) => {
    const fixture = probeFixture(controls);
    const q = await qualify({ base: "http://localhost:8080", source: "api", upstream, probe: fixture.probe });
    assert.equal(q.eligible, true); assert.deepEqual(q.missing, []);
    assert.deepEqual(controls, [{ status: 503 }, { hang: true }, {}]);
    assert.ok(fixture.calls.some(([, r]) => r.mode === "cap"));
    assert.ok(fixture.calls.some(([, r]) => r.method === "POST" && r.headers.origin === "https://other.invalid"));
    const own = fixture.calls.find(([, r]) => r.method === "POST" && r.headers.origin === "http://localhost:8080")[1];
    const cross = fixture.calls.find(([, r]) => r.method === "POST" && r.headers.origin === "https://other.invalid")[1];
    assert.match(own.body, /__RequestVerificationToken/); assert.doesNotMatch(cross.body, /__RequestVerificationToken/);
    assert.match(cross.body, /public_record/, "public routing fields must not be stripped to manufacture rejection");
  });
});
test("probe execution/health errors fail the harness instead of excluding an app; upstream is restored", async () => {
  await withControl(async (upstream, controls) => {
    const fixture = probeFixture(controls);
    await assert.rejects(qualify({ base: "http://localhost:8080", source: "api", upstream, probe(script, input) {
      if (controls.at(-1)?.hang) throw new Error("probe crashed");
      return fixture.probe(script, input);
    } }), /probe crashed/);
    assert.deepEqual(controls.at(-1), {});
  });
  await assert.rejects(qualify({ base: "http://localhost:8080", source: "fixture", probe: () => ({ status: 503 }) }), /healthy page/);
  assert.throws(() => nativeProbe("absent-qualification-test", {}), /qualification probe failed/);
});
