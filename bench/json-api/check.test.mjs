import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { catalogServer } from "../catalog/upstream.mjs";
import { marketplaceServer } from "../marketplace/upstream.mjs";
import { captureJson } from "./check.mjs";
import { descriptor, payloads } from "./contract.mjs";
import { verifyFunctional } from "./evidence.mjs";
import { firstJson } from "./cold.mjs";

async function listen(server) {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) { await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }); }
test("shared functional gate retains actual raw responses for all four payload/source cases without native qualification", { timeout: 120000 }, async () => {
  const folder = mkdtempSync(join(tmpdir(), "json-api-check-"));
  try {
    for (const profile of descriptor().cases) {
      const p = payloads[profile.payload], records = p.records(), paths = [];
      const upstreamServer = profile.payload === "catalog-v1" ? catalogServer(records) : marketplaceServer(records);
      const upstream = await listen(upstreamServer);
      // Test adapter only. Its production correctness does not qualify any registry member.
      const app = createServer(async (req, res) => {
        paths.push(req.url); const id = req.url.slice(`/api/${p.path}/`.length);
        const send = (status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
        if (!req.url.startsWith(`/api/${p.path}/`)) return send(404, {});
        try {
          let record = records[id];
          if (profile.source === "api") {
            const response = await fetch(`${upstream}/${p.path}/records/${id}`, { redirect: "manual" });
            if (response.status === 404) return send(404, {});
            if (!response.ok) return send(502, {});
            record = await response.json();
          }
          return record ? send(200, record) : send(404, {});
        } catch { return send(502, {}); }
      });
      try {
        const base = await listen(app), recordsPath = join(folder, "records.json"), rawPath = join(folder, "raw.jsonl");
        writeFileSync(recordsPath, JSON.stringify(records));
        const functional = await captureJson({ identity: profile, recordsPath, rawPath, base, upstream });
        const events = readFileSync(rawPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
        assert.equal(verifyFunctional(functional, events, profile, records), true);
        assert.equal(functional.nativeSerializationVerified, false); assert.equal(functional.readyForLoad, false);
        assert.ok(paths.every((path) => path.startsWith(`/api/${p.path}/`)));
        const mutated = structuredClone(events); mutated.find((e) => e.kind === "application").body = "{}";
        if (profile.source === "fixture") assert.throws(() => verifyFunctional(functional, mutated, profile, records));
      } finally { await close(app); await close(upstreamServer); }
    }
  } finally { assert.equal(dirname(folder), join(tmpdir(), ".")); rmSync(folder, { recursive: true, force: true }); }
});

test("cold readiness accepts JSON endpoints only and fails HTML 200 or malformed JSON", async () => {
  let mode = "json";
  const paths = [], server = createServer((req, res) => {
    paths.push(req.url); res.setHeader("Content-Type", mode === "html" ? "text/html" : "application/json");
    res.end(mode === "html" ? "<html>ready</html>" : mode === "malformed" ? "invalid" : "{}");
  });
  const base = await listen(server);
  try {
    const result = await firstJson(base, "/api/catalog/record_1", 1); assert.equal(result.type, "application/json");
    mode = "html"; await assert.rejects(firstJson(base, "/api/catalog/record_1", 1), /HTML readiness/);
    mode = "malformed"; await assert.rejects(firstJson(base, "/api/marketplace/item_1", 1), /JSON/);
    await assert.rejects(firstJson(base, "/catalog/record_1", 1)); assert.ok(paths.every((p) => p.startsWith("/api/")));
  } finally { await close(server); }
});
