import { readFileSync, writeFileSync } from "node:fs";
import { qualify } from "../marketplace/qualify.mjs";
import { sha256 } from "./capture.mjs";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const result = { schema: "mixed-native-qualification/v1", app: config.app, source: config.source, imageId: config.imageId,
  nativeProfile: config.nativeProfile, eligible: false, failure: null };
try {
  // Validate the original native probes in memory, not sanitized or supplied receipts.
  const q = await qualify(config);
  result.profile = q.profile; result.cells = q.cells; result.missing = q.missing; result.eligible = q.eligible;
  result.rawProbeSha256 = sha256(JSON.stringify(q.probes));
  result.probes = Object.fromEntries(Object.entries(q.probes).map(([key, value]) => [key, {
    sha256: sha256(JSON.stringify(value)), ...(typeof value === "object" && value !== null && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).filter(([k]) => ["status", "ms", "bodyLength", "closedMs", "timedOutMs", "timedOut", "error"].includes(k))) : {}),
  }]));
} catch { result.failure = "native-production-qualification-failed"; }
// Raw qualification bodies/cookies/CSRF values never leave memory. Probe hashes and
// capability cells retain the outcome without publishing an opaque session credential.
writeFileSync(config.output, JSON.stringify(result, null, 2));
if (!result.eligible) process.exitCode = 1;
