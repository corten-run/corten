import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { nativeProbe, qualify } from "../marketplace/qualify.mjs";
import { sha256 } from "./capture.mjs";
import { probeProjection, qualificationEvidence } from "./qualification-evidence.mjs";

export async function runQualificationWorker(config, executeProbe = nativeProbe) {
  const result = { schema: "mixed-native-qualification/v1", app: config.app, source: config.source, imageId: config.imageId,
    nativeProfile: config.nativeProfile, eligible: false, failure: null };
  const evidencePath = join(dirname(config.output), "qualification-evidence.json");
  let evidence = { schema: "mixed-native-qualification-evidence/v1", app: config.app, source: config.source,
    imageId: config.imageId, nativeProfile: config.nativeProfile, failure: "qualification-in-progress", events: [] };
  const saveEvidence = () => writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
  saveEvidence();
  const probe = (script, input) => {
    const event = { index: evidence.events.length, kind: script === "conform-probe" ? "http" : "connection",
      inputSha256: sha256(JSON.stringify(input)), responseSha256: null, response: null, failure: null };
    evidence.events.push(event);
    saveEvidence();
    try {
      const actual = executeProbe(script, input);
      event.responseSha256 = sha256(JSON.stringify(actual));
      try { event.response = probeProjection(actual); }
      catch { event.failure = "credential-filter-blocked"; }
      saveEvidence();
      return actual;
    } catch (error) {
      event.failure = "probe-execution-failed"; saveEvidence(); throw error;
    }
  };
  try {
    // Validate the original native probes in memory, not sanitized or supplied receipts.
    const q = await qualify({ ...config, probe });
    let filtered;
    try { filtered = qualificationEvidence(q); }
    catch { evidence.failure = "credential-filter-blocked"; throw new Error("credential-filter-blocked"); }
    evidence = { ...evidence, ...filtered };
    if (evidence.events.some((event) => event.failure)) {
      evidence.failure = "credential-filter-blocked"; throw new Error("credential-filter-blocked");
    }
    result.profile = q.profile; result.cells = q.cells; result.missing = q.missing; result.eligible = q.eligible;
    result.rawProbeSha256 = sha256(JSON.stringify(q.probes));
    result.probes = Object.fromEntries(Object.entries(q.probes).map(([key, value]) => [key, {
      sha256: sha256(JSON.stringify(value)), ...(typeof value === "object" && value !== null && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).filter(([k]) => ["status", "ms", "bodyLength", "closedMs", "timedOutMs", "timedOut", "error"].includes(k))) : {}),
    }]));
  } catch {
    result.failure = "native-production-qualification-failed";
    if (evidence.failure === "qualification-in-progress") evidence.failure = result.failure;
  }
  saveEvidence();
  // Raw qualification bodies/cookies/CSRF values never leave memory. Probe hashes and
  // capability cells retain the outcome without publishing an opaque session credential.
  writeFileSync(config.output, JSON.stringify(result, null, 2));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runQualificationWorker(JSON.parse(readFileSync(process.argv[2], "utf8")));
  if (!result.eligible) process.exitCode = 1;
}
