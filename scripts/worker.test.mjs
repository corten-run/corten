// @ts-check
// The service worker `corten::pwa` generates, run with the browser's service worker globals
// stubbed: which requests it answers from its cache and which it leaves to the network (#1133),
// and that a navigation it answers is sent once, a network-only one included (#1524).
// The worker is a template in pwa.rs that `Pwa::worker_js` fills in; this reads it from there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const START = 'const WORKER_TEMPLATE: &str = r#"';
const source = readFileSync(new URL("../crates/corten/src/pwa.rs", import.meta.url), "utf8");
const from = source.indexOf(START);
const to = source.indexOf('\n"#;', from);
const template = from >= 0 && to > from ? source.slice(from + START.length, to) : "";

/** The worker as `worker_js` fills it, for an app whose versioned files are under `/assets/`, with
 * a network-only prefix of its own and one inside the cached `/assets/`. */
const worker = template
  .replace("__IMPORTS__", "")
  .replace("__CACHE__", '"corten-v1"')
  .replace("__OFFLINE__", '"/offline"')
  .replace("__PRECACHE__", "[]")
  .replace("__NETWORK_ONLY__", '["/api/", "/assets/private/"]')
  .replace("__CACHED__", '["/assets/", "/corten/"]');

/**
 * Runs the worker and returns a function that sends it a fetch event and says what it did: whether
 * it answered (`respondWith`), its answer, and the requests it fetched and read from its cache.
 * `preload` is false for a browser without navigation preload.
 */
function load({ preload = true } = {}) {
  /** @type {Record<string, Function[]>} */
  const listeners = {};
  /** @type {any[]} */
  const fetched = [];
  /** @type {any[]} */
  const read = [];
  const self = {
    location: { origin: "https://shop.example" },
    registration: preload ? { navigationPreload: { enable: async () => {} } } : {},
    addEventListener: (/** @type {string} */ type, /** @type {Function} */ listener) => (listeners[type] ??= []).push(listener),
  };
  const context = {
    self,
    URL,
    Response,
    caches: {
      match: async (/** @type {any} */ request) => {
        read.push(request);
        return request === "/offline" ? new Response("offline page") : undefined;
      },
      open: async () => ({ put: async () => {} }),
    },
    fetch: async (/** @type {any} */ request) => {
      fetched.push(request);
      return new Response("bytes", { headers: { "cache-control": "public, max-age=31536000, immutable" } });
    },
  };
  vm.runInNewContext(worker, context);
  /**
   * What the worker does with a request: `preloadResponse` is what navigation preload gives it
   * (undefined when none was sent).
   * @param {{url: string, method?: string, destination?: string, headers?: Record<string, string>, mode?: string, preloadResponse?: Promise<Response | undefined>}} init
   */
  const send = (init) => {
    const request = {
      method: init.method ?? "GET",
      mode: init.mode ?? "no-cors",
      url: `https://shop.example${init.url}`,
      destination: init.destination ?? "",
      headers: new Headers(init.headers ?? {}),
    };
    /** @type {Promise<Response> | undefined} */
    let answer;
    const preloadResponse = init.preloadResponse ?? Promise.resolve(undefined);
    const event = { request, respondWith: (/** @type {Promise<Response>} */ r) => (answer = r), waitUntil: () => {}, preloadResponse };
    for (const listener of listeners.fetch ?? []) listener(event);
    return { answered: answer !== undefined, answer, fetched, read };
  };
  /** Whether the worker answers `request` itself (`respondWith`) rather than leaving it. */
  const answers = (/** @type {Parameters<typeof send>[0]} */ init) => send(init).answered;
  return Object.assign(answers, { send });
}

test("the worker template is found in pwa.rs and every placeholder is filled", () => {
  assert.ok(template.includes('self.addEventListener("fetch"'), "WORKER_TEMPLATE moved or changed shape in pwa.rs");
  assert.doesNotMatch(worker, /__[A-Z_]+__/);
});

