// Read-only saved campaign inspection. Collection integrity is not qualification,
// provider ownership, operator authorization or independent human attestation.
import assert from "node:assert/strict";
import { join } from "node:path";
import { campaignRounds, exact, groupCampaignSchema, jsonPhase, mixedPhase, validateCampaign as validatePlan } from "./campaign-contract.mjs";
import { digest, inspectEvidence, phaseSnapshot, readRegular, supportedGroups, tree } from "./evidence.mjs";
import { auditSubject, inspectPreparation, validateAuditDelivery, validateTimingAudit } from "./json-staging.mjs";
import { deploymentSha256 } from "../deployments.mjs";
import { replayJournal } from "./campaign-journal.mjs";
import { executionGroups, inspectNative } from "./native-replay.mjs";
import { inspectLifetime, composeHostProof } from "./host-lifetime.mjs";
import { commandResult, composePhase } from "./composition.mjs";
import { registrySchema } from "../registry.mjs";
import { alternateCampaignPlacements } from "./contract.mjs";
import { udevSettlePolicy, verifyHostBoundary, verifySettledHostBoundary } from "./host-observation.mjs";
import { replayMixedSubject, validateMixedDelivery, validateMixedRun } from "./mixed-staging.mjs";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { verifyControlAdmission } from "./control-admission.mjs";
import { apparatusProof, nativeControlPartition, verifyStreamAudit, verifyStreamDrain, verifyStreamSeal } from "./control-stream.mjs";

