// Execute the actual driver with injected Docker results, not a cleanup-helper copy.
// node --experimental-vm-modules --test bench/fullstack/apps/django/qualify-production.test.mjs
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import vm from "node:vm";

const driver = new URL("./qualify-production.mjs", import.meta.url);
const sourceRoot = new URL("../../../../", import.meta.url);
const checkerPath = "bench/marketplace/check.mjs";
let sequence = 0;
async function exercise(options) {
  const repo = mkdtempSync(join(tmpdir(), "corten-django-driver-"));
  try { return await run(repo, options); }
  finally { rmSync(repo, { recursive: true, force: true }); }
}

async function run(repo, { failRun = 1, failRemove = false, failNetwork = false, foreign = false, failCreate = false,
  installedVersion = "1.64.1", lockedVersion = installedVersion, missing, missingEntry, stale, shadow } = {}) {
  const output = join(repo, "results");
  const driverPath = join(repo, "bench/fullstack/apps/django/qualify-production.mjs");
  const packages = {
    "@playwright/test": { exports: { ".": "./index.mjs" }, entry: "index.mjs", source: 'export * from "playwright/test";' },
    playwright: { exports: { "./test": "./test.mjs" }, entry: "test.mjs",
      source: 'import "./index.js"; export const chromium = { launch() { throw new Error("preflight must not launch Chromium"); } };' },
    "playwright-core": { exports: { ".": "./index.js" }, entry: "index.js", source: "" },
  };
  const install = (root, name, version) => {
    const { exports, entry, source } = packages[name];
    const path = join(root, "node_modules", name);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "package.json"), JSON.stringify({ name, version, exports: { ...exports, "./package.json": "./package.json" } }));
    if (name !== missingEntry) writeFileSync(join(path, entry), source);
    if (name === "playwright") writeFileSync(join(path, "index.js"), 'module.exports = require("playwright-core");');
  };
  writeFileSync(join(repo, "package-lock.json"), JSON.stringify({ packages: Object.fromEntries(
    Object.keys(packages).map((name) => [`node_modules/${name}`, { version: lockedVersion }])) }));
  for (const name of Object.keys(packages)) {
    if (name !== missing) install(repo, name, name === stale ? "1.65.1" : installedVersion);
  }
  if (shadow) install(join(repo, "node_modules/@playwright/test"), "playwright", "1.65.1");
  const calls = [], qualificationCalls = [], logs = [], containers = new Map(), networks = new Map();
  let runs = 0;
  const reply = (stdout = "", status = 0, stderr = "") => ({ stdout, stderr, status });
  const labelsOf = (args) => Object.fromEntries(args.flatMap((arg, i) => arg === "--label" ? [args[i + 1].split("=")] : []));
  const spawnSync = (_binary, args) => {
    calls.push(args);
    if (args[0] === "network" && args[1] === "create") {
      const name = args.at(-1); networks.set(name, { Id: "network-id", Name: name, Labels: labelsOf(args) });
      return failCreate ? reply("", 1, "injected network create failure") : reply("network-id");
    }
    if (args[0] === "run") {
      const name = args[args.indexOf("--name") + 1];
      containers.set(name, { Id: `container-${runs}`, Name: `/${name}`, Config: { Labels: foreign ? { "agent.owner": "someone-else" } : labelsOf(args) },
        Args: [], HostConfig: {},
        NetworkSettings: { Ports: { "8080/tcp": [{ HostPort: "12345" }] } } });
      return ++runs === failRun ? reply("", 125, "injected start failure") : reply(name);
    }
    if (args[0] === "inspect") return reply(JSON.stringify([containers.get(args.at(-1)) ?? [...containers.values()].find((c) => c.Id === args.at(-1)) ?? networks.get(args.at(-1)) ?? [...networks.values()].find((n) => n.Id === args.at(-1))]));
    if (args[0] === "container" && args[1] === "ls") return reply([...containers.values()].map((c) => c.Id).join("\n"));
    if (args[0] === "network" && args[1] === "ls") return reply([...networks.values()].map((n) => n.Id).join("\n"));
    if (args[0] === "rm") {
      if (failRemove) return reply("", 1, "injected container cleanup failure");
      for (const [name, c] of containers) if ([name, c.Id].includes(args.at(-1))) containers.delete(name);
      return reply();
    }
    if (args[0] === "network" && args[1] === "rm") {
      if (failNetwork || containers.size) return reply("", 1, "injected network cleanup failure");
      networks.clear(); return reply();
    }
    if (["logs", "top", "exec"].includes(args[0])) return reply();
    throw new Error(`unexpected docker command: ${args.join(" ")}`);
  };
  const context = vm.createContext({ process: { argv: [process.execPath, fileURLToPath(driver), output], pid: process.pid + ++sequence },
    console: { log: value => logs.push(value), error() {} }, fetch: async () => ({ status: 200, arrayBuffer: async () => new ArrayBuffer(0) }), AbortSignal, setTimeout, URL });
  const url = pathToFileURL(driverPath).href;
  const module = new vm.SourceTextModule(readFileSync(driver, "utf8"), { context, identifier: url, initializeImportMeta(meta) { meta.url = url; } });
  await module.link(async (specifier) => {
    // Load the real checker in the fixture so Node resolves its Playwright imports there.
    if (specifier === "../../../marketplace/check.mjs") {
      for (const file of [checkerPath, "bench/marketplace/contract.mjs", "bench/marketplace/records.mjs",
        "bench/marketplace/labels.json", "bench/marketplace/reference.mjs", "bench/catalog/check.mjs",
        "bench/catalog/contract.mjs", "bench/catalog/group.mjs", "bench/catalog/record-attempt.mjs",
        "bench/fullstack/inventory.mjs", "bench/fullstack/passes.mjs", "bench/workloads/registry.mjs", "scripts/steady.mjs"]) {
        const target = join(repo, file);
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(new URL(file, sourceRoot), target);
      }
    }
    const exports = specifier === "node:child_process" ? { spawnSync } :
      specifier === "../../../marketplace/check.mjs" ? await import(pathToFileURL(join(repo, checkerPath))) :
      specifier === "../../../marketplace/qualify.mjs" ? { qualify: async options => {
        qualificationCalls.push({ ...options });
        return { profile: "marketplace-production/v2", source: options.source, eligible: true, missing: [], unmeasured: ["unfinishedHead", "connectionCap"] };
      } } : await import(specifier);
    return new vm.SyntheticModule(Object.keys(exports), function () { for (const [key, value] of Object.entries(exports)) this.setExport(key, value); }, { context });
  });
  let error;
  try { await module.evaluate(); } catch (caught) { error = caught; }
  return { error, calls, containers, networks, madeOutput: existsSync(output), qualificationCalls, logs,
    qualifications: ["fixture", "api"].map(source => {
      const file = join(output, `${source}-bounded-qualification.json`);
      return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
    }),
    receipt: (() => { try { return JSON.parse(readFileSync(join(output, "run-failures.json"))); } catch { return null; } })() };
}

