import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { classes, formEnv, kinds, mergedMixed, mixedOf } from "./mixed.mjs";
import { ssrOf } from "./ssr.mjs";

const page = '<form method="post" action="/items/item_1/alerts"><input type="hidden" name="csrf" value="t"><input name="price"></form>';

test("the form is posted where and as the page posts it, with its cookies and the app's own origin", () => {
  const direct = formEnv(page, "session=abc", { host: "localhost:18410", origin: "http://localhost:18410" });
  assert.deepEqual(direct, {
    env: { FORM_PATH: "/items/item_1/alerts", FORM_TYPE: "application/x-www-form-urlencoded", FORM_BODY: "csrf=t&price=1", ORIGIN: "http://localhost:18410", FORM_COOKIE: "session=abc", FORM_HOST: "localhost:18410" },
  });
  // Through the edge, which names the app itself: no Host of the post's own, and no cookies to send.
  const edged = formEnv(page, "", { origin: "http://fsw-corten:8080" });
  assert.ok("env" in edged);
  assert.equal(edged.env.FORM_HOST, undefined);
  assert.equal(edged.env.FORM_COOKIE, undefined);
  assert.equal(edged.env.ORIGIN, "http://fsw-corten:8080");
});

test("with no form to post, it says why, and the posts' share asks for pages", () => {
  const own = { origin: "http://x" };
  assert.deepEqual(formEnv(null, "", own), { none: "the page did not answer" });
  assert.deepEqual(formEnv("<p>no form</p>", "", own), { none: "no form that posts" });
  assert.deepEqual(formEnv('<form method="post" phx-submit="alert"></form>', "", own), { none: "phx-submit (sent by its script)" });
});

/**
 * A k6 summary of the mixed phase: `counts` its counters, every kind's latency 1/9 ms. Its run
 * took 75 s, the phase's 60 and 15 waiting for late answers, which k6's rate is over.
 */
const k6 = (/** @type {Record<string, number>} */ counts, dropped = 0) => {
  const sent = Object.values(counts).reduce((a, b) => a + b, 0);
  /** @type {Record<string, any>} */
  const metrics = { http_reqs: { count: sent, rate: sent / 75 }, dropped_iterations: { count: dropped } };
  for (const [key, count] of Object.entries(counts)) {
    metrics[key] = { count, rate: count / 60 };
    metrics[key.replace(/_[a-z]+$/, "_ms")] = { "p(50)": 1, "p(99)": 9 };
  }
  return { metrics };
};

/** A raw folder with an "api" load folder, removed after `body`. @param {(raw: string, put: (file: string, value: unknown) => void) => void} body */
function withRaw(body) {
  const raw = mkdtempSync(join(tmpdir(), "mixed-test-"));
  try {
    mkdirSync(join(raw, "api"));
    body(raw, (file, value) => writeFileSync(join(raw, "api", file), JSON.stringify(value)));
  } finally {
    rmSync(raw, { recursive: true, force: true });
  }
}

test("a pass reads each kind's latency and answers, the rate, and the app's CPU over the phase", () => {
  withRaw((raw, put) => {
    // 9,000 requests in 60 s: deadlines answered 5xx, posts past the write limit 429.
    put("corten-mixed.json", k6({ page_ok: 6174, slow_ok: 0, slow_failed: 126, json_ok: 1800, home_ok: 450, post_ok: 60, post_limited: 390 }, 9));
    put("corten-mixed-cpu.json", { "fsw-corten": { usec: 12e6 } });
    put("corten-mixed-stats.json", { "fsw-corten": { memMaxMiB: 40 } });
    put("corten-mixed-form.json", { path: "/items/item_1/alerts", type: "application/x-www-form-urlencoded" });
    const m = /** @type {NonNullable<ReturnType<typeof mixedOf>>} */ (mixedOf(join(raw, "api"), "corten", "corten-mixed"));
    // Over the phase's 60 s, not the 75 the run took: the wait for late answers is not a shortfall.
    assert.equal(m.rps, 150);
    assert.equal(m.unsentPct, 0.1);
    // 12 CPU-seconds over 60 seconds.
    assert.equal(m.cpuUsedPct, 20);
    assert.equal(m.memMaxMiB, 40);
    assert.deepEqual(m.byKind.slow, { sent: 126, p50: 1, p99: 9, ok: 0, limited: 0, refused: 0, failed: 126, none: 0 });
    assert.equal(m.byKind.post.limited, 390);
    assert.equal(m.form.path, "/items/item_1/alerts");
    assert.equal(mixedOf(join(raw, "api"), "corten", "corten-mixed-p2"), null, "a pass with no files is none");
  });
});

