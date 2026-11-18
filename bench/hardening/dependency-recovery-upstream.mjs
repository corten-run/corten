import { lstatSync, readFileSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { marketplaceServer } from "../marketplace/upstream.mjs";
import { recoveryProfile } from "./dependency-recovery-contract.mjs";

export const { delayMs, duringMs: windowMs } = recoveryProfile;
export const statusPath = "/__marketplace/dependency-recovery";
const triggerPollMs = 25;
const triggerTimeoutMs = 30 * 60_000;

// Only the owner has the writable mount. No request can schedule or extend the window.
export async function watchRecoveryTrigger(directory, start, { signal } = {}) {
  if (!isAbsolute(directory) || !lstatSync(directory).isDirectory()) throw new Error("invalid recovery trigger directory");
  const file = join(directory, "start");
  if (lstatSync(file, { throwIfNoEntry: false })) throw new Error("recovery trigger already exists");
  const deadline = performance.now() + triggerTimeoutMs;
  try {
    while (!signal?.aborted && performance.now() < deadline) {
      const info = await lstat(file).catch(error => { if (error.code !== "ENOENT") throw error; });
      if (signal?.aborted || performance.now() >= deadline) break;
      if (info) {
        if (!info.isFile()) throw new Error("recovery trigger must be a regular file");
        start();
        return;
      }
      await sleep(triggerPollMs, undefined, { signal });
    }
  } catch (error) {
    if (signal?.aborted && error.name === "AbortError") return;
    throw error;
  }
  if (!signal?.aborted) throw new Error("recovery trigger deadline exceeded");
}

// This separate entry point is opt-in.
export function dependencyRecoveryServer(marketplace, {
  now = () => performance.now(), wait = (ms, signal) => sleep(ms, undefined, { signal }),
} = {}) {
  const server = marketplaceServer(marketplace);
  const [qualification] = server.listeners("request");
  // Prebuild the capture listener's payloads and control state before serving any requests.
  const [capture] = marketplaceServer(marketplace).listeners("request");
  server.removeListener("request", qualification);
  let startedAt;
  const elapsed = () => startedAt === undefined ? null : Math.floor(now() - startedAt);
  const phase = ms => ms === null ? "normal" : ms < windowMs ? "slow" : "restored";
  const reads = { normal: 0, slow: 0, restored: 0 };
  const responses200 = { ...reads };
  const snapshot = () => {
    const elapsedSinceStartMs = elapsed();
    return { phase: phase(elapsedSinceStartMs), elapsedSinceStartMs, delayMs, windowMs, reads: { ...reads }, responses200: { ...responses200 } };
  };
  const start = () => {
    if (startedAt !== undefined) return false;
    startedAt = now();
    return true;
  };
  server.on("request", async (req, res) => {
    const path = new URL(req.url, "http://marketplace").pathname;
    // A request keeps the controller it entered, even if it finishes across a boundary.
    const ordinary = startedAt === undefined ? qualification : capture;
    if (path === statusPath || path === "/__marketplace/control" && startedAt !== undefined && req.method !== "GET") {
      const allowed = req.method === "GET";
      res.writeHead(allowed ? 200 : 405, { "Content-Type": "application/json", "Cache-Control": "no-store",
        ...(allowed ? {} : { Allow: "GET" }) });
      return res.end(allowed ? JSON.stringify(snapshot()) : "{}");
    }
    if (req.method !== "GET" || !/^\/marketplace\/records\/item_[1-9]\d*$/.test(path)) {
      return ordinary.call(server, req, res);
    }
    const at = phase(elapsed());
    reads[at]++;
    res.once("finish", () => { if (res.statusCode === 200) responses200[at]++; });
    if (at === "slow") {
      const stop = new AbortController();
      const closed = () => stop.abort();
      res.once("close", closed);
      try { await wait(delayMs, stop.signal); }
      catch (error) { if (!stop.signal.aborted) res.destroy(error); return; }
      finally { res.off("close", closed); }
    }
    if (!res.destroyed) return ordinary.call(server, req, res);
  });
  return Object.freeze({ server, start, snapshot });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const marketplace = JSON.parse(readFileSync(process.env.MARKETPLACE_FIXTURE_PATH ?? "/fixtures/marketplace.json", "utf8"));
  const { server, start } = dependencyRecoveryServer(marketplace);
  const trigger = new AbortController();
  server.listen(Number(process.env.PORT ?? 8080), "0.0.0.0");
  const stop = () => { trigger.abort(); server.close(); server.closeAllConnections(); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  if (process.env.RECOVERY_TRIGGER_DIR !== undefined) {
    watchRecoveryTrigger(process.env.RECOVERY_TRIGGER_DIR, start, { signal: trigger.signal }).catch(() => {
      console.error("dependency recovery trigger failed");
      process.exitCode = 1;
      stop();
    });
  }
}