test("create-success/start-failure removes the attempted owned container", async () => {
  const r = await exercise();
  assert.match(String(r.error), /injected start failure/);
  assert.equal(r.containers.size, 0, "the actual driver leaked its created container");
  assert.equal(r.networks.size, 0);
  assert.ok(r.calls.some((c) => c[0] === "rm"));
});

test("network cleanup failure preserves the primary start failure", async () => {
  const r = await exercise({ failNetwork: true });
  assert.match(String(r.error), /injected start failure/);
  assert.match(JSON.stringify(r.receipt), /injected network cleanup failure/);
});

test("failed removal does not skip other containers or the network", async () => {
  const r = await exercise({ failRun: 2, failRemove: true });
  assert.ok(r.calls.filter((c) => c[0] === "rm").length >= 2);
  assert.ok(r.calls.some((c) => c[0] === "network" && c[1] === "rm"));
  assert.match(JSON.stringify(r.receipt), /injected start failure/);
  assert.match(JSON.stringify(r.receipt), /injected container cleanup failure/);
});

test("ambiguous names never authorize deleting a foreign resource", async () => {
  const r = await exercise({ foreign: true });
  assert.equal(r.containers.size, 1);
  assert.ok(!r.calls.some((c) => c[0] === "rm"));
  assert.match(JSON.stringify(r.receipt), /ownership/);
});

