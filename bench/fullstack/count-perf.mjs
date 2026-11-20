const instructions = {
  userPerRequest: "instructions:u",
  kernelPerRequest: "instructions:k",
};
const events = {
  ...instructions,
  userCyclesPerRequest: "cycles:u",
  kernelCyclesPerRequest: "cycles:k",
  userL1iMissesPerRequest: "L1-icache-load-misses:u",
};
const eventNames = Object.values(events);

export function perfCountArgs(cpus, cgroup, instructionsOnly = false) {
  const names = instructionsOnly ? Object.values(instructions) : eventNames;
  // perf maps the cgroups to events in order; each event needs its own entry.
  return ["stat", ...cpus, "-x", ",", "--log-fd", "1", "-e", names.join(","), "-G", names.map(() => cgroup).join(",")];
}

export function parsePerfCounts(text) {
  const counts = new Map();
  for (const line of text.split("\n")) {
    const [value, , event, , , running] = line.split(",");
    // Some perf versions omit :u when displaying a generic cache event.
    const name = event === "L1-icache-load-misses" ? events.userL1iMissesPerRequest : event;
    if (!eventNames.includes(name)) continue;
    const raw = value.trim();
    const runningPct = /^\d+(?:\.\d+)?$/.test(running?.trim() ?? "") ? Number(running) : null;
    const count = /^\d+$/.test(raw) ? Number(raw) : null;
    counts.set(name, { count, runningPct, error: count === null ? raw || "missing count" : null });
  }
  return counts;
}

function countError(entry) {
  if (!entry) return "no perf row";
  if (entry.error) return entry.error;
  if (entry.runningPct === null) return "missing or invalid perf running percentage";
  return entry.runningPct === 100 ? null : `perf ran ${entry.runningPct}% of enabled time (need 100%)`;
}

export async function measurePerfCounts(collect, warn) {
  const attempt = async (instructionsOnly) => {
    const { text, error } = await collect(instructionsOnly);
    const counts = parsePerfCounts(text);
    const missing = Object.values(instructions).flatMap((event) => {
      const reason = countError(counts.get(event));
      return reason ? [`${event}: ${reason}`] : [];
    });
    return { counts, error: error || missing.join("; ") };
  };
  const full = await attempt(false);
  if (!full.error) return full.counts;
  // Drop optional events that may have prevented perf from starting or crowded out instructions.
  warn(`${full.error}; retrying with instructions only`);
  const required = await attempt(true);
  if (required.error) throw new Error(`instructions-only perf failed: ${required.error}`);
  return required.counts;
}

export function countRow(counts, requests, failed) {
  const row = { requests, failed };
  const perfRunningPct = {};
  const perfDiagnostics = {};
  for (const [field, event] of Object.entries(events)) {
    const entry = counts.get(event);
    const error = countError(entry);
    perfRunningPct[event] = entry?.runningPct ?? null;
    if (error) perfDiagnostics[event] = error;
    // perf already scales counts, so only normalize by the number of requests here.
    row[field] = error ? null : Math.round(entry.count / requests);
  }
  return { ...row, perfRunningPct, perfDiagnostics };
}
