import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
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

/**
 * A fresh instance of the item API (mixed-item-api.worker.mjs), run in a worker thread as `node
 * server.mjs <items> 0 1` with SLOW_MS 300, its timers held or not; `end` terminates it, whatever
 * state its import, timers and listeners are in. Each call waits on its reply until `signal` or 5 s.
 */
const instance = (/** @type {string} */ items, /** @type {boolean} */ held, /** @type {AbortSignal} */ signal) => {
  const worker = new Worker(new URL("./mixed-item-api.worker.mjs", import.meta.url), {
    argv: [items, "0", "1"],
    env: { SLOW_MS: "300" },
    workerData: { file: new URL("./item-api/server.mjs", import.meta.url).href, held },
  });
  /** @type {Map<number, { done: (reply: any) => void, failed: (error: Error) => void }>} */
  const waiting = new Map();
  /** @type {Error | undefined} */
  let fault;
  const fail = (/** @type {Error} */ error) => {
    fault ??= error;
    for (const one of waiting.values()) one.failed(fault);
    waiting.clear();
  };
  worker.on("message", ({ re, error, ...reply }) => {
    const one = waiting.get(re);
    waiting.delete(re);
    if (error) one?.failed(new Error(error));
    else one?.done(reply);
  });
  worker.on("error", fail);
  worker.on("exit", (code) => fail(new Error(`the item API's worker exited (${code})`)));
  const reply = (/** @type {number} */ re, /** @type {string} */ what) => {
    const bound = AbortSignal.any([signal, AbortSignal.timeout(5_000)]);
    return /** @type {Promise<any>} */ (
      new Promise((done, failed) => {
        if (fault) return failed(fault);
        const stop = () => {
          waiting.delete(re);
          failed(new Error(`${what}: ${bound.reason?.message ?? bound.reason}`));
        };
        if (bound.aborted) return stop();
        bound.addEventListener("abort", stop, { once: true });
        const off = () => bound.removeEventListener("abort", stop);
        waiting.set(re, { done: (r) => (off(), done(r)), failed: (e) => (off(), failed(e)) });
      })
    );
  };
  let last = 0;
  const send = (/** @type {Record<string, unknown>} */ message, /** @type {string} */ what) => {
    worker.postMessage({ re: ++last, ...message });
    return reply(last, what);
  };
  return {
    loaded: reply(0, "the item API did not load and listen"),
    /** Its handling, as `key`, of a request for `id`, and what it holds by the next check of the event loop. */
    ask: (/** @type {string} */ key, /** @type {string} */ id) => send({ op: "ask", key, url: `/api/discovery/items/${id}` }, `asking for ${id}`),
    /** Held timer `id` released, and what it holds by the next check of the event loop. */
    release: (/** @type {number} */ id) => send({ op: "release", id }, `releasing timer ${id}`),
    end: () => worker.terminate(),
  };
};

// The item API's own file, unchanged (the benchmark measures it as it is). In each held instance
// every timer it sets is held and tied to the request whose handling set it, and each send of an
// answer is recorded with the held timer whose callback made it, so which answer waits, and on what,
// is read from the server, with no time a busy machine can cross. "At once" here means ended by the
// next check of the event loop without waiting on any timer: an answer deferred by promises or
// setImmediate counts. Every case has its own instance.
test("the item API ends a late item as the item from its own SLOW_MS timer alone, and the others by the next check of the event loop without waiting on it", { timeout: 30_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mixed-api-"));
  const items = join(dir, "items.json");
  writeFileSync(items, JSON.stringify({ item_3: { id: "item_3" }, item_4: { id: "item_4", name: "another" } }));
  const json = (/** @type {string} */ id) => JSON.stringify({ id });
  /** @typedef {{ timers: { id: number, ms: number, by: string | null, cleared: boolean, released: boolean }[], answers: Record<string, { sends: { name: string, timer: number | null }[], status: number, body: string, ended: boolean }> }} Held */
  const set = (/** @type {Held} */ held) => held.timers.map((one) => `${one.ms} ms for ${one.by ?? "no request"}${one.cleared ? ", cleared" : ""}${one.released ? ", released" : ""}`);
  /** The late item ended, whole and as the item, from timer `id`'s callback and nothing else. */
  const endedFrom = (/** @type {Held} */ held, /** @type {string} */ key, /** @type {number} */ id) => {
    const late = held.answers[key];
    assert.ok(late.ended, "releasing its timer ended the late item");
    assert.deepEqual(late.sends.filter((one) => one.timer !== id).map((one) => one.name), [], "every send of the late answer made from its own released timer");
    assert.equal(late.status, 200);
    assert.equal(late.body, json("item_3"), "the late item is the item as the file has it");
  };
  /** `body` with a fresh held instance, terminated after. @param {(api: ReturnType<typeof instance>) => Promise<void>} body */
  const held = (body) => async (/** @type {import("node:test").TestContext} */ t) => {
    const api = instance(items, true, t.signal);
    try {
      await api.loaded;
      await body(api);
    } finally {
      await api.end();
    }
  };
  try {
    await t.test(
      "a late item alone sets one SLOW_MS timer, the only one, and ends from it",
      held(async (api) => {
        let now = await api.ask("late", "item_slow_3");
        assert.deepEqual(set(now), ["300 ms for late"], "the timers the item API set");
        assert.deepEqual(now.answers.late.sends, [], "nothing of the late answer sent while its timer is held");
        now = await api.release(now.timers[0].id);
        endedFrom(now, "late", now.timers[0].id);
        assert.deepEqual(set(now), ["300 ms for late, released"], "no other timer set");
      }),
    );
    await t.test(
      "with the instance's first late item held, the item and an unknown one end at once from no timer",
      held(async (api) => {
        let now = await api.ask("late", "item_slow_3");
        for (const [key, id, status] of /** @type {const} */ ([["item", "item_3", 200], ["unknown", "item_slow_9", 404]])) {
          now = await api.ask(key, id);
          assert.ok(now.answers[key].ended, `ended ${id} at once`);
          assert.equal(now.answers[key].status, status);
          assert.deepEqual(now.answers[key].sends.filter((one) => one.timer !== null), [], "sent from no timer");
        }
        assert.equal(now.answers.item.body, json("item_3"), "the item as the file has it");
        assert.deepEqual(set(now), ["300 ms for late"], "no timer set by an at-once answer");
        assert.deepEqual(now.answers.late.sends, [], "the late answer still held");
        now = await api.release(now.timers[0].id);
        endedFrom(now, "late", now.timers[0].id);
      }),
    );
    await t.test("over HTTP, with its real timers", async (t) => {
      const api = instance(items, false, t.signal);
      try {
        const { port } = await api.loaded;
        const at = async (/** @type {string} */ id) => {
          const r = await fetch(`http://127.0.0.1:${port}/api/discovery/items/${id}`, { signal: AbortSignal.any([t.signal, AbortSignal.timeout(5_000)]) });
          return { status: r.status, body: await r.text() };
        };
        const [now, late, unknown] = await Promise.all([at("item_3"), at("item_slow_3"), at("item_slow_9")]);
        assert.deepEqual(now, { status: 200, body: json("item_3") });
        assert.deepEqual(late, now, "the late item is the item");
        assert.equal(unknown.status, 404);
      } finally {
        await api.end();
      }
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});