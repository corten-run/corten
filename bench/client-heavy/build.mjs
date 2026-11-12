import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { selectedApps } from "../workloads/registry.mjs";

export const here = dirname(fileURLToPath(import.meta.url));
export const root = resolve(here, "../..");
const require = createRequire(join(root, "bench/browser/package.json"));
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (x) => JSON.stringify(x, null, 2) + "\n";
const flags = { "process.env.NODE_ENV": '"production"', __VUE_OPTIONS_API__: "true", __VUE_PROD_DEVTOOLS__: "false", __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false" };

export async function buildApps(workload, directory, cargo = "cargo", generator = null) {
  const { build } = require("esbuild");
  const out = resolve(directory), apps = {};
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "workload.json"), json(workload));
  const fixture = JSON.stringify(workload).replaceAll("<", "\\u003c");
  for (const app of selectedApps("client-heavy")) {
    const dir = join(out, app);
    mkdirSync(dir, { recursive: true });
    try {
      let entry = join(here, "apps", `${app}.${app === "react" || app === "solid" ? "jsx" : app === "remix" ? "tsx" : "js"}`);
      let markup = "", head = '<script type="module" src="./app.js"></script>', footer = "";
      const plugins = [];
      if (app === "corten") {
        const input = [relative(root, join(out, "workload.json")).replaceAll("\\", "/"), relative(root, dir).replaceAll("\\", "/")];
        const command = generator ?? cargo;
        const args = generator ? input : ["run", "--quiet", "--release", "--manifest-path", "bench/browser/gen/Cargo.toml", "--bin", "client", "--", ...input];
        if (process.platform === "win32" && /\.cmd$/i.test(command) && [command, ...args].some((arg) => /[&|<>^%!"\r\n]/.test(arg))) throw new Error("unsafe-batch-argument");
        // A build launcher may wait in a machine queue. Do not kill just its shell and
        // leave the actual build orphaned. Native browser journeys have their own bound.
        const result = process.platform === "win32" && /\.cmd$/i.test(command)
          ? spawnSync("cmd.exe", ["/d", "/c", command, ...args], { cwd: root, encoding: "utf8" })
          : spawnSync(command, args, { cwd: root, encoding: "utf8" });
        writeFileSync(join(dir, "build.log"), `${result.stdout ?? ""}${result.stderr ?? ""}`);
        if (result.error || result.status !== 0) throw new Error("native-corten-build-failed");
        entry = join(root, "bench/browser/gen/src/bin/client.js");
        markup = `<template id="screen-template">${readFileSync(join(dir, "screen.html"), "utf8")}</template>`;
        footer = readFileSync(join(dir, "client.footer.js"), "utf8");
        writeFileSync(join(dir, "runtime.js"), readFileSync(join(root, "crates/corten/js/dist/corten.js")));
        head = '<script type="importmap">{"imports":{"corten":"./runtime.js","corten/views":"./views.js"}}</script><meta name="corten-scripts" content="./"><script type="module" src="./runtime.js"></script><script type="module" src="./client.js"></script>';
      }
      if (app === "solid") plugins.push({ name: "solid", setup(b) {
        b.onLoad({ filter: /\.jsx$/ }, async ({ path }) => {
          const result = await require("@babel/core").transformAsync(readFileSync(path, "utf8"), { filename: path, presets: [[require.resolve("babel-preset-solid"), { generate: "dom" }]] });
          return { contents: result.code, loader: "js" };
        });
      } });
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
      const result = await build({ entryPoints: [entry], bundle: true, format: "esm", minify: true, target: "es2022", write: false, metafile: true,
        conditions: ["browser", "production"], plugins, jsx: "automatic", jsxImportSource: app === "react" ? "react" : "remix/component", define: flags,
        external: app === "corten" ? ["corten", "corten/views"] : [], nodePaths: [join(root, "bench/browser/node_modules")], logLevel: "silent" });
      const code = result.outputFiles[0].text + "\n" + footer;
      const bundle = app === "corten" ? "client.js" : "app.js";
      writeFileSync(join(dir, bundle), code);
      writeFileSync(join(dir, "index.html"), `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${app} client-heavy</title><link rel="icon" href="data:,"><script id="fixture" type="application/json">${fixture}</script>${head}</head><body><main id="mount"></main>${markup}</body></html>`);
      const inputs = Object.keys(result.metafile.inputs).sort().map((path) => ({ path: relative(root, resolve(path)).replaceAll("\\", "/"), sha256: sha256(readFileSync(resolve(path))) }));
      apps[app] = { outcome: "built", inputs, bundleSha256: sha256(code), bytes: Buffer.byteLength(code), artifacts: Object.fromEntries(["index.html", bundle, ...(app === "corten" ? ["runtime.js", "views.js"] : [])].map((name) => [name, sha256(readFileSync(join(dir, name)))])) };
    } catch (error) {
      apps[app] = { outcome: "failed", reason: "native-build-failed", diagnosticSha256: sha256(String(error)) };
      writeFileSync(join(dir, "failure.log"), String(error));
    }
  }
  writeFileSync(join(out, "build.json"), json(apps));
  return apps;
}
