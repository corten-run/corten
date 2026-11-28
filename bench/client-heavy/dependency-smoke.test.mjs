// Compatibility only: use the production JS builds and oracle, not a timed run.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import test from "node:test";
import { verifyLiveRenderer } from "./renderer-witness.mjs";
import { buildApps, root, solidBuildPlugin } from "./build.mjs";
import { options, buildOptions } from "./contract.mjs";
import { solidCompiler, matchesSolidRuntime, solidRuntimeFiles, solidRuntimePrefix } from "./compiler.mjs";
import { Evidence, sha256 } from "./evidence.mjs";
import { launchBrowser } from "./launch.mjs";
import { journey, serve } from "./run.mjs";

const require = createRequire(join(root, "bench/browser/package.json"));

test("official Solid 2 compiler bundles the real adapter from the shared browser install", { timeout: 10000 }, async () => {
  const { build } = require("esbuild"), options = buildOptions("solid", root);
  const { plugin, receipt } = solidBuildPlugin(options.entryPoints[0]);
  assert.equal(receipt.version, "2.0.2");
  const { metafile, outputFiles } = await build({ ...options, plugins: [plugin] });
  const inputs = new Map(await Promise.all(Object.keys(metafile.inputs).map(async (path) =>
    [path, { sha256: sha256(await readFile(join(root, path))) }])));
  assert.ok(matchesSolidRuntime(inputs), "actual esbuild inputs must match the published runtime closure");
  const imported = "@solidjs/signals/dist/prod/core/graph.js", path = solidRuntimePrefix + imported;
  assert.equal(inputs.get(path)?.sha256, solidRuntimeFiles[imported]);
  const changed = Buffer.concat([await readFile(join(root, path)), Buffer.from("\n// changed imported bytes\n")]);
  inputs.set(path, { sha256: sha256(changed) });
  assert.equal(matchesSolidRuntime(inputs), false);
  assert.match(outputFiles[0].text, /clientMount/);
  assert.match(outputFiles[0].text, /clientDetach/);
});

test("official Solid 2 compiler rejects a Signals sideEffects-only change before the production build", (t) => {
  const manifest = join(root, "bench/browser/node_modules/@solidjs/signals/package.json");
  const originalRead = fs.readFileSync, data = JSON.parse(originalRead(manifest));
  assert.equal(data.sideEffects, false);
  const changed = Buffer.from(JSON.stringify({ ...data, sideEffects: true }));
  // Change only what the production preflight reads, not the shared npm tree.
  const read = t.mock.method(fs, "readFileSync", (path, ...rest) =>
    path === manifest ? changed : originalRead(path, ...rest));
  try {
    syncBuiltinESMExports();
    assert.throws(() => solidBuildPlugin(buildOptions("solid", root).entryPoints[0]),
      /missing or modified Solid 2 input @solidjs\/signals\/package\.json/);
  } finally {
    read.mock.restore();
    syncBuiltinESMExports();
  }
});

test("legacy Solid 1 production builder compiles SSR, hydration and handwritten entries without writing them", { timeout: 15000 }, () => {
  const output = execFileSync(process.execPath, ["bench/browser/build.mjs", "--check-legacy-solid"], {
    cwd: root, timeout: 10000, encoding: "utf8",
  });
  const inputs = JSON.parse(output), legacy = "node_modules/solid-js-legacy/";
  assert.deepEqual(Object.keys(inputs), ["server", "solid-ssr", "solid-h"]);
  for (const [name, entry, expected] of [
    ["server", "apps/solid/server.jsx", ["dist/server.js", "web/dist/server.js"]],
    ["solid-ssr", "apps/solid/hydrate.jsx", ["dist/solid.js", "web/dist/web.js"]],
    ["solid-h", "apps/solid-h/app.js", ["dist/solid.js", "h/dist/h.js", "store/dist/store.js", "web/dist/web.js"]],
  ]) {
    assert.ok(inputs[name].includes(entry), name);
    for (const path of expected) assert.ok(inputs[name].includes(legacy + path), `${name}: ${path}`);
    assert.ok(inputs[name].filter((path) => path.includes("node_modules/")).every((path) => path.startsWith(legacy)), name);
  }
});

