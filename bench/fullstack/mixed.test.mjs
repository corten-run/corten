import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
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

/** `promise`, or a failure naming `what` once `signal` aborts or 5 s pass. */
const within = (/** @type {Promise<any>} */ promise, /** @type {string} */ what, /** @type {AbortSignal | undefined} */ signal) => {
  const bound = signal ? AbortSignal.any([signal, AbortSignal.timeout(5_000)]) : AbortSignal.timeout(5_000);
  return /** @type {Promise<any>} */ (
    new Promise((done, failed) => {
      const stop = () => failed(new Error(`${what}: ${bound.reason?.message ?? bound.reason}`));
      if (bound.aborted) return stop();
      bound.addEventListener("abort", stop, { once: true });
      promise.then(
        (value) => (bound.removeEventListener("abort", stop), done(value)),
        (error) => (bound.removeEventListener("abort", stop), failed(error)),
      );
    })
  );
};

/**
 * A fresh instance of the item API (mixed-item-api.child.mjs), in a child process forked with the
 * arguments `<items> 0 1` and SLOW_MS 300, its timers held or not, so the server reads the argv
 * `node server.mjs <items> 0 1` gives it. It is driven over IPC; this process's globals, argv and
 * env are left as they are. Each wait on a reply ends at `signal` or 5 s; `end` kills the process
 * with SIGKILL, whatever it is doing, and waits at most 5 s for it to exit.
 */
const instance = (/** @type {string} */ items, /** @type {boolean} */ held, /** @type {AbortSignal} */ signal) => {
  const { ITEM_API_SERVER: _server, NODE_TEST_CONTEXT: _context, ...env } = process.env;
  const child = fork(fileURLToPath(new URL("./mixed-item-api.child.mjs", import.meta.url)), [items, "0", "1"], {
    env: { ...env, SLOW_MS: "300", MIXED_ITEM_API_HELD: held ? "1" : "0" },
    execArgv: [],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8").on("data", (/** @type {string} */ text) => (stderr = (stderr + text).slice(-4_000)));
  /** @type {Map<number, { done: (reply: any) => void, failed: (error: Error) => void }>} */
  const waiting = new Map();
  /** @type {Error | undefined} */
  let fault;
  const fail = (/** @type {Error} */ error) => {
    fault ??= error;
    for (const one of waiting.values()) one.failed(fault);
    waiting.clear();
  };
  /** @type {Promise<void>} */
  const exited = new Promise((done) => {
    child.on("exit", (code, killed) => {
      fail(new Error(`the item API's process exited (${killed ?? code})${stderr ? `: ${stderr}` : ""}`));
      done();
    });
    child.on("error", (error) => {
      fail(error);
      if (child.pid === undefined) done();
    });
  });
  // The server's own process.send (its item count once it listens) is not one of these.
  child.on("message", (/** @type {any} */ message) => {
    if (message?.harness !== "mixed-item-api") return;
    const { harness: _, re, error, ...reply } = message;
    const one = waiting.get(re);
    waiting.delete(re);
    if (error) one?.failed(new Error(error));
    else one?.done(reply);
  });
  const reply = (/** @type {number} */ re, /** @type {string} */ what) => {
    const answer = new Promise((done, failed) => (fault ? failed(fault) : waiting.set(re, { done, failed })));
    answer.catch(() => {});
    return within(answer, what, signal);
  };
  let last = 0;
  const send = (/** @type {Record<string, unknown>} */ message, /** @type {string} */ what) => {
    const re = ++last;
    const answer = reply(re, what);
    child.send({ re, ...message }, (error) => error && fail(error));
    return answer;
  };
  return {
    loaded: reply(0, "the item API did not load and listen"),
    /** What it holds, once the handling of a request for `id` has set a timer. */
    until: (/** @type {string} */ id) => send({ op: "until", by: id }, `waiting for a timer set for ${id}`),
    /** What it holds by the next check of the event loop. */
    state: () => send({ op: "state" }, "asking what it holds"),
    /** Held timer `id` released. */
    release: (/** @type {number} */ id) => send({ op: "release", id }, `releasing timer ${id}`),
    end: async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      // A process the server started may hold the IPC channel after this one exits; let it go.
      if (child.connected) child.disconnect();
      try {
        await within(exited, "the item API's process did not exit after SIGKILL", undefined);
      } finally {
        child.stderr?.destroy();
      }
    },
  };
};

/**
 * A GET of item `id` from the instance on `port`, on its own connection, cancelled with `signal`:
 * whether its answer's head has arrived yet, and its whole answer.
 */
const get = (/** @type {number} */ port, /** @type {string} */ id, /** @type {AbortSignal} */ signal) => {
  const seen = { headed: false };
  /** @type {Promise<{ status: number | undefined, type: string | undefined, length: string | undefined, body: string }>} */
  const whole = new Promise((done, failed) => {
    const req = request({ host: "127.0.0.1", port, path: `/api/discovery/items/${id}`, agent: false, signal }, (res) => {
      seen.headed = true;
      /** @type {Buffer[]} */
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => done({ status: res.statusCode, type: res.headers["content-type"], length: res.headers["content-length"], body: Buffer.concat(chunks).toString() }));
      res.on("error", failed);
      res.on("close", () => res.complete || failed(new Error(`the answer for ${id} was cut off`)));
    });
    req.on("error", failed);
    req.end();
  });
  whole.catch(() => {});
  return { seen, whole };
};

