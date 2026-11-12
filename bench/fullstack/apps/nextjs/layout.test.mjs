import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

// Use Next's real prerender stores and connection(), not a mock that always resolves.
globalThis.AsyncLocalStorage ??= AsyncLocalStorage;
const { workAsyncStorage } = await import("next/dist/server/app-render/work-async-storage.external.js");
const { workUnitAsyncStorage } = await import("next/dist/server/app-render/work-unit-async-storage.external.js");
const { connection } = await import("next/dist/server/request/connection.js");
const require = createRequire(import.meta.url);
const compiled = ts.transpileModule(readFileSync(new URL("./app/layout.tsx", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

for (const PROFILE of ["", "matched"]) {
  test(`native legacy prerender probe: ${PROFILE || "default"} layout`, async () => {
    const exports = {};
    runInNewContext(compiled, {
      exports, process: { env: { PROFILE } },
      require: (name) => name === "next/server" ? { connection }
        : name === "./hydration-mark" ? { HydrationMark: () => null }
        : name.endsWith(".css") ? {} : require(name),
    });
    const work = { route: "/_not-found", isStaticGeneration: true };
    const unit = { type: "prerender-legacy", phase: "render", revalidate: 3600 };
    const rendered = workAsyncStorage.run(work, () => workUnitAsyncStorage.run(unit, () => exports.default({ children: null })));
    if (PROFILE) {
      await assert.rejects(rendered, (error) => error.digest === "DYNAMIC_SERVER_USAGE");
      assert.equal(unit.revalidate, 0);
      assert.match(work.dynamicUsageDescription, /connection/);
    } else {
      assert.equal((await rendered).type, "html");
      assert.equal(unit.revalidate, 3600);
      assert.equal(work.dynamicUsageDescription, undefined);
    }
  });
}
