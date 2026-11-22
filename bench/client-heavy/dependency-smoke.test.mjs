// Compatibility only: use the production JS builds and oracle, not a timed run.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { buildApps, root } from "./build.mjs";
import { options } from "./contract.mjs";
import { Evidence } from "./evidence.mjs";
import { launchBrowser } from "./launch.mjs";
import { journey, serve } from "./run.mjs";
import { unsupportedSolidReason } from "../workloads/latest-stable.mjs";

const require = createRequire(join(root, "bench/browser/package.json"));

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
    assert.deepEqual(builds.solid, { outcome: "not-run", reason: unsupportedSolidReason });
    const server = await serve(directory);
    let launched;
    try {
      launched = await launchBrowser(chromium);
      for (const app of ["react", "remix", "svelte", "vue"]) {
        if (builds[app].outcome !== "built") assert.fail(`${app}: ${await readFile(join(directory, app, "failure.log"), "utf8")}`);
        const pass = await journey(launched.browser, server.url, app, workload, settings, timeoutMs);
        assert.equal(pass.capture.outcome, "captured", `${app}: ${JSON.stringify(pass.failure)}`);
        assert.equal(pass.oracle.functionalPassed, true, app);
        assert.equal(pass.actions, null, app);
      }
    } finally {
      try { await launched?.close(); } finally { await server.close(); }
    }
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