test("a versioned file is answered from the worker's cache", () => {
  const answers = load();
  assert.equal(answers({ url: "/assets/abc123/app.css", destination: "style" }), true);
  assert.equal(answers({ url: "/assets/abc123/grading/condition.vtt", destination: "track" }), true, "a caption file is cached like any versioned file");
  assert.equal(answers({ url: "/assets/abc123/grading/poster.jpg", destination: "image" }), true, "a poster is cached like any versioned file");
});

test("a range, or the video or audio a player loads, is left to the network", () => {
  const answers = load();
  assert.equal(answers({ url: "/assets/abc123/grading/condition.mp4", headers: { range: "bytes=100-199" } }), false, "the cache cannot hold a 206");
  assert.equal(answers({ url: "/assets/abc123/grading/condition.mp4", destination: "video" }), false, "storing it would download the whole video");
  assert.equal(answers({ url: "/assets/abc123/sound.m4a", destination: "audio" }), false);
});

test("other requests are not touched", () => {
  const answers = load();
  assert.equal(answers({ url: "/api/items" }), false, "a network-only prefix");
  assert.equal(answers({ url: "/items/1" }), false, "not a versioned file");
});

test("a request under a network-only prefix inside a cached one is left to the network", () => {
  const answers = load();
  assert.equal(answers({ url: "/assets/private/report.css", destination: "style" }), false, "network-only wins over cached");
  assert.equal(answers({ url: "/assets/abc123/app.css", destination: "style" }), true, "the rest of the cached prefix is still cached");
});

test("a network-only navigation is the answer to the request navigation preload sent, and nothing else", async () => {
  const { send } = load();
  const sent = send({ url: "/api/callback?code=1", mode: "navigate", preloadResponse: Promise.resolve(new Response("signed in")) });
  assert.equal(sent.answered, true, "declined, the browser would drop the preload's answer and send it again");
  assert.equal(await (await sent.answer)?.text(), "signed in");
  assert.deepEqual([sent.fetched.length, sent.read.length], [0, 0], "no second request, and no cache");
});

test("a network-only navigation no preload was sent for is fetched once", async () => {
  const { send } = load();
  const sent = send({ url: "/api/callback?code=1", mode: "navigate" });
  assert.equal(await (await sent.answer)?.text(), "bytes");
  assert.deepEqual([sent.fetched.length, sent.read.length], [1, 0]);
});

test("a network-only navigation fails when the network does: no offline page, no second try", async () => {
  const { send } = load();
  const sent = send({ url: "/api/callback?code=1", mode: "navigate", preloadResponse: Promise.reject(new TypeError("offline")) });
  await assert.rejects(/** @type {Promise<Response>} */ (sent.answer), TypeError);
  assert.deepEqual([sent.fetched.length, sent.read.length], [0, 0]);
});

test("any other navigation still falls back to the offline page", async () => {
  const { send } = load();
  const sent = send({ url: "/items/1", mode: "navigate", preloadResponse: Promise.reject(new TypeError("offline")) });
  assert.equal(await (await sent.answer)?.text(), "offline page");
  const preloaded = send({ url: "/items/1", mode: "navigate", preloadResponse: Promise.resolve(new Response("item")) });
  assert.equal(await (await preloaded.answer)?.text(), "item");
  assert.equal(preloaded.fetched.length, 0, "the preload's answer is the page");
});

test("without navigation preload, or for a posted form, a network-only navigation is left to the browser", () => {
  assert.equal(load({ preload: false })({ url: "/api/callback?code=1", mode: "navigate" }), false, "declining sends it once");
  assert.equal(load()({ url: "/api/session", mode: "navigate", method: "POST" }), false, "navigation preload is for GET alone");
  assert.equal(load()({ url: "/items/1", mode: "navigate", method: "POST" }), false);
});
