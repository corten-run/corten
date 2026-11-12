// Capability qualification on the same image/configuration as the load. No timing
// result is made here, and no unsupported feature is polyfilled by the harness.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { formOf, formBody, livePaths, capBelow, capHeld } from "../fullstack/conformance.mjs";
import { csrfFields, qualification, validateQualification } from "./feature-contract.mjs";

export function nativeProbe(script, input) {
  const run = spawnSync(process.execPath, [fileURLToPath(new URL(`../fullstack/${script}.mjs`, import.meta.url))],
    { input: JSON.stringify(input), encoding: "utf8", timeout: 90000, maxBuffer: 8 * 1024 * 1024 });
  assert.ok(!run.error && run.status === 0, `qualification probe failed: ${run.error?.message ?? run.stderr}`);
  return JSON.parse(run.stdout);
}
export async function qualify({ base, source, upstream, probe = nativeProbe }) {
  const url = new URL(base), host = url.hostname, port = Number(url.port || 80);
  assert.ok(["fixture", "api"].includes(source));
  const page = "/marketplace/en-US/item_1", json = "/api/marketplace/item_1";
  const request = (path, headers = {}, method = "GET", body) => probe("conform-probe", {
    host, port, path, method, headers: { host: url.host, "accept-encoding": "identity", ...headers },
    timeoutMs: 40000, keepBody: path === page && method === "GET", ...(body === undefined ? {} : { body }),
  });
  const control = async (value) => {
    // Synchronous native probes can outlive the upstream's idle keep-alive timeout.
    // Do not reuse a socket whose close event cannot be processed during that probe.
    const response = await fetch(`${upstream}/__marketplace/control`, { method: "POST", headers: { connection: "close" }, body: JSON.stringify(value), signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200); await response.arrayBuffer();
  };
  const probes = { page: request(page), json: request(json) };
  assert.equal(probes.page.status, 200, "qualification needs a healthy page");
  assert.equal(probes.json.status, 200, "qualification needs healthy JSON");
  probes.pageBr = request(page, { "accept-encoding": "br, gzip" });
  probes.jsonBr = request(json, { "accept-encoding": "br, gzip" });
  probes.jsonGzip = request(json, { "accept-encoding": "gzip" });
  for (const key of ["pageBr", "jsonBr", "jsonGzip"]) assert.equal(probes[key].status, 200, `${key}: healthy content request failed during qualification`);
  probes.page404 = request("/marketplace/en-US/missing");
  probes.json404 = request("/api/marketplace/missing");
  probes.json405 = request(json, {}, "DELETE");
  probes.head = request(json, {}, "HEAD");
  probes.badHost = request(page, { host: "unrecognized.invalid" });
  probes.bigHead = request(page, { "x-qualification": "x".repeat(65536) });
  const html = Buffer.from(probes.page.body, "base64").toString("utf8");
  const form = formOf(html, page);
  if (!form || form.script) probes.form = "no native POST form";
  else {
    const cookie = (probes.page.headers["set-cookie"] ?? []).map((c) => c.split(";")[0]).join("; ");
    const post = (big, origin = base) => {
      const submitted = origin === base ? form : { ...form, fields: form.fields.filter((f) => !f.hidden || !csrfFields.includes(f.name)) };
      const data = formBody(submitted, big);
      return request(form.path, { origin, cookie, "content-type": data.type, "sec-fetch-site": origin === base ? "same-origin" : "cross-site" }, "POST", data.body);
    };
    probes.ownPost = post();
    assert.ok(probes.ownPost.status >= 200 && probes.ownPost.status < 400 && probes.ownPost.headers?.serverfnerror === undefined, "native same-origin form failed during qualification");
    probes.crossSite = post(undefined, "https://other.invalid");
    probes.bigBody = post("x".repeat(3 * 1024 * 1024)); probes.afterBig = request(page);
    assert.equal(probes.afterBig.status, 200, "app stopped serving during feature qualification");
  }
  probes.liveness = [];
  for (const path of livePaths) { const p = { ...request(path), path }; probes.liveness.push(p); if (p.status === 200) { probes.live = p; break; } }
  if (source === "api") {
    try {
      await control({ status: 503 });
      probes.page500 = request(page); probes.json500 = request(json);
      await control({ hang: true }); probes.slow = request(page);
    } finally { await control({}); }
    probes.afterUpstream = request(page);
    assert.equal(probes.afterUpstream.status, 200, "app failed to recover after upstream qualification");
  }
  probes.unfinishedHead = probe("conform-hold", { host, port, path: page, mode: "head", timeoutMs: 40000 });
  probes.cap = probe("conform-hold", { host, port, path: page, mode: "cap", below: capBelow, hold: capHeld, waitMs: 2000, releaseMs: 5000 });
  probes.afterConnections = request(page);
  assert.equal(probes.afterConnections.status, 200, "app failed to recover after connection qualification");
  return validateQualification(qualification(probes, source));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [base, source, upstream, output] = process.argv.slice(2);
  const result = await qualify({ base, source, upstream });
  writeFileSync(output, JSON.stringify(result, null, 2));
  console.log(`${source}: ${result.eligible ? "qualified" : `excluded: ${result.missing.join(", ")}`}`);
}