test("a kind no request was sent as is left out, and an app's form that was not posted says why", () => {
  withRaw((raw, put) => {
    put("phoenix-mixed.json", k6({ page_ok: 7000, json_ok: 1800, home_ok: 450 }));
    put("phoenix-mixed-form.json", { none: "phx-submit (sent by its script)" });
    const m = /** @type {NonNullable<ReturnType<typeof mixedOf>>} */ (mixedOf(join(raw, "api"), "phoenix", "phoenix-mixed"));
    assert.equal(m.byKind.post, undefined);
    assert.equal(m.cpuUsedPct, null, "no counted CPU, none said");
    assert.equal(m.form.none, "phx-submit (sent by its script)");
  });
});

test("passes merge to their medians, unsent at its worst, and say when some are missing", () => {
  withRaw((raw, put) => {
    put("corten-mixed.json", k6({ page_ok: 9000, post_limited: 10 }));
    put("corten-mixed-p2.json", k6({ page_ok: 8700, post_limited: 30 }, 300));
    const folder = join(raw, "api");
    const runs = /** @type {NonNullable<ReturnType<typeof mixedOf>>[]} */ ([mixedOf(folder, "corten", "corten-mixed"), mixedOf(folder, "corten", "corten-mixed-p2")]);
    const m = mergedMixed(runs, 3);
    assert.equal(m.passes, 2);
    assert.equal(m.asked, 3);
    assert.equal(m.byKind.post.limited, 10, "of two, the lower middle one: a value a pass measured");
    assert.equal(m.unsentPct, Math.max(runs[0].unsentPct, runs[1].unsentPct));
  });
});

test("the summary has the mixed phase for item pages from the item API only", () => {
  withRaw((raw, put) => {
    put("corten-startup.json", { firstOkMsFromDockerRun: 100 });
    put("corten-fixed.json", { metrics: { http_reqs: { rate: 150, count: 9000 }, dropped_iterations: { count: 0 }, http_req_failed: { value: 0 }, http_req_duration: { "p(50)": 1, "p(95)": 2, "p(99)": 3 } } });
    put("corten-mixed.json", k6({ page_ok: 9000 }));
    put("corten-json-mixed.json", k6({ page_ok: 9000 }));
    const ssr = ssrOf(raw, ["corten"]);
    assert.equal(ssr.api.corten.mixed.byKind.page.sent, 9000);
    assert.equal(ssr["api-json"].corten, undefined, "the JSON source has no mixed phase");
  });
});

test("mixed-load.js sends and counts the kinds and classes this module reads", () => {
  const script = readFileSync(fileURLToPath(new URL("./mixed-load.js", import.meta.url)), "utf8");
  assert.ok(script.includes(`const kinds = ${JSON.stringify(kinds).replaceAll(",", ", ")};`), "mixed-load.js's kinds");
  assert.ok(script.includes(`const classes = ${JSON.stringify(classes).replaceAll(",", ", ")};`), "mixed-load.js's classes");
});

