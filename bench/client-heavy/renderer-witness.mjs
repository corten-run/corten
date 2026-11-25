// Untimed control, included in the hosted dependency smoke. It does not run the observer.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";

const rendererArg = "--type=renderer";
function cmdlineShape(text) {
  const tokens = text.split("\0");
  // Mirror the observer's first recognized exact NUL-separated token, not a substring match.
  const role = tokens.find((token) => /^--type=(renderer|utility|zygote|gpu-process)$/.test(token));
  return { role: role?.slice("--type=".length) ?? null,
    renderer: tokens.includes(rendererArg) ? "exact" : text.includes(rendererArg) ? "embedded" : "absent",
    layout: !text ? "empty" : text.endsWith("\0") ? "nul-terminated" : text.includes("\0") ? "nul-separated" : "no-nul" };
}

test("renderer witness reports token shape without reflecting argv", () => {
  const canary = "private-argument-canary";
  for (const [text, shape] of [
    [`${canary}\0--renderer-process-limit=1\0`, { role: null, renderer: "absent", layout: "nul-terminated" }],
    [`${canary} ${rendererArg}`, { role: null, renderer: "embedded", layout: "no-nul" }],
    [`${canary} ${rendererArg}\0`, { role: null, renderer: "embedded", layout: "nul-terminated" }],
    [`${canary}\0${rendererArg}-extra\0`, { role: null, renderer: "embedded", layout: "nul-terminated" }],
    [`${canary}\0${rendererArg}\0`, { role: "renderer", renderer: "exact", layout: "nul-terminated" }],
    [`${canary}\0--type=zygote\0${rendererArg}`, { role: "zygote", renderer: "exact", layout: "nul-separated" }],
    ["", { role: null, renderer: "absent", layout: "empty" }],
  ]) assert.deepEqual(cmdlineShape(text), shape);
});

function kernelRead(read) {
  try { return { status: "ok", value: read() }; }
  catch (error) {
    const code = error?.code;
    return { status: code === "ENOENT" || code === "ESRCH" ? "missing" : code === "EACCES" || code === "EPERM" ? "denied" : "unreadable" };
  }
}

function readWitnessFile(path) {
  const result = kernelRead(() => {
    const fd = fs.openSync(path, "r"), bytes = Buffer.alloc(32 * 1024 + 1);
    try {
      let used = 0;
      while (used < bytes.length) {
        const got = fs.readSync(fd, bytes, used, bytes.length - used, null);
        if (!got) break;
        used += got;
      }
      return used === bytes.length ? null : bytes.toString("utf8", 0, used);
    } finally { fs.closeSync(fd); }
  });
  return result.value === null ? { status: "capped" } : result;
}

function inspectChromiumProcess(processIdentity, processRole, pid, parentImage, ownCgroup, members) {
  const at = `/proc/${pid}`, first = readWitnessFile(`${at}/stat`);
  if (first.status !== "ok") return { process: first.status };
  const exe = kernelRead(() => fs.statSync(`${at}/exe`, { bigint: true }));
  const cgroup = readWitnessFile(`${at}/cgroup`), cmdline = readWitnessFile(`${at}/cmdline`);
  const last = readWitnessFile(`${at}/stat`);
  if (last.status !== "ok") return { process: "recheck-" + last.status };
  const stable = kernelRead(() => {
    const a = processIdentity(first.value), b = processIdentity(last.value);
    return a.pid === pid && b.pid === pid && a.startTicks === b.startTicks;
  });
  if (stable.value !== true) return { process: "unstable" };
  const productionRole = cmdline.status === "ok"
    ? kernelRead(() => processRole(cmdline.value, () => fs.readlinkSync(`${at}/exe`))) : { status: cmdline.status };
  return { process: "stable", executable: exe.status,
    sameBrowserImage: exe.value && parentImage ? exe.value.dev === parentImage.dev && exe.value.ino === parentImage.ino : null,
    cgroup: cgroup.status, sameCgroup: cgroup.status === "ok" && ownCgroup !== undefined ? cgroup.value === ownCgroup : null,
    listed: members ? members.has(String(pid)) : null,
    cmdline: cmdline.status === "ok" ? cmdlineShape(cmdline.value) : { status: cmdline.status },
    productionRole: productionRole.status !== "ok" ? "unreadable" : productionRole.value === "--type=renderer" ? "renderer" : "not-renderer" };
}

