// Untimed control, included in the hosted dependency smoke. It does not run the observer.
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import test from "node:test";

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

test("renderer witness stops issuing commands when an in-flight command outlives its deadline", { timeout: 10000 }, async (t) => {
  const commands = ["newContext", "newPage", "setContent", "evaluate", "newBrowserCDPSession", "send"];
  for (const [index, delayed] of commands.entries()) await t.test(delayed, async (step) => {
    step.mock.timers.enable({ apis: ["setTimeout"] });
    const entered = Promise.withResolvers(), release = Promise.withResolvers(), calls = [];
    const command = (name, result) => async () => {
      calls.push(name);
      if (name === delayed) { entered.resolve(); await release.promise; }
      return result;
    };
    const page = { setContent: command("setContent"), evaluate: command("evaluate", true) };
    const browser = { newContext: command("newContext", { newPage: command("newPage", page) }),
      newBrowserCDPSession: command("newBrowserCDPSession", { send: command("send") }) };
    const rejected = assert.rejects(verifyLiveRenderer({ browser }, assert.fail, 16000),
      index < 4 ? /failed at visible page/ : /failed at process inventory/);
    await entered.promise;
    step.mock.timers.tick(16000);
    await rejected;
    release.resolve();
    await new Promise(setImmediate);
    assert.deepEqual(calls, commands.slice(0, index + 1));
  });
});

test("renderer witness rejects PID reuse during the rewritten-title executable read", async (t) => {
  const { processIdentity, processRole } = await import("../workloads/isolated/host-lifetime.mjs");
  const pid = 123, at = `/proc/${pid}`, exe = "/chromium/chrome";
  let start = 100, current;
  t.mock.method(fs, "openSync", (path) => {
    current = Buffer.from({ [`${at}/stat`]: `${pid} (chrome) S ${"0 ".repeat(18)}${start}`,
      [`${at}/cmdline`]: `${exe} --type=renderer --other\0`, [`${at}/cgroup`]: "0::/\n" }[path]);
    return 0;
  });
  t.mock.method(fs, "readSync", (_fd, bytes, offset) => offset ? 0 : current.copy(bytes));
  t.mock.method(fs, "closeSync", () => {});
  const image = { dev: 1n, ino: 2n };
  t.mock.method(fs, "statSync", () => image);
  const link = t.mock.method(fs, "readlinkSync", () => exe);
  const inspect = () => inspectChromiumProcess(processIdentity, processRole, pid, image, "0::/\n", null);
  assert.equal(inspect().productionRole, "renderer");
  link.mock.mockImplementation(() => { start++; return exe; });
  assert.deepEqual(inspect(), { process: "unstable" });
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
  const productionRole = cmdline.status === "ok"
    ? kernelRead(() => processRole(cmdline.value, () => fs.readlinkSync(`${at}/exe`))) : { status: cmdline.status };
  const last = readWitnessFile(`${at}/stat`);
  if (last.status !== "ok") return { process: "recheck-" + last.status };
  const stable = kernelRead(() => {
    const a = processIdentity(first.value), b = processIdentity(last.value);
    return a.pid === pid && b.pid === pid && a.startTicks === b.startTicks;
  });
  if (stable.value !== true) return { process: "unstable" };
  return { process: "stable", executable: exe.status,
    sameBrowserImage: exe.value && parentImage ? exe.value.dev === parentImage.dev && exe.value.ino === parentImage.ino : null,
    cgroup: cgroup.status, sameCgroup: cgroup.status === "ok" && ownCgroup !== undefined ? cgroup.value === ownCgroup : null,
    listed: members ? members.has(String(pid)) : null,
    cmdline: cmdline.status === "ok" ? cmdlineShape(cmdline.value) : { status: cmdline.status },
    productionRole: productionRole.status !== "ok" ? "unreadable" : productionRole.value === "--type=renderer" ? "renderer" : "not-renderer" };
}

async function within(operation, milliseconds) {
  const deadline = performance.now() + milliseconds, error = new Error("Chromium witness operation deadline");
  let timer, expired = false;
  // Racing the timer does not cancel a pending Playwright command. Fence each continuation.
  const checkDeadline = () => { if (expired || performance.now() >= deadline) throw error; };
  try {
    return await Promise.race([Promise.resolve().then(() => operation(checkDeadline)), new Promise((_, reject) => {
      timer = setTimeout(() => { expired = true; reject(error); }, milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

// The existing compatibility smoke owns the browser and its teardown. This
// probe only opens a page after that smoke's application checks have finished.
export async function verifyLiveRenderer(launched, diagnostic, milliseconds) {
  let stage = "visible page", report;
  try {
    report = await within(async (checkDeadline) => {
      const { processIdentity, processRole } = await import("../workloads/isolated/host-lifetime.mjs");
      checkDeadline();
      const context = await launched.browser.newContext({ viewport: { width: 1100, height: 800 }, serviceWorkers: "block" });
      checkDeadline();
      const page = await context.newPage();
      checkDeadline();
      await page.setContent("<main>Renderer witness</main>", { timeout: 5000 });
      checkDeadline();
      assert.ok(await page.evaluate(() => document.visibilityState === "visible" && document.querySelector("main").checkVisibility()));
      checkDeadline();

      stage = "process inventory";
      // Chromium identifies renderer candidates independently of procfs or the role parser.
      const cdp = await launched.browser.newBrowserCDPSession();
      checkDeadline();
      const { processInfo } = await cdp.send("SystemInfo.getProcessInfo");
      checkDeadline();
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
      const observed = { parentMatchesInventory: processInfo.some(({ type, id }) => type === "browser" && id === pid),
        census: ids && !members ? "different-view" : census.status,
        parent: inspect(pid), renderers: [...new Set(renderers)].filter((id) => id !== pid).map(inspect) };
      checkDeadline();
      return observed;
    }, milliseconds);
    diagnostic(JSON.stringify(report));
  } catch {
    // Playwright and filesystem errors can contain raw args and executable paths.
    throw new Error(`Chromium renderer witness failed at ${stage}`);
  }
  const { parent, renderers } = report;
  assert.ok(report.parentMatchesInventory && parent.process === "stable" && parent.sameBrowserImage && parent.sameCgroup
    && parent.productionRole === "not-renderer", "browser parent negative control failed");
  assert.ok(renderers.some((p) => p.process === "stable" && p.sameBrowserImage && p.sameCgroup && p.listed !== false
    && p.cmdline.renderer === "embedded" && p.cmdline.role === null && p.productionRole === "renderer"),
  "no live Chromium renderer exercised the rewritten-title path in the observed scope");
}
