import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { ServerResponse } from "node:http";
import { createRequire, syncBuiltinESMExports } from "node:module";
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

/** The request whose handling is running: each timer the item API sets is its request's. */
const requests = new AsyncLocalStorage();
/** The held timer whose callback is running, and anything that callback started. */
const running = new AsyncLocalStorage();

/** A timer the item API set, held until the test releases it, shaped as Node's Timeout is. */
class Held {
  static last = 0;
  id = ++Held.last;
  cleared = false;
  released = false;
  refed = true;
  /** @param {(...args: any[]) => void} callback @param {number} ms @param {any[]} args */
  constructor(callback, ms, args) {
    this.callback = () => callback(...args);
    this.ms = ms;
    /** @type {string | undefined} */
    this.by = requests.getStore();
  }
  ref() {
    this.refed = true;
    return this;
  }
  unref() {
    this.refed = false;
    return this;
  }
  hasRef() {
    return this.refed;
  }
  refresh() {
    return this;
  }
  close() {
    this.cleared = true;
    return this;
  }
  [Symbol.toPrimitive]() {
    return this.id;
  }
  /** Runs its callback, once, as its own. */
  release() {
    assert.ok(!this.cleared && !this.released, "a timer still set");
    this.released = true;
    running.run(this, this.callback);
  }
}

