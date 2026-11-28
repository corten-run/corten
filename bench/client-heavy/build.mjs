import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { selectedApps } from "../workloads/registry.mjs";
import { Evidence, sha256, json, clock } from "./evidence.mjs";
import { collectCompiler, withCompilerTarget, solidCompiler, solidCompilerVersion, solidRuntimeFiles, solidRuntimePrefix, matchesSolidRuntime } from "./compiler.mjs";
import { buildOptions as fixedBuildOptions, documentMarkup } from "./contract.mjs";
export { vendorConfiguration } from "./build-replay.mjs";
import { vendorConfiguration } from "./build-replay.mjs";
import { evaluateLatestStable, latestStableSources, unsupportedSolidReason } from "../workloads/latest-stable.mjs";

export const here = dirname(fileURLToPath(import.meta.url));
export const root = resolve(here, "../..");
const browserPackage = join(root, "bench/browser/package.json");
const require = createRequire(browserPackage);
export { sha256 };
export function readLatestStable() {
  const input = Object.fromEntries(Object.entries(latestStableSources).map(([key, path]) => [key, readFileSync(join(root, path))]));
  const policy = evaluateLatestStable({ group: "client-heavy", ...input });
  if (!policy.valid || !Array.isArray(policy.candidates)) throw new Error("invalid-client-candidate-policy");
  return policy;
}
export function solidBuildPlugin(entry) {
  const compiler = solidCompiler(browserPackage);
  const plugin = { name: "solid", setup(b) {
    b.onLoad({ filter: /\.jsx$/ }, ({ path }) => {
      if (path !== entry) return;
      return { contents: compiler.transform(readFileSync(path, "utf8"), path), loader: "js" };
    });
    b.onLoad({ filter: /\.js$/, namespace: "file" }, ({ path }) => {
      const source = relative(root, path).replaceAll("\\", "/");
      if (!source.startsWith(solidRuntimePrefix)) return;
      const runtime = source.slice(solidRuntimePrefix.length);
      if (!Object.hasOwn(solidRuntimeFiles, runtime)) return;
      // Hand esbuild exactly the bytes we hash, rather than reopening them later.
      const contents = readFileSync(path);
      if (sha256(contents) !== solidRuntimeFiles[runtime])
        throw new Error(`modified Solid 2 runtime input ${runtime}; run npm --prefix bench/browser ci`);
      return { contents, loader: "js", resolveDir: dirname(path) };
    });
  } };
  return { plugin, receipt: { version: solidCompilerVersion, target: compiler.target, files: compiler.files } };
}
// Cargo resolves config-file paths from two levels above that file. This file
// lives at <out>/evidence/cargo-vendor.toml, so its base is <out>.