// A server that never answers fails at the timeout, which ends it and its requests.
test("the item API answers a late item as the item, after SLOW_MS, and an unknown one at once", { timeout: 10_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mixed-api-"));
  /** @type {import("node:child_process").ChildProcess | undefined} */
  let server;
  try {
    const items = join(dir, "items.json");
    writeFileSync(items, JSON.stringify({ item_3: { id: "item_3" } }));
    // The server runs with a preload that holds each timer it sets until the test writes "release"
    // to its input, and writes to its output each timer it sets or clears and each answer it ends,
    // with whether it ended inside a released timer's callback. Which answer waits, and on what,
    // is read from the server, and no answer is held to a time a busy machine can cross.
    const timers = join(dir, "timers.mjs");
    writeFileSync(
      timers,
      [
        'import { ServerResponse } from "node:http";',
        "const held = new Map();",
        "let last = 0;",
        "let inTimer = false;",
        "globalThis.setTimeout = (f, ms, ...a) => { const id = ++last; held.set(id, () => f(...a)); process.stdout.write(`timer ${ms}\\n`); return id; };",
        "globalThis.clearTimeout = (id) => { held.delete(id); process.stdout.write(`cleared ${id}\\n`); };",
        "const end = ServerResponse.prototype.end;",
        'ServerResponse.prototype.end = function (...a) { process.stdout.write(`answered ${this.statusCode} ${this.req?.url} ${inTimer ? "in its timer" : "at once"}\\n`); return end.apply(this, a); };',
        'process.stdin.setEncoding("utf8").on("data", (line) => { if (!line.includes("release")) return; const due = [...held.values()]; held.clear(); for (const f of due) { inTimer = true; try { f(); } finally { inTimer = false; } } });',
        "",
      ].join("\n"),
    );
    // A port free a moment ago, for the server to listen on.
    const port = await new Promise((done) => {
      const probe = createServer().listen(0, "127.0.0.1", () => {
        const { port } = /** @type {import("node:net").AddressInfo} */ (probe.address());
        probe.close(() => done(port));
      });
    });
    const child = spawn(process.execPath, ["--import", pathToFileURL(timers).href, fileURLToPath(new URL("./item-api/server.mjs", import.meta.url)), items, String(port), "1"], { env: { ...process.env, SLOW_MS: "300" }, stdio: ["pipe", "pipe", "inherit"], signal: t.signal, killSignal: "SIGKILL" });
    server = child;
    let output = "";
    let ended = false;
    child.stdout.setEncoding("utf8").on("data", (chunk) => (output += chunk));
    child.stdout.once("close", () => (ended = true));
    /** The server's next output, or a failure once its output has ended. */
    const more = () =>
      new Promise((heard, gone) => {
        if (ended) return gone(new Error("the item API ended"));
        const data = () => {
          child.stdout.off("close", close);
          heard(undefined);
        };
        const close = () => {
          child.stdout.off("data", data);
          gone(new Error("the item API ended"));
        };
        child.stdout.once("data", data);
        child.stdout.once("close", close);
      });
    // It says how many items it serves once it listens; a server that ends first fails the test.
    while (!/items on/.test(output)) await more();
    /** What the server has said since it listened, a record a line, each line once it is whole. */
    const said = () =>
      output
        .slice(0, output.lastIndexOf("\n") + 1)
        .split("\n")
        .filter((line) => line !== "" && !/items on/.test(line));
    /** Waits until the server has said `records`, failing at the first record it says otherwise. */
    const heard = async (/** @type {string[]} */ records) => {
      for (;;) {
        const now = said();
        assert.deepEqual(now, records.slice(0, now.length), "what the item API did");
        if (now.length === records.length) return;
        await more();
      }
    };
    const url = (/** @type {string} */ id) => `/api/discovery/items/${id}`;
    const at = (/** @type {string} */ id) => {
      const answer = fetch(`http://127.0.0.1:${port}${url(id)}`, { signal: t.signal }).then(async (r) => ({ status: r.status, body: await r.text() }));
      answer.catch(() => {});
      return answer;
    };
    // The late item sets one timer of SLOW_MS and is not answered while it is held.
    const late = at("item_slow_3");
    const records = ["timer 300"];
    await heard(records);
    // While it is held, the item and an unknown one are answered at once, with no timer set.
    const item = at("item_3");
    records.push(`answered 200 ${url("item_3")} at once`);
    await heard(records);
    const now = await item;
    assert.equal(now.status, 200);
    assert.equal(now.body, JSON.stringify({ id: "item_3" }), "the item as the file has it");
    const unknown = at("item_slow_9");
    records.push(`answered 404 ${url("item_slow_9")} at once`);
    await heard(records);
    assert.equal((await unknown).status, 404);
    // Releasing its timer is what answers the late item, as the item.
    child.stdin.write("release\n");
    records.push(`answered 200 ${url("item_slow_3")} in its timer`);
    await heard(records);
    const answered = await late;
    assert.equal(answered.status, 200);
    assert.equal(answered.body, now.body, "the late item is the item");
  } finally {
    server?.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});
