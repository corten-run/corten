import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { k6Version } from "../load-tool.mjs";

const sourceNames = ["fixed-prototype-load.js", "load.js", "load-outcome.js"];
const digest = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function absolute(value) {
  assert.ok(typeof value === "string" && !value.includes("\0"), "absolute experiment path required");
  const normalized = value.replaceAll("\\", "/");
  assert.ok(/^(?:\/|[A-Za-z]:\/)/.test(normalized) && normalized.split("/").every((p) => p !== "." && p !== ".."), "unsafe/relative experiment path");
  return normalized;
}
export function fixedPrototypeArgv(config, summaryPath, scriptPath, outputDirectory) {
  return ["run", "--quiet", "--log-format", "json", "--summary-export", summaryPath, "--out", "json=-",
    ...Object.entries({ BASE: config.base, PAYLOAD: config.payload, MODE: "fixed", RATE: String(config.rate), VUS: "64",
      DURATION: `${config.seconds}s`, JSON_PROTOTYPE_OUTPUT: outputDirectory.replaceAll("\\", "/") }).flatMap(([key, value]) => ["-e", `${key}=${value}`]), scriptPath];
}

// Expected manifests come from the caller or THIS verifier's source tree, never
// from a path selected by the saved capture. No retained executable is executed.
export function verifyExperimentIdentity(capture, { sourceManifest, executableManifest } = {}) {
  const config = capture.config;
  assert.ok(config && config.phase === "fixed" && Number.isSafeInteger(config.seconds) && config.seconds >= 1 && config.seconds <= 300
    && Number.isSafeInteger(config.rate) && config.rate >= 1 && config.rate <= 10000, "experiment fixed configuration missing");
  assert.equal(Object.keys(config).sort().join(","), ["base", "payload", "phase", "rate", "seconds"].join(","), "experiment config fields differ");
  assert.ok(["catalog-v1", "marketplace-v2"].includes(config.payload), "experiment payload differs");
  const base = new URL(config.base);
  assert.ok(base.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(base.hostname)
    && config.base === base.origin, "experiment loopback base differs");
  const executable = capture.executable;
  assert.ok(executable && digest(executable.sha256), "experiment executable digest missing/invalid");
  absolute(executable.path);
  assert.ok(typeof executable.version === "string" && new RegExp(`^k6 v${k6Version.replaceAll(".", "\\.")}(?:\\s|$)`).test(executable.version), "experiment executable is not pinned k6");
  assert.equal(Object.keys(executable).sort().join(","), "path,sha256,version", "executable receipt fields differ");
  if (executableManifest !== undefined) {
    assert.ok(digest(executableManifest?.sha256), "trusted executable manifest invalid");
    assert.equal(executable.sha256, executableManifest.sha256, "experiment executable differs from supplied manifest");
    if (executableManifest.version !== undefined) assert.equal(executable.version, executableManifest.version, "experiment executable version differs from supplied manifest");
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const expected = sourceManifest ?? Object.fromEntries(sourceNames.map((name) => [name, createHash("sha256").update(readFileSync(join(here, name))).digest("hex")]));
  assert.equal(Object.keys(expected).sort().join(","), [...sourceNames].sort().join(","), "trusted experiment source inventory differs");
  assert.ok(Object.values(expected).every(digest), "trusted experiment source digest invalid");
  assert.ok(isDeepStrictEqual(capture.sources, expected), "experiment source inventory/hash differs");
  assert.ok(Array.isArray(capture.argv) && capture.argv.length === 23 && capture.argv.every((s) => typeof s === "string" && !s.includes("\0")), "experiment argv missing/invalid");
  const summary = absolute(capture.argv[5]), script = absolute(capture.argv.at(-1));
  assert.ok(summary.endsWith("/summary.json"), "experiment summary path differs");
  assert.ok(script.endsWith("/bench/json-api/fixed-prototype-load.js"), "experiment load script differs");
  const output = summary.slice(0, -"/summary.json".length) || "/";
  assert.ok(isDeepStrictEqual(capture.argv, fixedPrototypeArgv(config, capture.argv[5], capture.argv.at(-1), output)), "experiment argv/configuration differs");
  return { sourceManifest: expected, executableSha256: executable.sha256, executableExternallyBound: executableManifest !== undefined };
}
