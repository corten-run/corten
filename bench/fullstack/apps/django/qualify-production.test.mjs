// Execute the actual driver with injected Docker results, not a cleanup-helper copy.
// node --experimental-vm-modules --test bench/fullstack/apps/django/qualify-production.test.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";

const driver = new URL("./qualify-production.mjs", import.meta.url);
const work = new URL("./work/", import.meta.url);
let sequence = 0;
async function exercise({ failRun = 1, failRemove = false, failNetwork = false, foreign = false, failCreate = false } = {}) {
  mkdirSync(work, { recursive: true });
  const output = mkdtempSync(join(fileURLToPath(work), "driver-test-"));
  const calls = [], containers = new Map(), networks = new Map();
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
    console: { log() {}, error() {} }, fetch: async () => ({ status: 200, arrayBuffer: async () => new ArrayBuffer(0) }), AbortSignal, setTimeout, URL });
  const module = new vm.SourceTextModule(readFileSync(driver, "utf8"), { context, identifier: driver.href, initializeImportMeta(meta) { meta.url = driver.href; } });
  await module.link(async (specifier) => {
    const exports = specifier === "node:child_process" ? { spawnSync } : specifier.endsWith("/qualify.mjs") ? { qualify: async () => { throw new Error("unexpected qualification"); } } : await import(specifier);
    return new vm.SyntheticModule(Object.keys(exports), function () { for (const [key, value] of Object.entries(exports)) this.setExport(key, value); }, { context });
  });
  let error;
  try { await module.evaluate(); } catch (caught) { error = caught; }
  try { return { error, calls, containers, networks, receipt: (() => { try { return JSON.parse(readFileSync(join(output, "run-failures.json"))); } catch { return null; } })() }; }
  finally { rmSync(output, { recursive: true, force: true }); }
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