// The item API's own file, unchanged (the benchmark measures it as it is), loaded into this process
// the way `node server.mjs <items> 0 1` runs it, with SLOW_MS 300: each load a fresh instance of the
// file, with process.argv, SLOW_MS and http.createServer replaced only until its import settles or
// is given up at a bound. One instance's handler is driven directly, with every timer it sets, from
// startup on, through the global or node:timers setTimeout, held and tied to the request whose
// handling set it, and each answer's every send recorded with the held timer whose callback (or
// anything that callback started) made it. So which answer waits, and on what, is read from the
// server, with no time a busy machine can cross. "At once" here means ended by the next check of
// the event loop without waiting on any timer: an answer deferred by promises or setImmediate
// counts. A second instance, loaded after the real timers are back, answers the items over HTTP.
test("the item API ends a late item as the item from its own SLOW_MS timer alone, and the others by the next check of the event loop without waiting on it", { timeout: 10_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mixed-api-"));
  const items = join(dir, "items.json");
  writeFileSync(items, JSON.stringify({ item_3: { id: "item_3" }, item_4: { id: "item_4", name: "another" } }));
  const json = (/** @type {string} */ id) => JSON.stringify({ id });
  const require = createRequire(import.meta.url);
  const http = require("node:http");
  const timers = require("node:timers");
  const file = new URL("./item-api/server.mjs", import.meta.url);
  /** @type {Held[]} */
  const held = [];
  const real = [globalThis.setTimeout, globalThis.clearTimeout];
  const fake = [
    (/** @type {(...a: any[]) => void} */ callback, /** @type {number} */ ms, /** @type {any[]} */ ...args) => {
      const timer = new Held(callback, ms, args);
      held.push(timer);
      return timer;
    },
    (/** @type {unknown} */ timer) => {
      for (const one of held) if (one === timer || one.id === timer) one.cleared = true;
    },
  ];
  /** Every timer the item API sets held, or not. */
  const hold = (/** @type {boolean} */ on) => {
    const [set, clear] = /** @type {any[]} */ (on ? fake : real);
    globalThis.setTimeout = timers.setTimeout = set;
    globalThis.clearTimeout = timers.clearTimeout = clear;
    syncBuiltinESMExports();
  };
  /** Each server an instance made, and its bind once it listens: closed when the test ends. */
  /** @type {{ server: import("node:http").Server, bind?: Promise<unknown> }[]} */
  const made = [];
  /** `work`, given up when the test is cancelled or 5 s pass. @template T @param {Promise<T>} work @param {string} what @returns {Promise<T>} */
  const bounded = (work, what) => {
    const signal = AbortSignal.any([t.signal, AbortSignal.timeout(5_000)]);
    return new Promise((done, failed) => {
      const stop = () => failed(new Error(`${what}: ${signal.reason?.message ?? signal.reason}`));
      if (signal.aborted) stop();
      signal.addEventListener("abort", stop, { once: true });
      work.then(done, failed).finally(() => signal.removeEventListener("abort", stop));
    });
  };
  /** A fresh instance of the item API's file, as `tag`, and the handler and server it made. */
  const load = async (/** @type {string} */ tag) => {
    const { argv } = process;
    const slow = process.env.SLOW_MS;
    const { createServer } = http;
    /** @type {{ handler?: (req: any, res: any) => void, server?: import("node:http").Server }} */
    const loaded = {};
    http.createServer = (/** @type {any[]} */ ...a) => {
      loaded.handler = a.find((arg) => typeof arg === "function");
      const server = (loaded.server = createServer(...a));
      const one = { server, /** @type {Promise<unknown> | undefined} */ bind: undefined };
      made.push(one);
      const { listen } = server;
      server.listen = /** @type {any} */ ((/** @type {any[]} */ ...b) => {
        one.bind = once(server, "listening").catch(() => {});
        return listen.apply(server, b);
      });
      return server;
    };
    syncBuiltinESMExports();
    process.argv = [process.execPath, fileURLToPath(file), items, "0", "1"];
    process.env.SLOW_MS = "300";
    try {
      await bounded(import(`${file.href}?${tag}`), `the item API's ${tag} instance did not load`);
    } finally {
      http.createServer = createServer;
      syncBuiltinESMExports();
      process.argv = argv;
      if (slow === undefined) delete process.env.SLOW_MS;
      else process.env.SLOW_MS = slow;
    }
    assert.ok(loaded.handler && loaded.server, `the item API's ${tag} instance made a server with a handler`);
    return /** @type {Required<typeof loaded>} */ (loaded);
  };
  // Its "listening" lines kept out of the test's output.
  t.mock.method(console, "log", () => {});
  const url = (/** @type {string} */ id) => `/api/discovery/items/${id}`;
  try {
    hold(true);
    const answers = (await load("held")).handler;
    await t.test("in this process, with each request's timers held", async () => {
      /** Its handling of a request for `id`, and every send its answer made. */
      const ask = (/** @type {string} */ id) => {
        const req = { method: "GET", url: url(id), headers: {}, httpVersionMajor: 1, httpVersionMinor: 1 };
        const res = new ServerResponse(/** @type {any} */ (req));
        /** @type {{ name: string, timer: Held | undefined }[]} */
        const sent = [];
        /** @type {Buffer[]} */
        const chunks = [];
        for (const name of /** @type {const} */ (["writeHead", "flushHeaders", "write", "end"])) {
          const own = /** @type {(...a: any[]) => any} */ (res[name]);
          /** @type {any} */ (res)[name] = function (/** @type {any[]} */ ...a) {
            sent.push({ name, timer: running.getStore() });
            if (name !== "writeHead" && name !== "flushHeaders" && (typeof a[0] === "string" || a[0] instanceof Uint8Array)) chunks.push(Buffer.from(a[0]));
            return own.apply(this, a);
          };
        }
        requests.run(id, () => answers(req, res));
        return { res, sent, body: () => Buffer.concat(chunks).toString() };
      };
      // The next check of the event loop: what it does without waiting on a timer is done by then.
      const settle = () => new Promise((done) => setImmediate(done));
      const set = () => held.map((timer) => `${timer.ms} ms for ${timer.by ?? "no request"}${timer.cleared ? ", cleared" : ""}`);
      /** The late item ended, whole and as the item, from `timer`'s callback and nothing else. */
      const endedFrom = (/** @type {ReturnType<typeof ask>} */ late, /** @type {Held} */ timer) => {
        assert.ok(late.res.writableEnded, "releasing its timer ended the late item");
        assert.deepEqual(late.sent.filter((send) => send.timer !== timer).map((send) => send.name), [], "every send of the late answer made from its own released timer");
        assert.equal(late.res.statusCode, 200);
        assert.equal(late.body(), json("item_3"), "the late item is the item as the file has it");
      };

      // The late item alone sets one timer, of SLOW_MS, the only one the item API sets, and sends
      // nothing; releasing that timer, with no other request made, ends it.
      const first = ask("item_slow_3");
      await settle();
      assert.deepEqual(set(), ["300 ms for item_slow_3"], "the timers the item API set");
      assert.deepEqual(first.sent, [], "nothing of the late answer sent while its timer is held");
      held[0].release();
      await settle();
      endedFrom(first, held[0]);
      // With another late item held, the item and an unknown one end at once, set no timer of their
      // own and send nothing from a timer; the late one still waits on its own.
      const late = ask("item_slow_3");
      const item = ask("item_3");
      const unknown = ask("item_slow_9");
      await settle();
      for (const [answer, status] of /** @type {const} */ ([[item, 200], [unknown, 404]])) {
        assert.ok(answer.res.writableEnded, `ended ${answer.res.req.url} at once`);
        assert.equal(answer.res.statusCode, status);
        assert.deepEqual(answer.sent.filter((send) => send.timer), [], "sent from no timer");
      }
      assert.equal(item.body(), json("item_3"), "the item as the file has it");
      assert.deepEqual(set(), ["300 ms for item_slow_3", "300 ms for item_slow_3"], "no timer set by an at-once answer");
      assert.deepEqual(late.sent, [], "the late answer still held");
      held[1].release();
      await settle();
      endedFrom(late, held[1]);
    });

    hold(false);
    const { server } = await load("http");
    await bounded(made[made.length - 1].bind ?? Promise.reject(new Error("it did not listen")), "the item API's http instance did not listen");
    await t.test("over HTTP, with its real timers", async () => {
      const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
      const at = async (/** @type {string} */ id) => {
        const r = await fetch(`http://127.0.0.1:${port}${url(id)}`, { signal: t.signal });
        return { status: r.status, body: await r.text() };
      };
      const [now, late, unknown] = await Promise.all([at("item_3"), at("item_slow_3"), at("item_slow_9")]);
      assert.deepEqual(now, { status: 200, body: json("item_3") });
      assert.deepEqual(late, now, "the late item is the item");
      assert.equal(unknown.status, 404);
    });
  } finally {
    hold(false);
    // A server whose bind is still pending is closed once it settles.
    for (const { server, bind } of made) {
      await bind;
      if (server.listening) {
        await new Promise((closed) => {
          server.close(closed);
          server.closeAllConnections();
        });
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
