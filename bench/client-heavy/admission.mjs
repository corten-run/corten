// The second argument is supplied by a trusted controller channel, never read
// from the saved evidence folder. This module does not establish that channel.
import { createHash } from "node:crypto";
import { isDeepStrictEqual as same } from "node:util";
import { validateSaved } from "./verify.mjs";
import { need, keys, digest, finite } from "./replay-v2.mjs";
import { verifyHostProof } from "./host-proof.mjs";

const hash = (v) => createHash("sha256").update(JSON.stringify(v, null, 2) + "\n").digest("hex");
export async function admitSaved(request, trusted) {
  const replay = await validateSaved(request);
  const admission = { schema: "client-heavy-admission/v1", subjectSha256: replay.subjectSha256 ?? null,
    status: "blocked", admitted: false, readyForLoad: false, rankingEligible: false, isolation: "unknown", errors: [], blockers: [], replay };
  if (replay.schema !== "client-heavy-saved-verification/v2" || replay.status !== "verified") {
    admission.blockers.push("complete-successful-v2-replay-required"); return admission;
  }
  if (!trusted) { admission.blockers.push("external-trusted-observation-and-independent-build-review-required"); return admission; }
  try {
    keys(trusted, ["context", "observation", "buildReview", "hostProof"]);
    const { context: c, observation: o, buildReview: r } = trusted;
    keys(c, ["schema", "attemptId", "unitId", "hostId", "observerId", "producerId", "commit", "round", "invocationSha256", "sourceFilesSha256",
      "cpuSet", "cpuMax", "memoryMaxBytes", "exclusive", "bootId", "unitPath", "networkPolicySha256", "toolchainSha256", "configurationSha256"]);
    need(c.schema === "client-heavy-trusted-context/v1" && [c.attemptId, c.unitId, c.hostId, c.observerId, c.producerId, c.cpuSet].every((s) => typeof s === "string" && s.length > 0)
      && c.observerId !== c.producerId && c.commit === request.commit && c.round === request.round
      && Number.isSafeInteger(c.memoryMaxBytes) && c.memoryMaxBytes > 0 && c.exclusive === true
      && [c.networkPolicySha256, c.toolchainSha256, c.configurationSha256].every(digest), "invalid-trusted-context");
    need(c.invocationSha256 === hash(replay.invocation) && c.sourceFilesSha256 === hash(replay.sources.files), "context-differs-from-source-or-invocation");
    if (trusted.hostProof === null) { admission.blockers.push("worker-owned-live-os-proof-required"); return admission; }
    admission.host = verifyHostProof(replay, c, trusted.hostProof);
    keys(o, ["schema", "attemptId", "unitId", "hostId", "observerId", "subjectSha256", "commit", "round", "startedAt", "endedAt", "exitCode",
      "filesSha256", "configurationNamesSha256", "toolchainSha256", "configurationSha256", "networkPolicySha256", "cpuSet", "memoryMaxBytes", "exclusive"]);
    need(o.schema === "client-heavy-trusted-observation/v1" && ["attemptId", "unitId", "hostId", "observerId", "commit", "round", "cpuSet", "memoryMaxBytes", "exclusive",
      "toolchainSha256", "configurationSha256", "networkPolicySha256"].every((k) => same(o[k], c[k]))
      && o.subjectSha256 === replay.subjectSha256 && finite(o.startedAt) && finite(o.endedAt) && o.endedAt > o.startedAt && o.exitCode === 2
      && o.startedAt <= replay.executionWindow.startedAt && o.endedAt >= replay.executionWindow.endedAt
      && o.filesSha256 === hash(replay.files) && o.configurationNamesSha256 === hash(replay.configurationNames), "observation-differs-from-context-or-subject");
    // Review is independent evidence with its own identity and receipt. The
    // producer never authors it, and it cannot be replaced by a saved approval.
    if (r === null) { admission.blockers.push("independent-source-build-review-required"); return admission; }
    keys(r, ["schema", "reviewerId", "subjectSha256", "sourceFilesSha256", "toolchainSha256", "configurationSha256", "receiptSha256", "verdict"]);
    need(r.schema === "client-heavy-independent-build-review/v1" && typeof r.reviewerId === "string" && r.reviewerId.length > 0
      && r.reviewerId !== c.producerId && r.reviewerId !== c.observerId && r.subjectSha256 === replay.subjectSha256
      && r.sourceFilesSha256 === c.sourceFilesSha256 && r.toolchainSha256 === c.toolchainSha256 && r.configurationSha256 === c.configurationSha256
      && digest(r.receiptSha256) && r.verdict === "pass", "invalid-independent-build-review");
    admission.status = "admitted"; admission.admitted = true; admission.readyForLoad = true;
    admission.isolation = "trusted-unit";
    // A functional attempt is not a statistical ranking, even on an admitted host.
  } catch (error) {
    admission.status = "invalid";
    admission.errors.push({ at: "trusted-admission", reason: /^[a-z][a-z0-9-]+$/.test(error.message ?? "") ? error.message : "malformed-trusted-admission" });
  }
  return admission;
}
