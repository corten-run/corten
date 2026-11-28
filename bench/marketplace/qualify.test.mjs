import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { nativeProbe, qualify } from "./qualify.mjs";
import { boundedFeatureProfile, produceBoundedQualification, validateActiveQualification } from "./feature-contract.mjs";
import { boundedQualificationProbes } from "./qualification-fixture.mjs";

const tokenField = "__RequestVerificationToken";
const formToken = "synthetic-hidden-form-token";
const cookieValue = "synthetic-session-cookie";
const headerValue = "synthetic-arbitrary-header";

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
  const p = boundedQualificationProbes("api"), calls = [];
  const html = `<form method="post"><input type="hidden" name="${tokenField}" value="${formToken}"><input type="hidden" name="public_record" value="item_1"><input name="email"><input name="target_price"></form>`;
  p.page.body = Buffer.from(html).toString("base64"); p.page.bodyLength = Buffer.byteLength(html);
  p.page.headers["set-cookie"] = [`session=${cookieValue}; Path=/; HttpOnly`];
  p.page.headers["x-fixture-private"] = headerValue;
  return { calls, probe(script, input) {
    assert.equal(script, "conform-probe", "qualification uses ordinary HTTP only");
    calls.push([script, input]);
    const { path, headers, method } = input;
    if (path.startsWith("/health")) return p.live;
    if (path.endsWith("/missing")) return path.startsWith("/api") ? p.json404 : p.page404;
    if (headers?.host === "unrecognized.invalid") return p.badHost;
    if (path.startsWith("/api") && method === "POST") return p.json405;
    if (method === "POST") return headers.origin !== "http://localhost:8080" ? p.crossSite : p.ownPost;
    if (method === "HEAD") return p.head;
    if (controls.at(-1)?.status === 503) return path.startsWith("/api") ? p.json500 : p.page500;
    if (headers?.["accept-encoding"]) return path.startsWith("/api") ? p.jsonGzip : p.pageBr;
    return path.startsWith("/api") ? p.json : p.page;
  } };
}
test("JSON method qualification uses the page's supported POST, not a globally unimplemented method", async () => {
  for (const source of ["fixture", "api"]) await withControl(async (upstream, controls) => {
    const fixture = probeFixture(controls);
    const q = await qualify({ base: "http://localhost:8080", source, upstream, probe(script, input) {
      // A server may answer 501 for a method implemented by none of its routes.
      if (input.method === "DELETE") return { status: 501, ms: 1, bodyLength: 1, headers: { "content-type": "application/problem+json" } };
      return fixture.probe(script, input);
    } });
    assert.equal(q.eligible, true);
    assert.deepEqual(q.missing, []);
    assert.equal(q.profile, boundedFeatureProfile);
    assert.equal(q.schema, "native-bounded-qualification/v1");
    assert.deepEqual(validateActiveQualification(q), produceBoundedQualification(q.probes, source));
    assert.ok(fixture.calls.some(([, r]) => r.path === "/api/marketplace/item_1" && r.method === "POST"));
    assert.ok(!fixture.calls.some(([, r]) => r.method === "DELETE"));
  });
});

test("JSON method qualification still refuses unsupported response statuses and representations", async () => {
  for (const [status, type] of [[200, "application/json"], [403, "application/problem+json"], [501, "application/problem+json"], [405, "text/html"]]) {
    const fixture = probeFixture([]);
    const q = await qualify({ base: "http://localhost:8080", source: "fixture", probe(script, input) {
      if (input.path === "/api/marketplace/item_1" && input.method === "POST")
        return { status, ms: 1, bodyLength: 1, headers: { "content-type": type } };
      return fixture.probe(script, input);
    } });
    assert.equal(q.eligible, false);
    assert.deepEqual(q.missing, ["json405"]);
  }
});

test("qualification probes native features, resets upstream failures, and admits no missing capability", async () => {
  await withControl(async (upstream, controls) => {
    const fixture = probeFixture(controls);
    const q = await qualify({ base: "http://localhost:8080", source: "api", upstream, probe: fixture.probe });
    assert.equal(q.eligible, true); assert.deepEqual(q.missing, []);
    assert.deepEqual(controls, [{ status: 503 }, {}]);
    assert.ok(q.unmeasured.includes("connectionCap"));
    assert.ok(!Object.hasOwn(q.cells, "connectionCap"));
    assert.equal(q.probes.afterUpstream.status, 200);
    const own = fixture.calls.find(([, r]) => r.method === "POST" && r.headers?.origin === "http://localhost:8080")[1];
    const cross = fixture.calls.find(([, r]) => r.method === "POST" && r.headers?.origin === "https://other.invalid")[1];
    assert.equal(own.headers.cookie, `session=${cookieValue}`);
    assert.equal(new URLSearchParams(own.body).get(tokenField), formToken);
    const crossFields = new URLSearchParams(cross.body);
    assert.equal(crossFields.has(tokenField), false);
    assert.equal(crossFields.get("public_record"), "item_1", "public routing fields must not be stripped to manufacture rejection");

    const saved = JSON.stringify(q);
    const replayed = validateActiveQualification(JSON.parse(saved));
    assert.equal(replayed.probes.ownPost.status, 200);
    assert.equal(replayed.eligible, true);
    assert.ok(!Object.hasOwn(replayed.probes.page.headers, "set-cookie"));
    assert.ok(!Object.hasOwn(replayed.probes.page.headers, "x-fixture-private"));
    const savedPage = Buffer.from(replayed.probes.page.body, "base64").toString("utf8");
    for (const value of [formToken, cookieValue, headerValue]) {
      assert.ok(!saved.includes(value), "synthetic private value leaked into the saved receipt");
      assert.ok(!savedPage.includes(value), "synthetic private value leaked into the decoded saved page");
    }
  });
});
test("probe execution/health errors fail the harness instead of excluding an app; upstream is restored", async () => {
  await withControl(async (upstream, controls) => {
    const fixture = probeFixture(controls);
    await assert.rejects(qualify({ base: "http://localhost:8080", source: "api", upstream, probe(script, input) {
      if (controls.at(-1)?.status === 503) throw new Error("probe crashed");
      return fixture.probe(script, input);
    } }), /probe crashed/);
    assert.deepEqual(controls.at(-1), {});
  });
  await assert.rejects(qualify({ base: "http://localhost:8080", source: "fixture", probe: () => ({ status: 503, ms: 1, bodyLength: 0, headers: {} }) }), /page: unhealthy qualification/);
  await assert.rejects(nativeProbe("absent-qualification-test", {}), /only ordinary HTTP requests are supported/);
});
