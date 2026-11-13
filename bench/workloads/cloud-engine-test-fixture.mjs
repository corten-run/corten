// Existing engine controls use only synthetic credentials and fake providers.
// Node's process-isolated test runner enables SIGUSR2 diagnostic reports itself;
// turn off that runner-only facility here so it does not intentionally trip the
// production guard. Real worker diagnostic controls run in separate processes.
import { after } from "node:test";
const reportOnSignal = process.report.reportOnSignal;
process.report.reportOnSignal = false;
after(() => { process.report.reportOnSignal = reportOnSignal; });
export const { createProviderEngine } = await import("./cloud-provider-engine.mjs");
