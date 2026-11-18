// Small synthetic stock-output-shaped fixtures. NOT native observation or source audit.
export function fixedFixture({ responses = ["ok", "ok", "ok"], drops = 0 } = {}) {
  const epoch = Date.parse("2026-11-17T00:00:00Z"), names = new Map(), entries = [];
  const metrics = {}, root = {}, records = {};
  const durationMs = Math.max(1001, Math.floor((responses.length - 1) * 1000 / 3) + 10);
  const point = (name, type, value, tags = {}, elapsed = 20) => {
    if (!names.has(name)) {
      names.set(name, type); records[name] = [];
      entries.push({ type: "Metric", metric: name, data: { name, type, contains: "default", thresholds: [], submetrics: null } });
    }
    records[name].push(value);
    entries.push({ type: "Point", metric: name, data: { time: new Date(epoch + elapsed).toISOString(), value, tags } });
  };
  for (const name of ["json_ok", "json_timeout", "json_http_error", "json_invalid", "json_start_capped"]) point(name, "counter", 0);
  const total = responses.length;
  for (let i = 0; i < total; i++) {
    const response = responses[i], elapsedNs = Math.floor(i * 1e9 / 3) + 1000, ms = elapsedNs / 1e6;
    const time = 10 + Math.floor(ms);
    point("json_started", "counter", 1, {}, time);
    for (const [key, value] of Object.entries({ before_ms: ms + 5, after_ms: ms + 5.000001, progress_ns: Math.min(elapsedNs, 1e9),
      scenario_ms: epoch + 10, ...(elapsedNs < 1e9 ? { origin_lower_ns: 4_999_998, origin_upper_ns: 5_000_003 } : {}) })) point(`json_start_${key}`, "gauge", value, {}, time);
    if (elapsedNs >= 1e9) point("json_start_capped", "counter", 1, {}, time);
    const status = response === "ok" ? 200 : response === "timeout" ? 0 : response === "http429" ? 429 : response === "invalid" ? 302 : 503;
    const outcome = response.startsWith("http") ? "http_error" : response;
    const tags = { status: String(status), error_code: response === "timeout" ? "1050" : status >= 400 ? String(1000 + status) : "0" };
    point(`json_${outcome}`, "counter", 1, tags, time + 4);
    point("http_reqs", "counter", 1, tags, time + 4); point("iterations", "counter", 1, {}, time + 4);
    point("http_req_duration", "trend", 4, {}, time + 4);
    point("http_req_failed", "rate", response === "ok" || response === "invalid" ? 0 : 1, {}, time + 4);
    for (const name of ["JSON status 200", "JSON content type"]) {
      const pass = name === "JSON status 200" ? status === 200 : status !== 0;
      point("checks", "rate", pass ? 1 : 0, { check: name }, time + 4);
      const check = root[name] ??= { passes: 0, fails: 0 }; check[pass ? "passes" : "fails"]++;
    }
  }
  for (let i = 0; i < drops; i++) point("dropped_iterations", "counter", 1, {}, 999);
  for (const [name, type] of names) {
    const values = records[name], sum = values.reduce((a, b) => a + b, 0);
    metrics[name] = type === "counter" ? { count: sum, rate: sum * 1000 / durationMs }
      : type === "rate" ? { rate: sum / values.length, passes: sum, fails: values.length - sum }
      : type === "gauge" ? { value: values.at(-1), min: Math.min(...values), max: Math.max(...values) }
      : { avg: 4, "p(50)": 4, "p(95)": 4, "p(99)": 4, max: 4 };
  }
  metrics.dropped_iterations ??= { count: 0, rate: 0 };
  const failed = responses.some((r) => r !== "ok"), code = failed || drops ? 99 : 0;
  for (const [key, rule, crossed] of [["http_req_failed", "rate==0", failed], ["checks", "rate==1", failed], ["dropped_iterations", "count==0", drops > 0]])
    metrics[key].thresholds = { [rule]: crossed };
  return { entries, bytes: () => Buffer.from(entries.map((v) => JSON.stringify(v) + "\n").join("")), summary: { metrics, root_group: { checks: root } },
    clock: { schema: "json-api-fixed-clock/v1", k6DurationMs: durationMs, metrics: Object.fromEntries(Object.entries(metrics).filter(([name]) => name.startsWith("json_")).map(([name, values]) => [name, { values }])) },
    config: { phase: "fixed", seconds: 1, rate: 3 }, command: { exit: { code, signal: null, expired: false, interrupted: false },
      clock: { startedAt: epoch, finishedAt: epoch + durationMs + 15 }, ioErrors: [], stderrBytes: 0 }, logs: "" };
}