// The item API's own file, unchanged (the benchmark measures it as it is), asked over HTTP. In each
// held instance every timer it sets through the global or node:timers setTimeout is held and tied to
// the request whose handling set it, and each send of an answer is recorded with the held timer
// whose callback made it, so which answer waits, and on what, is read from the server, and what has
// arrived is read from the client. The test asserts order, not latency: no answer is held to a time,
// and the only times are the 5 s bounds on each wait. Only setTimeout is held, so a wait made another
// way (node:timers/promises, setImmediate) is not seen: "at once" means received whole while the late
// item's timer is still held, and the late answer is sent from within its timer's callback, which may
// itself wait some other way first. Every case has its own instance.
test("the item API answers a late item as the item from within its own SLOW_MS timer, and the others whole while that timer is held", { timeout: 30_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mixed-api-"));
  try {
    const items = join(dir, "items.json");
    writeFileSync(items, JSON.stringify({ item_3: { id: "item_3" }, item_4: { id: "item_4", name: "another" } }));
    const body = JSON.stringify({ id: "item_3" });
    const item = { status: 200, type: "application/json", length: String(body.length), body };
    /** @typedef {{ timers: { id: number, ms: number, by: string | null, cleared: boolean, released: boolean }[], sends: Record<string, { name: string, timer: number | null }[]> }} Held */
    const set = (/** @type {Held} */ held) => held.timers.map((one) => `${one.ms} ms for ${one.by ?? "no request"}${one.cleared ? ", cleared" : ""}${one.released ? ", released" : ""}`);
    /** Every send of the late answer made from within timer `id`'s callback, or what it started. */
    const sentFrom = (/** @type {Held} */ held, /** @type {number} */ id) => {
      const sends = held.sends.item_slow_3 ?? [];
      assert.notDeepEqual(sends, [], "the late answer sent");
      assert.deepEqual(sends.filter((one) => one.timer !== id).map((one) => one.name), [], "every send of the late answer made from its own released timer");
    };
    /** `body` with a fresh held instance, killed after. @param {(api: ReturnType<typeof instance>, port: number, t: import("node:test").TestContext) => Promise<void>} body */
    const held = (body) => async (/** @type {import("node:test").TestContext} */ t) => {
      const api = instance(items, true, t.signal);
      try {
        const { port } = await api.loaded;
        await body(api, port, t);
      } finally {
        await api.end();
      }
    };
    await t.test(
      "a late item alone sets one SLOW_MS timer, the only one, and arrives whole, sent from within it, once released",
      held(async (api, port, t) => {
        const late = get(port, "item_slow_3", t.signal);
        let now = await api.until("item_slow_3");
        assert.deepEqual(set(now), ["300 ms for item_slow_3"], "the timers the item API set");
        assert.deepEqual(now.sends.item_slow_3 ?? [], [], "nothing of the late answer sent while its timer is held");
        assert.equal(late.seen.headed, false, "nothing of the late answer arrived while its timer is held");
        const id = now.timers[0].id;
        await api.release(id);
        assert.deepEqual(await within(late.whole, "the late item after its timer's release", t.signal), item, "the late item, whole, as the file has it");
        now = await api.state();
        sentFrom(now, id);
        assert.deepEqual(set(now), ["300 ms for item_slow_3, released"], "no other timer set");
      }),
    );
    await t.test(
      "with the instance's first late item held, the item and an unknown one arrive whole from no timer, and the late one after them from its own",
      held(async (api, port, t) => {
        const late = get(port, "item_slow_3", t.signal);
        let now = await api.until("item_slow_3");
        assert.deepEqual(set(now), ["300 ms for item_slow_3"], "the timers the item API set");
        assert.deepEqual(now.sends.item_slow_3 ?? [], [], "nothing of the late answer sent while its timer is held");
        const known = get(port, "item_3", t.signal);
        const unknown = get(port, "item_slow_9", t.signal);
        assert.deepEqual(await within(known.whole, "the item while the late one is held", t.signal), item, "the item, whole, as the file has it");
        const missing = await within(unknown.whole, "the unknown item while the late one is held", t.signal);
        assert.deepEqual({ status: missing.status, body: missing.body }, { status: 404, body: "" }, "the unknown item");
        assert.equal(late.seen.headed, false, "nothing of the late answer arrived before the others");
        now = await api.state();
        assert.deepEqual(set(now), ["300 ms for item_slow_3"], "the late item's timer still held, and none set by the others");
        assert.deepEqual(now.sends.item_slow_3 ?? [], [], "nothing of the late answer sent");
        for (const key of ["item_3", "item_slow_9"]) {
          const sends = now.sends[key] ?? [];
          assert.notDeepEqual(sends, [], `${key} sent`);
          assert.deepEqual(sends.filter((one) => one.timer !== null).map((one) => one.name), [], `${key} sent from no timer`);
        }
        const id = now.timers[0].id;
        await api.release(id);
        assert.deepEqual(await within(late.whole, "the late item after its timer's release", t.signal), item, "the late item, whole, as the file has it");
        now = await api.state();
        sentFrom(now, id);
      }),
    );
    await t.test("with its real timers", async (t) => {
      const api = instance(items, false, t.signal);
      try {
        const { port } = await api.loaded;
        const answers = Promise.all(["item_3", "item_slow_3", "item_slow_9"].map((id) => get(port, id, t.signal).whole));
        const [known, late, unknown] = await within(answers, "the answers with real timers", t.signal);
        assert.deepEqual(known, item, "the item");
        assert.deepEqual(late, item, "the late item is the item");
        assert.equal(unknown.status, 404);
      } finally {
        await api.end();
      }
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});