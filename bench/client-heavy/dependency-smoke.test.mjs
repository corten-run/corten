// Compatibility only: use the production JS builds and oracle, not a timed run.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import test from "node:test";
import { buildApps, root, solidBuildPlugin } from "./build.mjs";
import { options, buildOptions } from "./contract.mjs";
import { solidCompiler, solidRuntimeFiles } from "./compiler.mjs";
import { Evidence, sha256 } from "./evidence.mjs";
import { launchBrowser } from "./launch.mjs";
import { journey, serve } from "./run.mjs";

const require = createRequire(join(root, "bench/browser/package.json"));

test("official Solid 2 compiler bundles the real adapter from the shared browser install", { timeout: 10000 }, async () => {
  const { build } = require("esbuild"), options = buildOptions("solid", root);
  const { plugin, receipt } = solidBuildPlugin(options.entryPoints[0]);
  assert.equal(receipt.version, "2.0.2");
  const { metafile, outputFiles } = await build({ ...options, plugins: [plugin] });
  for (const [path, sha] of Object.entries(solidRuntimeFiles)) {
    const input = `bench/browser/node_modules/${path}`;
    assert.ok(metafile.inputs[input]);
    assert.equal(sha256(await readFile(join(root, input))), sha);
  }
  assert.ok(Object.keys(metafile.inputs).every((path) => !path.includes("solid-js-legacy")));
  assert.match(outputFiles[0].text, /clientMount/);
  assert.match(outputFiles[0].text, /clientDetach/);
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

test("the locked JavaScript builds still pass the client-heavy browser oracle", { timeout: 120000 }, async () => {
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
    } finally {
      try { await launched?.close(); } finally { await server.close(); }
    }
  } finally {
    const path = relative(tmpdir(), out);
    assert.ok(path && !isAbsolute(path) && !path.startsWith(".."));
    await rm(out, { recursive: true, force: true });
  }
});