export async function validateCampaign(input) {
  try {
    exact(input, ["folder", "round", "commit"]);
    campaignRounds(input.round); assert.match(input.commit ?? "", /^[a-f0-9]{40}$/);
    const { folder, round, commit } = input, snapshot = tree(folder);
    const read = (path) => JSON.parse(readRegular(join(folder, path)));
    const reservation = read(".host-attempt.json");
    assert.equal(reservation.schema, "benchmark-isolated-campaign-reservation/v1");
    assert.match(reservation.id, new RegExp(`^${round}-[a-f0-9]{16}$`));
    const id = reservation.id;
    const plan = read(`${id}/plan.json`);
    assert.equal(plan.round, round); assert.equal(plan.commit, commit); assert.equal(reservation.commit, commit);
    validatePlan(plan);
    const groupScoped = plan.schema === groupCampaignSchema;
    assert.equal(reservation.campaignSha256, plan.campaignSha256);
    assert.ok(snapshot.entries.every((e) => !e.path || e.path === ".host-attempt.json" || e.path === id || e.path.startsWith(`${id}/`)), "foreign campaign root member");
    const saved = read(`${id}/campaign-result.json`), status = saved.status;
    assert.equal(saved.deletionAuthorized, false); assert.equal(saved.wholeHostTerminal, "parent-must-observe");
    assert.equal(status.schema, "benchmark-isolated-campaign-status/v1");
    assert.equal(status.campaign, id); assert.equal(status.round, round); assert.equal(status.campaignSha256, plan.campaignSha256);
    assert.equal(status.controllerReady, false); assert.equal(status.isolation, "unverified");
    const currentExecution = [2, 3, 4, 5].includes(status.executionVersion), mixedStaging = [3, 4, 5].includes(status.executionVersion), groups = currentExecution ? executionGroups : supportedGroups;
    assert.ok(!groupScoped || mixedStaging, "group campaigns require current audit and host lifetime gates");
    assert.ok(["finished", "preserved-uncertain"].includes(status.state));
    assert.deepEqual(status.outcomes.map((r) => r.group), plan.order, "every fixed registry group must be retained once");
    assert.ok(Array.isArray(status.uncollectedNativeRoots));
    const allowedOutcomes = ["not-run", "failed", "blocked", "native-validated", "preserved-uncertain"];
    assert.ok(status.outcomes.every((r) => allowedOutcomes.includes(r.outcome)));
    for (const outcome of status.outcomes) {
      if (!groups.includes(outcome.group)) assert.equal(outcome.outcome, "not-run", "unimplemented group cannot be claimed executed/qualified");
    }
    const subtree = tree(join(folder, id)), events = subtree.entries.filter((e) => /^\d{5}-[a-z-]+\.json$/.test(e.path));
    assert.ok(events.length > 0, "durable campaign journal missing");
    const journal = [];
    for (const [sequence, entry] of events.entries()) {
      const event = read(`${id}/${entry.path}`);
      assert.equal(event.schema, "benchmark-isolated-campaign-event/v1"); assert.equal(event.sequence, sequence);
      assert.equal(event.campaign, id); assert.equal(event.round, round); assert.equal(event.campaignSha256, plan.campaignSha256);
      assert.equal(entry.path, `${String(sequence).padStart(5, "0")}-${event.kind}.json`);
      journal.push(event);
    }
    const replay = replayJournal(plan, id, journal, status);
    let controlHost, apparatus, streamSeal, supervisedTerminal;
    for (const [epoch, event] of replay.controlAdmissions) {
      const bytes = readRegular(join(folder, id, event.path)); assert.equal(digest(bytes), event.sha256);
      const admission = JSON.parse(bytes);
      if (event.channel === "stream") {
        assert.equal(status.executionVersion, 5); assert.ok(apparatus);
        const group = epoch.slice(6), subject = group === "json-api" ? replay.reviewNeeded.subjectSha256 : replay.mixedReviewNeeded.subjectSha256;
        verifyStreamAudit(event.binding, apparatus, admission, group, subject); assert.equal(admission.intent.campaign, id);
        const delivery = readRegular(join(folder, id, `${group === "json-api" ? "json" : "mixed"}-audit-delivery.json`));
        assert.equal(digest(delivery), admission.intent.sha256); assert.equal(delivery.length, admission.intent.bytes); continue;
      }
      verifyControlAdmission(event.binding, epoch, admission);
      if (status.executionVersion === 5) { assert.equal(epoch, "bootstrap"); assert.ok(admission.apparatus); apparatus = admission.apparatus; }
      else assert.equal(admission.apparatus, undefined, "legacy execution cannot claim supervised apparatus");
      if (controlHost) assert.deepEqual(admission.host, controlHost);
      else controlHost = admission.host;
    }
    if (status.executionVersion === 5 && replay.streamSeal) {
      const event = replay.streamSeal, bytes = readRegular(join(folder, id, event.path)); assert.equal(digest(bytes), event.sha256);
      streamSeal = JSON.parse(bytes); verifyStreamSeal(event.binding, streamSeal); assert.deepEqual(streamSeal.registration, apparatus);
      if (status.state === "finished") {
        const drained = read(`${id}/control-stream-drain.json`);
        verifyStreamDrain(event.binding, apparatus, drained); assert.ok(BigInt(drained.monoNs) >= BigInt(streamSeal.sealedMonoNs));
        supervisedTerminal = { registrationSha256: digest(JSON.stringify(apparatus)), sealSha256: event.sha256 };
      }
    }
    if (controlHost && journal.some((event) => event.kind === "started")) {
      const initial = read(`${id}/host-initial.json`);
      for (const field of ["hostname", "bootId"]) assert.equal(initial[field], controlHost[field]);
    }
    const lastEvent = read(`${id}/${events.at(-1).path}`);
    assert.ok(isDeepStrictEqual(lastEvent.status, status), "terminal journal and result disagree");
    const collectionEntry = subtree.entries.find((e) => e.path === "collection-manifest.json");
    if (collectionEntry) {
      const collection = read(`${id}/collection-manifest.json`);
      const entries = subtree.entries.filter((e) => e.path !== "collection-manifest.json");
      assert.ok(isDeepStrictEqual(collection.manifest, { entries, sha256: deploymentSha256(entries) }), "saved campaign manifest differs");
      assert.ok(isDeepStrictEqual(collection.status, status), "collection status differs");
    } else assert.equal(status.state, "preserved-uncertain", "finished campaign needs a sealed collection manifest");
    const diagnostics = [], blockers = currentExecution ? [] : ["legacy three-group campaign is not all-nine execution"];
    const verifiedGroups = [];
    const phaseDirectories = subtree.entries.filter((e) => e.type === "directory" && /^\d{2}-[a-z-]+-(prepare|timing)$/.test(e.path));
    assert.deepEqual(phaseDirectories.map((e) => e.path).sort(), [...replay.phases.keys()].sort(), "native phases do not match journal");
    for (const recorded of replay.phases.values()) for (const path of recorded.logs)
      assert.ok(subtree.entries.some((e) => e.path === path && e.type === "file"), "command log missing");
    const manifests = new Map();
    for (const entry of phaseDirectories) {
      const index = Number(entry.path.slice(0, 2)), group = plan.order[index], phase = entry.path.endsWith("-prepare") ? "prepare" : "timing";
      assert.equal(entry.path, `${String(index).padStart(2, "0")}-${group}-${phase}`);
      assert.ok(groups.includes(group)); assert.ok(phase !== "prepare" || group === "json-api");
      const recorded = replay.phases.get(entry.path), hostObservations = [];
      let hostBefore, boundary;
      if (currentExecution && recorded.phaseManifestSha256 !== undefined) {
        assert.equal(phaseSnapshot(join(folder, id, entry.path), group === "json-api" && phase === "prepare").sha256,
          recorded.phaseManifestSha256, "phase host/native evidence differs from journal seal");
        hostBefore = read(`${id}/${entry.path}/host-before.json`);
        if (status.executionVersion === 5) {
          assert.deepEqual(hostBefore.controlApparatus?.registration, apparatus);
          const after = read(`${id}/${entry.path}/host-after.json`);
          const { cpus, roles } = nativeControlPartition(recorded.binding);
          for (const observation of [hostBefore, after]) {
            const sample = observation.controlApparatus.sample; apparatusProof(apparatus.binding, apparatus, sample, cpus, roles);
            if (streamSeal) assert.ok(BigInt(sample.monoNs) <= BigInt(streamSeal.sealedMonoNs));
          }
        }
        if (controlHost) for (const field of ["hostname", "bootId"]) assert.equal(hostBefore[field], controlHost[field]);
      }
      if (currentExecution) for (const [commandIndex, result] of recorded.results.entries()) {
        // An intent is already forbidden advancement, even if its exit is absent.
        const advanced = commandIndex + 1 < recorded.count || replay.completed.has(group)
          || phase === "prepare" && replay.reviewNeeded !== null;
        if (!result.hostManifestSha256) {
          assert.ok(!advanced, "campaign advanced without command lifetime observations");
          assert.equal(result.success, false, "successful command lacks host observations");
          blockers.push(`${group}/${phase}: host observations incomplete`); continue;
        }
        const observation = inspectLifetime(recorded.binding, recorded.invocations[commandIndex],
          join(folder, id, entry.path, `command-${result.number}-host`),
          { campaign: id, command: result.number, pid: result.pid, result: commandResult(result) });
        assert.equal(observation.manifestSha256, result.hostManifestSha256, "host observations differ from journal seal");
        if (hostBefore) assert.equal(observation.context.bootId, hostBefore.bootId);
        if (advanced) {
          assert.equal(observation.status, "verified", "campaign advanced past an unproven command lifetime");
          assert.equal(observation.cleanupComplete, true);
        }
        hostObservations[commandIndex] = observation;
        if (observation.status !== "verified") blockers.push(`${group}/${phase}: host observations incomplete`);
      }
      if (hostBefore) {
        try {
          const after = read(`${id}/${entry.path}/host-after.json`);
          const settlePath = `${entry.path}/host-after-settled.json`;
          if (subtree.entries.some((e) => e.path === settlePath)) {
            const settlePolicy = status.executionVersion === 5 ? udevSettlePolicy(group, phase) : null;
            const lifetime = hostObservations.at(recorded.results.length - 1);
            assert.ok(settlePolicy && recorded.results.length === recorded.invocations.length && lifetime?.status === "verified"
              && lifetime.cleanupComplete && lifetime.terminalClock, "udev settle lacks an eligible sealed terminal lifetime");
            const settled = read(`${id}/${settlePath}`);
            if (streamSeal) assert.ok(BigInt(settled.controlApparatus.sample.monoNs) <= BigInt(streamSeal.sealedMonoNs));
            boundary = verifySettledHostBoundary(hostBefore, after, settled, lifetime.terminalClock, settlePolicy);
          } else boundary = verifyHostBoundary(hostBefore, after);
        }
        catch { blockers.push(`${group}/${phase}: host boundary uncertain`); }
        if (status.executionVersion === 5 && phase === "prepare" && replay.reviewNeeded)
          assert.ok(boundary && isDeepStrictEqual(replay.reviewNeeded.cleanup, boundary), "JSON preparation cleanup boundary differs");
        if (replay.completed.has(group) && phase === "timing") { assert.ok(boundary); assert.ok(isDeepStrictEqual(status.outcomes[index].cleanup, boundary), "cleanup boundary differs"); }
      }
      const manifestEntry = subtree.entries.find((e) => e.path === `${entry.path}/native-manifest.json`);
      // A move or manifest write alone does not advance an interrupted transfer.
      if (!manifestEntry || (recorded.transferDestination && !recorded.sealed)) {
        assert.ok(!replay.completed.has(group) && replay.pending.some((p) => p.group === group && p.phase === phase), "completed native phase lacks sealed evidence");
        blockers.push(`${group}/${phase}: safe native collection incomplete`); continue;
      }
      const native = join(folder, id, entry.path, "native");
      const manifest = tree(native);
      if (currentExecution) assert.equal(recorded.sealed, true, "collected phase lacks full host/native seal");
      assert.ok(isDeepStrictEqual(manifest, read(`${id}/${entry.path}/native-manifest.json`)), "native snapshot differs from sealed manifest");
      manifests.set(entry.path, manifest);
      const recordedSeal = replay.phases.get(entry.path).manifestSha256;
      // Historical completed phases have group-finished commitments; preparation
      // may instead be committed by the reconstructed review subject below.
      if (recordedSeal !== undefined) assert.equal(manifest.sha256, recordedSeal, "native snapshot differs from journal commitment");
      else assert.ok(group === "json-api" && phase === "prepare" && replay.reviewNeeded,
        "collected native phase lacks a journal commitment");
      const binding = group === "json-api" ? jsonPhase(plan, phase, `/bench/campaign/${id}/json-native-audits.json`)
        : mixedStaging && group === "mixed-production" ? mixedPhase(plan, id) : plan.bindings[index];
      let report, invalid = false;
      if (currentExecution && phase === "timing") {
          const nativeResult = await inspectNative(binding, native);
          const last = hostObservations[recorded.invocations.length - 1];
          const host = last ? composeHostProof(binding, nativeResult, last) : { resources: "blocked", cleanupComplete: false };
          const timingAudit = group === "json-api" ? validateTimingAudit(binding, native,
            read(`${id}/json-audit-subject.json`), read(`${id}/json-native-audits.json`), join(folder, id, "audit-sources")).complete
            : mixedStaging && group === "mixed-production" ? validateMixedRun(binding, native,
              read(`${id}/mixed-audit-subject.json`), read(`${id}/mixed-native-audits.json`)) : true;
          const derived = composePhase(binding, nativeResult, host, recorded.results, timingAudit);
          const savedOutcome = status.outcomes[index];
          if (replay.completed.has(group)) {
            for (const field of ["outcome", "nativeStatus", "appOutcomes", "report"]) assert.ok(isDeepStrictEqual(savedOutcome[field], derived[field]), "saved outcome differs");
            assert.ok(isDeepStrictEqual(savedOutcome.host, host), "saved host proof differs");
          }
          if (nativeResult.status === "invalid") assert.fail("native evidence contradictory");
          report = derived.report;
          if (derived.outcome === "native-validated" && replay.completed.has(group) && boundary) verifiedGroups.push({ group, outcome: derived.outcome,
            bindingSha256: deploymentSha256(binding), nativeManifestSha256: manifest.sha256, appOutcomes: derived.appOutcomes });
      } else try {
        const nativeReport = phase === "prepare" ? inspectPreparation(binding, native).report : inspectEvidence(binding, native);
        // Native assertion/warning/config objects may contain archive-controlled data.
        // Retain originals in the archive; public diagnostics expose bounded states only.
        report = { qualification: phase === "prepare" ? "preparation-only" : nativeReport.qualification === "blocked" ? "blocked" : "native-replay-passed",
          baseline: nativeReport.baseline === true };
      } catch { invalid = true; report = { qualification: "blocked", error: "native-evidence-invalid-or-incomplete" }; }
      const outcome = status.outcomes[index].outcome;
      if (replay.completed.has(group) && ["blocked", "native-validated"].includes(outcome)) assert.equal(invalid, false, "native failure relabeled as a completed outcome");
      if (phase === "timing" && outcome === "native-validated") assert.equal(report.qualification, "native-replay-passed", "native qualification lacks complete replay");
      diagnostics.push({ group, phase, report });
      if (report.qualification === "blocked" || phase === "prepare" && !currentExecution) blockers.push(`${group}/${phase}: native proof incomplete or preparation only`);
    }
    // Every repeated status/outcome seal is a commitment, not a mutable summary.
    for (const recorded of [...journal, { status }]) {
      for (const outcome of [...(recorded.status?.outcomes ?? []), ...(recorded.kind === "group-finished" ? [recorded] : [])]) {
        for (const field of ["manifest", "nativeManifestSha256"]) if (Object.hasOwn(outcome, field)) {
          const index = plan.order.indexOf(outcome.group), phase = field === "manifest" ? "prepare" : "timing";
          assert.ok(index >= 0 && (phase !== "prepare" || (outcome.group === "json-api" && outcome.phase === "prepare")));
          assert.equal(outcome[field], manifests.get(`${String(index).padStart(2, "0")}-${outcome.group}-${phase}`)?.sha256);
          assert.match(outcome[field] ?? "", /^[a-f0-9]{64}$/);
        }
      }
    }
    if (replay.reviewNeeded) {
      const subject = read(`${id}/json-audit-subject.json`), sourceRoot = join(folder, id, "audit-sources");
      const sources = subject.sourcesManifest;
      assert.ok(isDeepStrictEqual(sources.snapshot, tree(sourceRoot)), "audit source snapshot differs");
      assert.equal(sources.sha256, deploymentSha256({ files: sources.files, snapshot: sources.snapshot }));
      assert.ok(isDeepStrictEqual(sources.files.map(({ bytes, storedAs, ...file }) => file), plan.bindings[0].sources.files), "audit source files differ");
      for (const file of sources.files) {
        assert.equal(file.storedAs, `blobs/${file.sha256}`); assert.match(file.sha256, /^[a-f0-9]{64}$/);
        const bytes = readRegular(join(sourceRoot, file.storedAs));
        assert.equal(bytes.length, file.bytes); assert.equal(digest(bytes), file.sha256);
      }
      const jsonIndex = plan.order.indexOf("json-api"); assert.ok(jsonIndex >= 0);
      const prefix = `${String(jsonIndex).padStart(2, "0")}-json-api`, prep = `${prefix}-prepare`, native = join(folder, id, prep, "native");
      const prepared = inspectPreparation(jsonPhase(plan, "prepare"), native);
      assert.ok(isDeepStrictEqual(subject, auditSubject(plan, prepared, manifests.get(prep), sources, read(`${id}/${prep}/images.json`))), "audit subject differs");
      assert.equal(subject.subjectSha256, replay.reviewNeeded.subjectSha256);
      assert.equal(status.auditSubjectSha256, subject.subjectSha256);
      for (const event of journal) if (event.sequence >= replay.reviewNeeded.sequence || event.status?.auditSubjectSha256 != null)
        assert.equal(event.status.auditSubjectSha256, subject.subjectSha256);
      if (replay.auditStaged) {
        const delivery = read(`${id}/json-audit-delivery-retained.json`);
        const expected = { action: "stage-json-audit", campaignSha256: plan.campaignSha256, auditSubjectSha256: subject.subjectSha256,
          deliverySha256: digest(`${JSON.stringify(delivery, null, 2)}\n`), review: delivery.review };
        assert.ok(isDeepStrictEqual(replay.auditStaged.subject, expected), "audit delivery differs from journal commitment");
        const checked = validateAuditDelivery(delivery, subject, sourceRoot);
        assert.ok(isDeepStrictEqual(read(`${id}/json-native-audits.json`), checked.bundle), "JSON audit bundle differs");
        if (manifests.has(`${prefix}-timing`)) {
          const timing = validateTimingAudit(jsonPhase(plan, "timing", `/bench/campaign/${id}/json-native-audits.json`),
            join(folder, id, `${prefix}-timing`, "native"), subject, checked.bundle, sourceRoot);
          if (status.outcomes[jsonIndex].outcome === "native-validated") assert.equal(timing.complete, true);
        }
        if (subtree.entries.some((e) => e.path === "json-audit-delivery.json"))
          assert.ok(isDeepStrictEqual(read(`${id}/json-audit-delivery.json`), delivery), "JSON audit delivery differs");
      }
    } else {
      assert.ok(status.auditSubjectSha256 == null);
      assert.ok(journal.every((e) => e.status?.auditSubjectSha256 == null));
    }
    if (replay.mixedReviewNeeded) {
      const subject = read(`${id}/mixed-audit-subject.json`), sourceRoot = join(folder, id, "mixed-audit-sources");
      await replayMixedSubject(plan, subject, fileURLToPath(new URL("../../../", import.meta.url)), sourceRoot);
      assert.equal(subject.subjectSha256, replay.mixedReviewNeeded.subjectSha256);
      assert.equal(status.mixedAuditSubjectSha256, subject.subjectSha256);
      for (const event of journal) if (event.sequence >= replay.mixedReviewNeeded.sequence || event.status?.mixedAuditSubjectSha256 != null)
        assert.equal(event.status.mixedAuditSubjectSha256, subject.subjectSha256);
      if (replay.mixedAuditStaged) {
        const delivery = read(`${id}/mixed-audit-delivery-retained.json`);
        assert.ok(isDeepStrictEqual(replay.mixedAuditStaged.subject, { action: "stage-mixed-audit", campaignSha256: plan.campaignSha256,
          auditSubjectSha256: subject.subjectSha256, deliverySha256: digest(`${JSON.stringify(delivery, null, 2)}\n`), review: delivery.review }), "mixed audit commitment differs");
        const checked = validateMixedDelivery(delivery, subject, sourceRoot);
        assert.ok(isDeepStrictEqual(read(`${id}/mixed-native-audits.json`), checked.bundle), "mixed audit bundle differs");
        if (subtree.entries.some((e) => e.path === "mixed-audit-delivery.json")) assert.ok(isDeepStrictEqual(read(`${id}/mixed-audit-delivery.json`), delivery), "mixed audit delivery differs");
      }
    } else {
      assert.ok(status.mixedAuditSubjectSha256 == null);
      assert.ok(journal.every((e) => e.status?.mixedAuditSubjectSha256 == null));
    }
    if (currentExecution) for (const event of journal.filter((e) => e.kind === "group-finished")) {
      const savedOutcome = status.outcomes[plan.order.indexOf(event.group)];
      for (const field of ["nativeStatus", "appOutcomes", "report", "host"]) assert.ok(isDeepStrictEqual(event[field], savedOutcome[field]), "journal outcome differs");
    }
    if (currentExecution) for (const event of journal) for (const row of event.status?.outcomes ?? []) {
      const final = status.outcomes[plan.order.indexOf(row.group)]; assert.ok(final);
      for (const field of ["nativeStatus", "appOutcomes", "report", "host", "cleanup"])
        if (Object.hasOwn(row, field)) assert.ok(isDeepStrictEqual(row[field], final[field]), "journal status differs");
    }
    assert.ok(isDeepStrictEqual(tree(folder), snapshot), "saved campaign mutated during validation");
    const complete = currentExecution && status.state === "finished" && collectionEntry && !replay.incomplete && !replay.pending.length
      && verifiedGroups.length === plan.order.length && verifiedGroups.every((g, i) => g.group === plan.order[i]) && !blockers.length;
    const loadLayout = groupScoped ? plan.bindings[0].resources.requestedCpuEnv?.CATALOG_LOAD_LAYOUT : undefined;
    const mode = groupScoped ? plan.bindings[0].campaignMode : undefined;
    const placement = alternateCampaignPlacements.includes(mode) ? mode : undefined;
    const common = { schema: groupScoped ? "benchmark-isolated-group-campaign-inspection/v1" : "benchmark-isolated-campaign-inspection/v1", scope: "intrinsic-evidence",
      round, commit, campaign: id, campaignSha256: plan.campaignSha256, sourceSha256: plan.sourceSha256,
      ...(loadLayout ? { loadLayout } : {}),
      ...(placement ? { placement } : {}),
      ...(supervisedTerminal ? { supervisedTerminal } : {}),
      selection: currentExecution ? { schema: registrySchema, groups: plan.bindings.map((b) => ({ group: b.request.group,
        contractSha256: b.selection.contractSha256, apps: b.selection.apps })) } : undefined, groups: verifiedGroups, blockers,
      collectionIntegrity: collectionEntry && !replay.incomplete && replay.pending.length === 0 ? "manifest-verified" : "unsealed-partial",
      commandLifecycle: replay.incomplete ? "incomplete-preserved" : "observed-terminal",
      uncollectedNativeRoots: replay.pending, archiveTreeSha256: snapshot.sha256,
      reservationSha256: digest(readRegular(join(folder, ".host-attempt.json"))) };
    if (complete) return { ...common, status: "verified" };
    // A sealed group can precede a halted campaign. Check its full commitment
    // above, but expose only dispositions until the whole archive is verified.
    return { ...common, status: replay.processFailure || status.outcomes.some((r) => r.outcome === "failed") ? "failed" : "blocked",
      groups: verifiedGroups.map((group) => ({ ...group, appOutcomes: group.appOutcomes.map(({ app, outcome }) =>
        ({ app, outcome, comparisonEligible: false })) })),
      round, commit, campaign: id, controllerReady: false, qualified: false, isolation: "unverified", blockers, diagnostics,
      collectionIntegrity: collectionEntry && !replay.incomplete && replay.pending.length === 0 ? "manifest-verified" : "unsealed-partial",
      commandLifecycle: replay.incomplete ? "incomplete-preserved" : "observed-terminal",
      uncollectedNativeRoots: replay.pending, deletionAuthorized: false, archiveTreeSha256: snapshot.sha256,
      reservationSha256: digest(readRegular(join(folder, ".host-attempt.json"))) };
  } catch {
    return { status: "invalid", controllerReady: false, qualified: false, deletionAuthorized: false, error: "saved-campaign-invalid" };
  }
}
