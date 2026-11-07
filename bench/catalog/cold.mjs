// Run in a sidecar BEFORE docker start of the fresh app. Both timestamps use the
// Docker host clock. This is container-start-to-first-200, not process-start time.
import { pathToFileURL } from "node:url";
export async function first200(base, path, seconds, ready = () => {}) {
  const deadline = Date.now() + seconds * 1000;
  let attempts = 0;
  let last = "no response";
  ready();
  while (Date.now() < deadline) {
    attempts++;
    try {
      const started = performance.now();
      const response = await fetch(base + path, { headers: { "Accept-Encoding": "identity" }, redirect: "manual", signal: AbortSignal.timeout(Math.min(1000, Math.max(1, deadline - Date.now()))) });
      const body = await response.arrayBuffer();
      last = `HTTP ${response.status}`;
      if (response.status === 200) return { first200At: new Date().toISOString(), successfulRequestMs: performance.now() - started, bytes: body.byteLength, attempts, path };
    } catch (e) { last = e.message; }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`no first 200 in ${seconds}s (${attempts} attempts): ${last}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [base, path, seconds] = process.argv.slice(2);
  try { console.log(JSON.stringify(await first200(base, path, Number(seconds), () => console.log("catalog-probe-ready")))); }
  catch (e) { console.error(e.message); process.exitCode = 1; }
}
