import { selectedApps } from "../workloads/registry.mjs";

export const scenarios = (group) => group === "live-delivery" ? ["normal", "slow-reader"]
  : ["normal", "disconnect", "missed-updates", "expired-cursor", "gap", "slow-reader"];

// These are separate application ports, not historical price-forwarding endpoints.
export const nativePorts = Object.freeze({
  express: { directory: "express", transport: "Express response SSE / browser EventSource", image: "cb-parity-live-express" },
  aspnet: { directory: "aspnet", transport: "TypedResults.ServerSentEvents / bounded Channel / browser EventSource", image: "cb-parity-live-aspnet" },
  gin: { directory: "gin", transport: "Gin SSEvent / bounded Go channel / browser EventSource", image: "cb-parity-live-gin" },
});

export function inventory(group) {
  return selectedApps(group).map((app) => ({ app, ...(nativePorts[app] ?? {}),
    implementation: nativePorts[app] ? "implemented" : "not-implemented",
    reason: nativePorts[app] ? "Native application port; qualification requires every scenario's browser evidence"
      : `Missing ${app} native keyed browser application, bounded queue/history instrumentation and recovery port under bench/live/apps; historical transport-only code is not parity`,
  }));
}

export const settingsFor = (group, scenario) => ({
  group, scenario, queueLimit: 2, historyLimit: 4, slowOutcome: "resnapshot",
  maxRecoveryMs: 10000, maxCleanupMs: 5000, cleanupObservationMs: 150,
  maxSlowMs: 10000, maxPublishLagMs: 5000,
});