test("official Solid 2 compiler rejects malformed JSX and does not fall back to another install", () => {
  const browserPackage = join(root, "bench/browser/package.json"), compiler = solidCompiler(browserPackage);
  assert.throws(() => compiler.transform("const broken = <div>", "Broken.jsx"));
  assert.throws(() => solidCompiler(join(root, "bench/client-heavy/package.json")), /run npm --prefix bench\/browser ci/);
  const before = process.env.SOLID_COMPILER_NATIVE;
  process.env.SOLID_COMPILER_NATIVE = "unreviewed-binding.node";
  try { assert.throws(() => solidCompiler(browserPackage), /Solid compiler overrides are not supported/); }
  finally {
    if (before === undefined) delete process.env.SOLID_COMPILER_NATIVE;
    else process.env.SOLID_COMPILER_NATIVE = before;
  }
});

test("Remix's private test tool and the benchmark's root bundler both work", () => {
  const remixTest = createRequire(require.resolve("@remix-run/test/package.json"));
  for (const [esbuild, version] of [[require("esbuild"), "0.28.2"], [remixTest("esbuild"), "0.27.2"]]) {
    assert.equal(esbuild.version, version);
    assert.match(esbuild.transformSync("let value: number = 1", { loader: "ts" }).code, /let value = 1/);
  }
});

const smokeTimeoutMs = 120000, witnessTimeoutMs = 16000, cleanupReserveMs = 10000;
function rendererWitnessBudget(deadline, now = performance.now()) {
  const remainingMs = Math.floor(deadline - now - cleanupReserveMs);
  assert.ok(remainingMs > 0, "no time remains for the renderer witness before cleanup");
  return Math.min(witnessTimeoutMs, remainingMs);
}

test("renderer witness leaves time for smoke cleanup near the deadline", () => {
  assert.equal(rendererWitnessBudget(120000, 80000), 16000);
  assert.equal(rendererWitnessBudget(120000, 109750), 250);
  assert.throws(() => rendererWitnessBudget(120000, 110000), /before cleanup/);
});

test("the locked JavaScript builds still pass the client-heavy browser oracle", { timeout: smokeTimeoutMs }, async (t) => {
  const smokeDeadline = performance.now() + smokeTimeoutMs;
  const out = await mkdtemp(join(tmpdir(), "client-dependency-smoke-"));
  try {
    const { workload, settings, timeoutMs } = options(["dependency-smoke"]);
    const directory = join(out, "native"), evidence = new Evidence(root, out);
    // Do not start the Rust build. This test is only about the npm clients.
    const cargoSkipped = new Error("dependency smoke does not build Corten");
    evidence.tool = () => { throw cargoSkipped; };
    const builds = await buildApps(workload, directory, "cargo", evidence);
    assert.equal(await readFile(join(directory, "corten", "failure.log"), "utf8"), String(cargoSkipped));
    const server = await serve(directory);
    let launched;
    try {
      const { chromium } = await import("playwright");
      launched = await launchBrowser(chromium);
      for (const app of ["react", "remix", "solid", "svelte", "vue"]) {
        if (builds[app].outcome !== "built") assert.fail(`${app}: ${await readFile(join(directory, app, "failure.log"), "utf8")}`);
        const pass = await journey(launched.browser, server.url, app, workload, settings, timeoutMs);
        assert.equal(pass.capture.outcome, "captured", `${app}: ${JSON.stringify(pass.failure)}`);
        assert.equal(pass.oracle.functionalPassed, true, app);
        assert.equal(pass.lifecycle.deadline.firedAt, null, app);
        const close = pass.lifecycle.close;
        assert.ok(close?.returned && close.observed && close.failure === null, `${app}: ${JSON.stringify(close)}`);
        assert.equal(pass.actions, null, app);
      }
      if (process.platform === "linux") {
        await verifyLiveRenderer(launched, (line) => t.diagnostic(line), rendererWitnessBudget(smokeDeadline));
      }
    } finally {
      try { await launched?.close(); } finally { await server.close(); }
    }
  } finally {
    const path = relative(tmpdir(), out);
    assert.ok(path && !isAbsolute(path) && !path.startsWith(".."));
    await rm(out, { recursive: true, force: true });
  }
});
