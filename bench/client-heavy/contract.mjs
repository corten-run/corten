// Shared invocation semantics only. Importing this module cannot build or run apps.
import assert from "node:assert/strict";
import { win32, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClientWorkload } from "../workloads/client.mjs";

export const defaults = Object.freeze({ rows: 14, large: 110, append: 7, cards: 24, seed: 7,
  "cleanup-ms": 2000, "observation-ms": 100, "timeout-ms": 30000, cargo: "cargo" });
export const localRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
export function options(args, root = localRoot, platform = process.platform) {
  const path = platform === "win32" ? win32 : posix;
  assert.ok(Array.isArray(args) && args.every((a) => typeof a === "string"), "invalid argv");
  const [round, ...rest] = args;
  assert.match(round ?? "", /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/, "explicit safe round argument required");
  const values = { ...defaults, out: path.join(root, "bench/client-heavy/work", round) };
  const seen = new Set();
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i].replace(/^--/, "");
    assert.ok(rest[i].startsWith("--") && Object.hasOwn(values, key) && rest[i + 1] !== undefined && !seen.has(key), "unknown, missing or duplicate option");
    seen.add(key);
    values[key] = ["out", "cargo"].includes(key) ? rest[i + 1] : Number(rest[i + 1]);
  }
  for (const key of ["cleanup-ms", "observation-ms", "timeout-ms"]) assert.ok(Number.isSafeInteger(values[key]) && values[key] > 0 && values[key] <= 120000, `invalid ${key}`);
  assert.ok(values["timeout-ms"] > values["observation-ms"] + values["cleanup-ms"], "journey timeout must exceed cleanup bounds");
  assert.ok(values.cargo.length > 0 && !/[\x00-\x1f]/.test(values.cargo), "invalid cargo");
  const workload = createClientWorkload({ seed: values.seed, rowCount: values.rows, largeRowCount: values.large, appendCount: values.append, dashboardCount: values.cards });
  const out = path.resolve(root, values.out);
  return { round, out, cargo: values.cargo, timeoutMs: values["timeout-ms"], settings: { maxCleanupMs: values["cleanup-ms"], cleanupObservationMs: values["observation-ms"] }, workload,
    invocation: { argv: [...args], defaults: { ...defaults, out: path.join(root, "bench/client-heavy/work", round) }, effective: { ...values, out } } };
}

// Names only, never values or hashes of potentially secret values. Admission must
// bind the trusted host's configuration observation, not assume absent overrides.
export const configurationNames = (env) => Object.keys(env).filter((key) => /^(?:CARGO(?:_|$)|RUST|NODE_|ESBUILD_|BABEL_|BROWSERSLIST|PLAYWRIGHT_|LD_|DYLD_|CC$|CXX$|AR$|CFLAGS$|CXXFLAGS$|LDFLAGS$|PATH$|PATHEXT$|HOME$|USERPROFILE$|XDG_)/i.test(key)).sort();
export const sourceRoots = ["Cargo.toml", "Cargo.lock", "package.json", "package-lock.json", ".cargo", "rust-toolchain", "rust-toolchain.toml",
  "crates", "bench/client-heavy", "bench/browser", "bench/workloads", "bench/fullstack/inventory.mjs", "bench/marketplace/contract.mjs"];

export function buildOptions(app, root, platform = process.platform) {
  const path = platform === "win32" ? win32 : posix;
  const entry = app === "corten" ? "bench/browser/gen/src/bin/client.js" : `bench/client-heavy/apps/${app}.${["react", "solid"].includes(app) ? "jsx" : app === "remix" ? "tsx" : "js"}`;
  return { absWorkingDir: root, entryPoints: [path.join(root, entry)], bundle: true, format: "esm", minify: true, target: "es2022", write: false, metafile: true,
    conditions: ["browser", "production"], plugins: ["solid", "svelte", "vue"].includes(app) ? [app] : [], jsx: "automatic",
    jsxImportSource: app === "react" ? "react" : "remix/component",
    define: { "process.env.NODE_ENV": '"production"', __VUE_OPTIONS_API__: "true", __VUE_PROD_DEVTOOLS__: "false", __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false" },
    external: app === "corten" ? ["corten", "corten/views"] : [], nodePaths: [path.join(root, "bench/browser/node_modules")], logLevel: "silent" };
}

export function documentMarkup(app, workload, screen = "") {
  const fixture = JSON.stringify(workload).replaceAll("<", "\\u003c");
  const head = app === "corten"
    ? '<script type="importmap">{"imports":{"corten":"./runtime.js","corten/views":"./views.js"}}</script><meta name="corten-scripts" content="./"><script type="module" src="./runtime.js"></script><script type="module" src="./client.js"></script>'
    : '<script type="module" src="./app.js"></script>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${app} client-heavy</title><link rel="icon" href="data:,"><script id="fixture" type="application/json">${fixture}</script>${head}</head><body><main id="mount"></main>${app === "corten" ? `<template id="screen-template">${screen}</template>` : ""}</body></html>`;
}
