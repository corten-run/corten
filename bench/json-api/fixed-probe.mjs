// Parent-operated two-second stock-k6 observation, not a benchmark or a native app gate.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { captureFixedPrototype } from "./fixed-prototype.mjs";

export function probeFixture(mode = "healthy") {
  assert.ok(["healthy", "mixed"].includes(mode));
  const counts = { requests: 0, "200": 0, "429": 0, "503": 0 };
  const server = createServer((request, response) => {
    if (request.method !== "GET" || !/^\/api\/catalog\/record_([1-9]\d{0,2})$/.test(request.url) || Number(request.url.split("_").at(-1)) > 500) {
      response.writeHead(404, { "Content-Type": "application/json" }); response.end("{}"); return;
    }
    const status = mode === "healthy" ? 200 : [200, 429, 503][counts.requests % 3]; counts.requests++; counts[String(status)]++;
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ syntheticClockProbe: true, status }));
  });
  return { server, counts };
}

export async function runProbe(binary, folder) {
  const { server, counts } = probeFixture("healthy");
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const replay = await captureFixedPrototype({ binary, folder, base: `http://127.0.0.1:${server.address().port}`, seconds: 2, rate: 150 });
    assert.equal(replay.loadOutcome, "passed"); assert.equal(replay.targetOutcome, null); assert.equal(replay.status, "unqualified");
    assert.equal(replay.requests, counts.requests); assert.ok(replay.requests >= 300);
    assert.equal(replay.statusCounts["200"], counts.requests); assert.equal(counts["429"] + counts["503"], 0);
    writeFileSync(join(folder, "fixture.json"), JSON.stringify({ synthetic: true, nativeQualification: false, counts }, null, 2), { flag: "wx" });
    return replay;
  } finally {
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    assert.equal(process.argv.length, 4, "use fixed-probe.mjs ABSOLUTE_PINNED_K6_BINARY NEW_OUTPUT_DIRECTORY");
    console.log(JSON.stringify(await runProbe(process.argv[2], resolve(process.argv[3]))));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
