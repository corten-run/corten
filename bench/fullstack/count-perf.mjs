const events = {
  userPerRequest: "instructions:u",
  kernelPerRequest: "instructions:k",
  userCyclesPerRequest: "cycles:u",
  kernelCyclesPerRequest: "cycles:k",
  userL1iMissesPerRequest: "L1-icache-load-misses:u",
};

export function perfCountArgs(cpus, cgroup, out) {
  const names = Object.values(events);
  // perf maps the cgroups to events in order; each event needs its own entry.
  return ["stat", ...cpus, "-x", ",", "-o", out, "-e", names.join(","), "-G", names.map(() => cgroup).join(",")];
}

export function parsePerfCounts(text) {
  const counts = new Map();
  for (const line of text.split("\n")) {
    const [value, , event] = line.split(",");
    if (!event || !/^\d+$/.test(value.trim())) continue;
    // Some perf versions omit :u when displaying a generic cache event.
    const name = event === "L1-icache-load-misses" ? events.userL1iMissesPerRequest : event;
    counts.set(name, Number(value));
  }
  return counts;
}

export function countRow(counts, requests, failed) {
  const row = { requests, failed };
  for (const [field, event] of Object.entries(events)) {
    const count = counts.get(event);
    row[field] = Number.isFinite(count) ? Math.round(count / requests) : null;
  }
  return row;
}
