import { selectedApps } from "../workloads/registry.mjs";
import { createLiveWorkload } from "../workloads/live.mjs";
import assert from "node:assert/strict";

export const scenarios = (group) => group === "live-delivery" ? ["normal", "slow-reader"]
  : ["normal", "disconnect", "missed-updates", "expired-cursor", "gap", "slow-reader"];

// Immutable inventory identity of the original checked-in v1 captures.
const legacyPorts = Object.freeze({
  express: { directory: "express", transport: "Express response SSE / browser EventSource", image: "cb-parity-live-express" },
  aspnet: { directory: "aspnet", transport: "TypedResults.ServerSentEvents / bounded Channel / browser EventSource", image: "cb-parity-live-aspnet" },
  gin: { directory: "gin", transport: "Gin SSEvent / bounded Go channel / browser EventSource", image: "cb-parity-live-gin" },
});

// These are separate application ports, not historical price-forwarding endpoints.
export const nativePorts = Object.freeze({ ...legacyPorts,
  corten: { directory: "corten", transport: "corten_feed::Feed / native subscribe() and keyed views / browser EventSource", image: "cb-parity-live-corten",
    profiles: ["native-feed"], wire: "corten-feed", rootContext: true, dockerfile: "Dockerfile.parity", buildTimeoutMs: 1200000 },
});

export function portFor(app, profile = "bounded") {
  const port = nativePorts[app];
  return !port?.profiles || port.profiles.includes(profile) ? port : undefined;
}

export function inventory(group, profile = "bounded", version = 2) {
  const registered = (app) => (version === 1 ? legacyPorts : nativePorts)[app];
  return selectedApps(group).map((app) => ({ app, ...(registered(app) ?? {}),
    implementation: registered(app) ? "implemented" : "not-implemented",
    reason: registered(app) ? portFor(app, profile) ? "Native application port; qualification requires every scenario's browser evidence"
      : `Native ${app} port requires explicit --profile ${registered(app).profiles.join(",")}; not run in ${profile} profile`
      : `Missing ${app} native keyed browser application, bounded queue/history instrumentation and recovery port under bench/live/apps; historical transport-only code is not parity`,
  }));
}

// A later registration cannot turn a capture's missing row into an implementation.
export function recordedInventory(group, entries, profile, version) {
  if (version === 1) { assert.deepEqual(entries, inventory(group, profile, 1)); return entries; }
  assert.deepEqual(entries.map((r) => r.app), selectedApps(group), "recorded inventory lost a candidate");
  for (const entry of entries) {
    if (entry.implementation === "not-implemented") {
      assert.deepEqual(entry, { app: entry.app, implementation: "not-implemented",
        reason: `Missing ${entry.app} native keyed browser application, bounded queue/history instrumentation and recovery port under bench/live/apps; historical transport-only code is not parity` });
    } else {
      assert.equal(entry.implementation, "implemented");
      const port = nativePorts[entry.app]; assert.ok(port, "unknown native registration");
      for (const [key, value] of Object.entries(entry)) if (!["app", "implementation", "reason"].includes(key)) {
        assert.deepEqual(value, port[key], `changed native registration identity: ${entry.app}/${key}`);
      }
      for (const key of ["directory", "transport", "image"]) assert.equal(entry[key], port[key]);
      assert.equal(typeof entry.reason, "string");
    }
  }
  return entries;
}

export function workloadFor(profile = "bounded") {
  if (!["bounded", "native-feed"].includes(profile)) throw new Error(`unknown live profile: ${profile}`);
  return createLiveWorkload({ seed: 17, rowCount: 5, eventCount: profile === "native-feed" ? 1044 : 24 });
}

export const settingsFor = (group, scenario, profile = "bounded") => ({
  group, scenario, queueLimit: profile === "native-feed" ? 1024 : 2, historyLimit: profile === "native-feed" ? 1025 : 4, slowOutcome: "resnapshot",
  maxRecoveryMs: 10000, maxCleanupMs: 5000, cleanupObservationMs: 150,
  maxSlowMs: 10000, maxPublishLagMs: 5000,
});