async function within(operation, milliseconds) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Chromium witness operation deadline")), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

function shutdownBrowser(server, milliseconds = 4000) {
  const child = server.process();
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  const releaseChild = () => {
    for (const pipe of child.stdio ?? []) pipe?.destroy();
    child.unref();
  };
  async function confirmExit(operation) {
    let onExit;
    const exit = exited() ? Promise.resolve() : new Promise((resolve) => {
      onExit = resolve;
      child.once("exit", onExit);
    });
    try {
      await within(async () => { await operation(); await exit; }, milliseconds);
    } finally {
      if (onExit) child.removeListener("exit", onExit);
    }
  }
  let finishing;
  return () => finishing ??= (async () => {
    if (exited()) {
      releaseChild();
      throw new Error("Chromium witness browser exited before shutdown");
    }
    try { await confirmExit(() => server.close()); }
    catch {
      try {
        await confirmExit(async () => {
          // Playwright waits for pipe closure, which can lag exit. Check
          // outside libuv's reap/callback batch, then signal synchronously.
          await nextTurn();
          if (exited()) releaseChild();
          else await server.kill();
        });
      }
      catch {
        // Playwright normally kills the owned browser group; if its cleanup
        // does not settle, use only the original child handle, never a PID.
        try {
          if (!exited()) await confirmExit(() => child.kill("SIGKILL"));
        } finally { releaseChild(); }
      }
      throw new Error("Chromium witness required forced browser shutdown");
    }
  })();
}

test("renderer witness kills its owned browser once if graceful shutdown stalls", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let closes = 0, kills = 0;
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
  const close = shutdownBrowser({
    process: () => child,
    close() { closes++; return new Promise(() => {}); },
    async kill() { kills++; child.signalCode = "SIGKILL"; child.emit("exit"); },
  }, 25);
  const attempt = close();
  const failed = assert.rejects(attempt, { message: "Chromium witness required forced browser shutdown" });
  assert.equal(close(), attempt);
  await Promise.resolve();
  assert.equal(closes, 1);
  t.mock.timers.tick(25);
  await failed;
  assert.equal(kills, 1);
});

test("renderer witness kills the original handle and releases owned pipes if Playwright never settles", async () => {
  let kills = 0, stopped = 0, released = 0;
  const child = Object.assign(new EventEmitter(), {
    exitCode: null, signalCode: null,
    stdio: [null, { destroy() { stopped++; } }],
    unref() { released++; },
    kill(signal) { kills++; this.signalCode = signal; this.emit("exit"); return true; },
  });
  const stall = () => new Promise(() => {});
  const close = shutdownBrowser({ process: () => child, close: stall, kill: stall }, 20);
  await assert.rejects(close(), { message: "Chromium witness required forced browser shutdown" });
  assert.equal(child.signalCode, "SIGKILL");
  assert.deepEqual([kills, stopped, released, child.listenerCount("exit")], [1, 1, 1, 0]);
});

test("renderer witness releases a held pipe and never signals an exited leader", async () => {
  let calls = 0, stopped = 0, released = 0;
  const child = Object.assign(new EventEmitter(), {
    exitCode: null, signalCode: null,
    stdio: [null, { destroy() { stopped++; } }],
    unref() { released++; },
    kill() { calls++; },
  });
  const close = shutdownBrowser({
    process: () => child,
    close() { child.exitCode = 0; child.emit("exit"); return new Promise(() => {}); },
    async kill() { calls++; },
  }, 20);
  await assert.rejects(close(), { message: "Chromium witness required forced browser shutdown" });
  assert.deepEqual([calls, stopped, released, child.listenerCount("exit")], [0, 1, 1, 0]);
});