test("application start failure also removes the already running upstream", async () => {
  const r = await exercise({ failRun: 2 });
  assert.match(String(r.error), /injected start failure/);
  assert.equal(r.containers.size, 0);
  assert.equal(r.networks.size, 0);
  assert.equal(r.calls.filter((c) => c[0] === "rm").length, 2);
});

test("network creation failure still cleans an owned network created before the error", async () => {
  const r = await exercise({ failCreate: true });
  assert.match(String(r.error), /injected network create failure/);
  assert.equal(r.networks.size, 0);
  assert.equal(r.containers.size, 0);
});

test("resource names leave room for fixture/api/browser DNS labels", async () => {
  const r = await exercise();
  const name = r.calls.find((c) => c[0] === "network" && c[1] === "create").at(-1);
  assert.ok(`${name}-fixture-browser`.length <= 63, "Docker names must also be usable DNS labels");
});

for (const version of ["1.64.1", "1.65.1"]) test(`both browser runs select the root Playwright ${version} image`, async () => {
  const r = await exercise({ failRun: 0, installedVersion: version });
  assert.equal(r.error, undefined);
  const browserRuns = r.calls.filter((c) => c[0] === "run" && c.includes("bench/marketplace/check.mjs"));
  assert.deepEqual(browserRuns.map((args) => args[args.indexOf("bench/marketplace/check.mjs") - 2]),
    Array(2).fill(`mcr.microsoft.com/playwright:v${version}-noble`));
  assert.equal(r.containers.size, 0);
  assert.equal(r.networks.size, 0);
});

test("a stale Playwright install is rejected before starting Docker", async () => {
  const r = await exercise({ installedVersion: "1.64.1", lockedVersion: "1.65.1" });
  assert.match(String(r.error), /installed @playwright\/test does not match the root lockfile/);
  assert.deepEqual(r.calls, []);
  assert.equal(r.madeOutput, false);
});

test("both source modes retain the bounded receipts and report connection-flood resistance as unmeasured", async () => {
  const r = await exercise({ failRun: 0 });
  assert.equal(r.error, undefined);
  const address = "http://127.0.0.1:12345";
  assert.deepEqual(r.qualificationCalls, ["fixture", "api"].map(source => ({ source, base: address, upstream: address })));
  assert.deepEqual(r.qualifications, ["fixture", "api"].map(source =>
    ({ profile: "marketplace-production/v2", source, eligible: true, missing: [], unmeasured: ["unfinishedHead", "connectionCap"] })));
  assert.equal(r.logs.filter(value => value === "Connection-flood resistance: not measured.").length, 2);
});

for (const [options, name] of [
  [{ missing: "playwright" }, "playwright"],
  [{ missing: "playwright-core" }, "playwright-core"],
  [{ stale: "playwright" }, "playwright"],
  [{ stale: "playwright-core" }, "playwright-core"],
  [{ shadow: true }, "playwright"],
]) test(`an incomplete or mixed Playwright install is rejected before output or Docker: ${JSON.stringify(options)}`, async () => {
  const r = await exercise({ failRun: 0, ...options });
  assert.equal(r.calls.length, 0, "preflight reached Docker");
  assert.equal(r.madeOutput, false, "preflight created the output directory");
  assert.match(String(r.error), new RegExp(`\\b${name}\\b`));
});

for (const [name, entry] of [["@playwright/test", "index.mjs"], ["playwright", "test.mjs"]]) {
  test(`missing ESM entry ${name}/${entry} is rejected before output or Docker`, async () => {
    const r = await exercise({ failRun: 0, missingEntry: name });
    assert.equal(r.calls.length, 0, "preflight reached Docker");
    assert.equal(r.madeOutput, false, "preflight created the output directory");
    assert.equal(r.error?.code, "ERR_MODULE_NOT_FOUND");
    assert.ok(r.error.message.replaceAll("\\", "/").includes(`${name}/${entry}`), r.error.message);
  });
}
