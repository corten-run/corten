// Untimed, sequential functional checks shared by localized marketplace and mixed production.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { collectBoundedResponse, collectQualification } from "../hardening/qualification.mjs";
import { boundedDeadlineMs, boundedFeatureProfile, validateActiveQualification } from "./feature-contract.mjs";

export async function nativeProbe(script, input) {
  assert.equal(script, "conform-probe", "only ordinary HTTP requests are supported");
  const { base, path, headers, method, body } = input;
  return collectBoundedResponse(base, undefined, path, headers, method, body);
}

// The mixed worker journals individual native observations and redacts them itself.
export async function qualifyRaw({ base, source, upstream, probe = nativeProbe }) {
  assert.ok(["fixture", "api"].includes(source));
  const url = new URL(base);
  assert.equal(url.protocol, "http:");
  const request = (path, headers, method = "GET", body) => probe("conform-probe", {
    base: url.origin, host: url.hostname, port: Number(url.port || 80), path, headers, method,
    timeoutMs: boundedDeadlineMs, ...(body === undefined ? {} : { body }),
  });
  const q = await collectQualification({ origin: url.origin, source, upstream, request });
  return validateActiveQualification({ ...q, profile: boundedFeatureProfile });
}

export async function qualify(options) {
  // Retain the same feature outcomes, not session cookies, form tokens or arbitrary
  // response headers in the marketplace/standalone artifacts.
  const { qualificationEvidence } = await import("../mixed-production/qualification-evidence.mjs");
  return qualificationEvidence(await qualifyRaw(options)).qualification;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [base, source, upstream, output] = process.argv.slice(2);
  const result = await qualify({ base, source, upstream });
  writeFileSync(output, JSON.stringify(result, null, 2));
  console.log(`${source}: ${result.eligible ? "qualified" : `excluded: ${result.missing.join(", ")}`}. Connection-flood resistance: not measured.`);
}