test("Linux Chromium renderer witness with one visible page", { skip: process.platform !== "linux", timeout: 45000 }, async (t) => {
  let stop, stage = "launch", report, failed = false, closeFailed = false;
  try {
    const { chromium } = await import("playwright");
    const { launchBrowser } = await import("./launch.mjs");
    const { processIdentity, processRole } = await import("../workloads/isolated/host-lifetime.mjs");
    const launched = await launchBrowser({
      async launchServer(options) {
        const server = await chromium.launchServer({ ...options, timeout: 8000 });
        stop = shutdownBrowser(server);
        return { wsEndpoint: () => server.wsEndpoint(), process: () => server.process(), close: stop };
      },
      connect: (endpoint) => chromium.connect(endpoint, { timeout: 5000 }),
    });
    stage = "visible page";
    await within(async () => {
      const context = await launched.browser.newContext({ viewport: { width: 1100, height: 800 }, serviceWorkers: "block" });
      const page = await context.newPage();
      await page.setContent("<main>Renderer witness</main>", { timeout: 5000 });
      assert.ok(await page.evaluate(() => document.visibilityState === "visible" && document.querySelector("main").checkVisibility()));
    }, 8000);

    stage = "process inventory";
    // Chromium identifies renderer candidates independently of procfs or the role parser.
    const { processInfo } = await within(async () => {
      const cdp = await launched.browser.newBrowserCDPSession();
      return cdp.send("SystemInfo.getProcessInfo");
    }, 8000);
    const pid = launched.process.pid, validPid = (id) => Number.isSafeInteger(id) && id > 0;
    assert.ok(validPid(pid) && Array.isArray(processInfo) && processInfo.length <= 64);
    const renderers = processInfo.filter(({ type }) => type === "renderer").map(({ id }) => id);
    assert.ok(renderers.every(validPid));

    stage = "kernel witness";
    const group = readWitnessFile("/proc/self/cgroup");
    const path = /^0::(\/[^\n]*)\n?$/.exec(group.value ?? "")?.[1];
    const census = path && path.split("/").every((part) => part !== ".." && part !== ".")
      ? readWitnessFile(join("/sys/fs/cgroup", path, "cgroup.procs")) : { status: "no-v2-view" };
    const ids = census.value === undefined ? null : new Set(census.value.trim().split("\n"));
    // Only interpret absence if this mount's census can see the test and its known browser.
    const members = ids?.has(String(process.pid)) && ids.has(String(pid)) ? ids : null;
    const image = kernelRead(() => fs.statSync(`/proc/${pid}/exe`, { bigint: true })).value;
    const inspect = (id) => inspectChromiumProcess(processIdentity, processRole, id, image, group.value, members);
    report = { parentMatchesInventory: processInfo.some(({ type, id }) => type === "browser" && id === pid),
      census: ids && !members ? "different-view" : census.status,
      parent: inspect(pid), renderers: [...new Set(renderers)].filter((id) => id !== pid).map(inspect) };
    t.diagnostic(JSON.stringify(report));
  } catch {
    // Playwright and filesystem errors can contain raw args and executable paths.
    failed = true;
  } finally {
    // Closing the owned server also closes its contexts; never wait on a
    // context request before closing the process that serves that request.
    try { await stop?.(); } catch { closeFailed = true; }
  }
  if (closeFailed) t.diagnostic("Chromium renderer witness cleanup failed");
  assert.ok(!failed, `Chromium renderer witness failed at ${stage}`);
  assert.ok(!closeFailed, "Chromium renderer witness could not close its browser");
  const { parent, renderers } = report;
  assert.ok(report.parentMatchesInventory && parent.process === "stable" && parent.sameBrowserImage && parent.sameCgroup
    && parent.productionRole === "not-renderer", "browser parent negative control failed");
  assert.ok(renderers.some((p) => p.process === "stable" && p.sameBrowserImage && p.sameCgroup && p.listed !== false
    && p.cmdline.renderer === "embedded" && p.cmdline.role === null && p.productionRole === "renderer"),
  "no live Chromium renderer exercised the rewritten-title path in the observed scope");
});
