import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

export async function firstJson(base, path, seconds, ready = () => {}) {
  assert.match(path, /^\/api\/(catalog\/record_1|marketplace\/item_1)$/);
  const deadline = Date.now() + seconds * 1000; let attempts = 0;
  ready();
  while (Date.now() < deadline) {
    attempts++; let response, body, started;
    try {
      started = performance.now();
      response = await fetch(base + path, { headers: { Accept: "application/json", "Accept-Encoding": "identity" },
        redirect: "manual", signal: AbortSignal.timeout(Math.min(1000, Math.max(1, deadline - Date.now()))) });
      body = await response.text();
    } catch {}
    if (response?.status === 200 && body !== undefined) {
      const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
      assert.equal(type, "application/json", "cold 200 must be native JSON, not an HTML readiness page"); JSON.parse(body);
      return { first200At: new Date().toISOString(), successfulRequestMs: performance.now() - started,
        bytes: Buffer.byteLength(body), attempts, path, type, status: 200 };
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`no complete JSON 200 within ${seconds}s (${attempts} probes)`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [base, path, seconds] = process.argv.slice(2);
  try { console.log(JSON.stringify(await firstJson(base, path, Number(seconds), () => console.log("json-probe-ready")))); }
  catch (error) { console.error(error.stack ?? error); process.exitCode = 1; }
}