export async function buildApps(workload, directory, cargo = "cargo", evidence = new Evidence(root, dirname(resolve(directory))),
  apps = Object.fromEntries(selectedApps("client-heavy").map((app) => [app, { outcome: "not-run", reason: "runner-failed-before-build" }]))) {
  const out = resolve(directory);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "workload.json"), json(workload));
  writeFileSync(join(out, "build.json"), json(apps));
  const policy = readLatestStable();
  const { build } = require("esbuild");
  for (const app of selectedApps("client-heavy")) {
    const candidate = policy.candidates.find((row) => row.app === app);
    if (candidate?.status === "unsupported") {
      apps[app] = { outcome: "not-run", reason: unsupportedSolidReason };
      writeFileSync(join(out, "build.json"), json(apps));
      continue;
    }
    const dir = join(out, app);
    mkdirSync(dir, { recursive: true });
    const startedAt = clock();
    try {
      let entry = join(here, "apps", `${app}.${app === "react" || app === "solid" ? "jsx" : app === "remix" ? "tsx" : "js"}`);
      let screen = "", footer = "";
      const plugins = [];
      let solid;
      if (app === "corten") {
        const input = [relative(root, join(out, "workload.json")).replaceAll("\\", "/"), relative(root, dir).replaceAll("\\", "/")];
        let initialLock;
        try { initialLock = { state: "present", file: await evidence.file(root, "bench/browser/gen/Cargo.lock") }; }
        catch (error) {
          initialLock = { state: error.code === "ENOENT" ? "absent" : "unavailable" };
          if (initialLock.state === "unavailable") evidence.blockers.push("initial-cargo-lock-bytes-unavailable");
        }
        await evidence.save("evidence/cargo-lock-invocation.json", initialLock);
        const vendor = relative(root, join(evidence.out, "evidence/cargo-vendor")).replaceAll("\\", "/");
        const vendored = await evidence.tool(cargo, ["vendor", "--versioned-dirs", "--manifest-path", "bench/browser/gen/Cargo.toml", vendor], "cargo-vendor");
        if (vendored.receipt.status !== 0) throw new Error("native-corten-vendor-failed");
        const dependenciesBefore = await evidence.tree(join(root, vendor), "cargo-dependencies", "before");
        const lockBefore = await evidence.file(root, "bench/browser/gen/Cargo.lock");
        if (initialLock.state === "present" && initialLock.file.sha256 !== lockBefore.sha256) evidence.blockers.push("cargo-vendor-changed-existing-lockfile");
        await evidence.save("evidence/cargo-lock-before.json", lockBefore);
        const vendorConfig = join(evidence.out, "evidence/cargo-vendor.toml");
        writeFileSync(vendorConfig, vendorConfiguration);
        // A new, invocation-owned target prevents silently claiming a cache hit
        // as a fresh build. The isolated campaign retains it through host proof.
        const target = resolve(evidence.out + ".compiler");
        if (dirname(target) !== dirname(evidence.out)) throw new Error("unsafe-compiler-target");
        const targetArg = relative(root, target).replaceAll("\\", "/");
        const args = ["run", "--locked", "--offline", "--release", "--verbose", "--message-format=json", "--target-dir", targetArg,
          "--config", relative(root, vendorConfig).replaceAll("\\", "/"),
          "--manifest-path", "bench/browser/gen/Cargo.toml", "--bin", "client", "--", ...input];
        // A build launcher may wait in a machine queue. Do not kill just its shell and
        // leave the actual build orphaned. Native browser journeys have their own bound.
        const result = await withCompilerTarget(target, async () => {
          const metadata = await evidence.tool(cargo, ["metadata", "--locked", "--offline", "--format-version", "1",
            "--config", relative(root, vendorConfig).replaceAll("\\", "/"), "--manifest-path", "bench/browser/gen/Cargo.toml"], "cargo-metadata");
          const built = await evidence.tool(cargo, args, "cargo-run");
          await collectCompiler(evidence, target, metadata, built.stdout);
          return built;
        });
        writeFileSync(join(dir, "build.log"), Buffer.concat([result.stdout, result.stderr]));
        const dependenciesAfter = await evidence.tree(join(root, vendor), "cargo-dependencies", "after");
        const lockAfter = await evidence.file(root, "bench/browser/gen/Cargo.lock");
        await evidence.save("evidence/cargo-lock-after.json", lockAfter);
        if (JSON.stringify(dependenciesBefore.entries) !== JSON.stringify(dependenciesAfter.entries) || lockBefore.sha256 !== lockAfter.sha256)
          evidence.blockers.push("cargo-dependency-bytes-changed-during-build");
        // Raw compiler-artifact messages retain Cargo's fresh/cache observations.
        // They are inputs to independent review, never an authored approval flag.
        if (result.receipt.failure || result.receipt.status !== 0) throw new Error("native-corten-build-failed");
        entry = join(root, "bench/browser/gen/src/bin/client.js");
        screen = readFileSync(join(dir, "screen.html"), "utf8");
        footer = readFileSync(join(dir, "client.footer.js"), "utf8");
        writeFileSync(join(dir, "runtime.js"), readFileSync(join(root, "crates/corten/js/dist/corten.js")));
      }
      if (app === "solid") {
        if (!candidate?.latestStableEligible) throw new Error("solid-2-compiler-policy-not-satisfied");
        solid = solidBuildPlugin(entry); plugins.push(solid.plugin);
      }
      if (app === "svelte") plugins.push({ name: "svelte", setup(b) {
        b.onLoad({ filter: /\.svelte$/ }, ({ path }) => ({ contents: require("svelte/compiler").compile(readFileSync(path, "utf8"), { filename: path, generate: "client", css: "external" }).js.code, loader: "js", resolveDir: dirname(path) }));
      } });
      if (app === "vue") plugins.push({ name: "vue", setup(b) {
        b.onLoad({ filter: /\.vue$/ }, ({ path }) => {
          const sfc = require("vue/compiler-sfc"), { descriptor, errors } = sfc.parse(readFileSync(path, "utf8"), { filename: path });
          if (errors.length) throw errors[0];
          return { contents: sfc.compileScript(descriptor, { id: path, isProd: true, inlineTemplate: true }).content, loader: "js", resolveDir: dirname(path) };
        });
      } });
      const buildOptions = { ...fixedBuildOptions(app, root), entryPoints: [entry], plugins };
      const optionsForReceipt = { ...buildOptions, plugins: plugins.map((p) => p.name) };
      writeFileSync(join(dir, "build-options.json"), json(optionsForReceipt));
      const result = await build(buildOptions);
      const inputs = Object.keys(result.metafile.inputs).sort().map((path) => ({ path: relative(root, resolve(root, path)).replaceAll("\\", "/"), sha256: sha256(readFileSync(resolve(root, path))) }));
      if (solid && !matchesSolidRuntime(new Map(inputs.map((input) => [input.path, input]))))
        throw new Error("missing or modified Solid 2 runtime inputs; run npm --prefix bench/browser ci");
      writeFileSync(join(dir, "metafile.json"), json(result.metafile));
      const code = result.outputFiles[0].text + "\n" + footer;
      const bundle = app === "corten" ? "client.js" : "app.js";
      writeFileSync(join(dir, bundle), code);
      writeFileSync(join(dir, "index.html"), documentMarkup(app, workload, screen));
      apps[app] = { outcome: "built", inputs, bundleSha256: sha256(code), bytes: Buffer.byteLength(code), artifacts: Object.fromEntries(["index.html", bundle, ...(app === "corten" ? ["runtime.js", "views.js"] : [])].map((name) => [name, sha256(readFileSync(join(dir, name)))])) };
      const inputBytes = [];
      for (const input of inputs) inputBytes.push({ path: input.path, ...await evidence.file(root, input.path) });
      writeFileSync(join(dir, "build-receipt.json"), json({ schema: "client-heavy-build-receipt/v1", app, startedAt, endedAt: clock(),
        esbuild: { version: require("esbuild").version, entry: await evidence.blob(readFileSync(require.resolve("esbuild"))) },
        optionsSha256: sha256(json(optionsForReceipt)), metafileSha256: sha256(json(result.metafile)),
        rawBundle: await evidence.blob(result.outputFiles[0].contents), footer: await evidence.blob(Buffer.from(footer)),
        inputs: inputBytes, artifacts: apps[app].artifacts, ...(solid ? { solidCompiler: solid.receipt } : {}) }));
    } catch (error) {
      apps[app] = { outcome: "failed", reason: "native-build-failed", diagnosticSha256: sha256(String(error)) };
      writeFileSync(join(dir, "failure.log"), String(error));
    }
    writeFileSync(join(out, "build.json"), json(apps));
  }
  writeFileSync(join(out, "build.json"), json(apps));
  return apps;
}
