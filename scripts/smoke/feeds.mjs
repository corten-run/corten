import http from "node:http";
import { engine, skip, check } from "./helpers.mjs";

export async function feedRecovery(page, errors, located) {
  // A feed whose stream refuses the cursor its own snapshot gives as it opens (here every stream
  // is `sync`, as when one URL serves more than one feed) loads the snapshot again after a backoff
  // that doubles (1 s, then 2 s), not straight away in a loop, and stops when its signal aborts
  // (#1067). A `sync` that comes later on a stream (a server restarted, its cursor gone) loads the
  // snapshot at once.
  /**
   * Subscribes to a feed of the smoke's own at `/feed/{name}` and counts what it asks for: the
   * `n`th stream is answered `stream(n)` (a body, or a status with no stream), or sent to
   * `forward`, and the `n`th snapshot `snapshot(n)`'s status (200: epoch `a`, seq 1, no rows, or
   * `body(n)`).
   * @param {string} name @param {(n: number) => string | { status: number }} stream
   * @param {{ forward?: string, snapshot?: (n: number) => number, body?: (n: number) => string }} [options]
   */
  const feedTimes = async (name, stream, { forward, snapshot, body } = {}) => {
    const times = { snapshots: /** @type {number[]} */ ([]), streams: 0, streamsAt: /** @type {number[]} */ ([]), since: /** @type {(string | null)[]} */ ([]) };
    await page.route(`**/feed/${name}`, (route) => {
      times.snapshots.push(Date.now());
      const status = snapshot?.(times.snapshots.length) ?? 200;
      return route.fulfill({ status, contentType: "application/json", body: status === 200 ? (body?.(times.snapshots.length) ?? '{"epoch":"a","seq":1,"rows":[]}') : "{}" });
    });
    await page.route(`**/feed/${name}/live*`, (route) => {
      times.streams += 1;
      times.streamsAt.push(Date.now());
      times.since.push(new URL(route.request().url()).searchParams.get("since"));
      if (forward) return route.continue({ url: forward });
      const answer = stream(times.streams);
      if (typeof answer !== "string") return route.fulfill({ status: answer.status, body: "" });
      return route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: answer });
    });
    await page.evaluate(async (name) => {
      const { subscribe } = /** @type {any} */ (await import(/** @type {string} */ ("corten")));
      const w = /** @type {any} */ (window);
      w.__feeds ??= {};
      const stop = new AbortController();
      const feed = (w.__feeds[name] = { stop, states: /** @type {string[]} */ ([]), patches: /** @type {number[]} */ ([]), snapshots: 0 });
      subscribe(
        `/feed/${name}`,
        { snapshot: () => void (feed.snapshots += 1), patch: (/** @type {unknown} */ _, /** @type {number} */ seq) => feed.patches.push(seq), status: (/** @type {string} */ s) => feed.states.push(s) },
        { signal: stop.signal },
      );
    }, name);
    return times;
  };
  /** Aborts the subscription and gives its status calls. @param {string} name */
  const stopFeed = (name) =>
    page.evaluate((name) => {
      const feed = (/** @type {any} */ (window)).__feeds[name];
      feed.stop.abort();
      return /** @type {string} */ (feed.states.join(" "));
    }, name);
  /** How many snapshots the subscription handed to `snapshot`. @param {string} name */
  const feedSnapshots = (name) => page.evaluate((name) => /** @type {number} */ ((/** @type {any} */ (window)).__feeds[name].snapshots), name);
  /** The seqs the subscription handed to `patch`. @param {string} name */
  const feedPatches = (name) => page.evaluate((name) => /** @type {number[]} */ ((/** @type {any} */ (window)).__feeds[name].patches), name);
  /** Waits until the subscription has gone live `times` times. @param {string} name @param {number} times */
  const feedLive = (name, times, timeout = 5000) =>
    page
      .waitForFunction(
        ([name, times]) => (/** @type {any} */ (window)).__feeds[name].states.filter((/** @type {string} */ s) => s === "live").length >= times,
        /** @type {[string, number]} */ ([name, times]),
        { timeout },
      )
      .then(
        () => true,
        () => false,
      );
  /** @param {string} name */
  const unrouteFeed = async (name) => {
    await page.unroute(`**/feed/${name}`);
    await page.unroute(`**/feed/${name}/live*`);
  };
  const refusedFeed = await feedTimes("refused", () => 'event: sync\ndata: {"reason":"cursor-expired"}\n\n');
  for (const end = Date.now() + 6000; refusedFeed.snapshots.length < 3 && Date.now() < end; ) await page.waitForTimeout(50);
  const refusedAt = refusedFeed.snapshots.slice(0, 3);
  const refusedStates = await stopFeed("refused");
  // The next snapshot was due 4 s after the third: wait past it with the routes still counting.
  await page.waitForTimeout(5000);
  await unrouteFeed("refused");
  const gaps = refusedAt.slice(1).map((at, i) => at - refusedAt[i]);
  check(
    "a feed whose stream refuses its own snapshot's cursor backs off 1 s then 2 s, and stops when its signal aborts",
    gaps.length === 2 && gaps[0] >= 900 && gaps[0] < 1700 && gaps[1] >= 1900 && gaps[1] < 2800 && refusedFeed.snapshots.length === 3 && !refusedStates.includes("syncing syncing"),
    `snapshots ${gaps.map((g) => `+${g} ms`).join(", ")}, ${refusedFeed.snapshots.length - refusedAt.length} in the 5 s after the abort; ${refusedStates}`,
  );
  // The first stream is accepted and ends; the browser reconnects 400 ms later, and that stream
  // answers `sync` (a feed reset while the page was away); later streams are accepted.
  const quietFeed = await feedTimes("quiet", (n) => (n === 1 ? "retry: 400\n\n" : n === 2 ? 'event: sync\ndata: {"reason":"cursor-expired"}\n\n' : "retry: 60000\n\n"));
  await page.waitForTimeout(2000);
  await stopFeed("quiet");
  await unrouteFeed("quiet");
  const quietGap = quietFeed.snapshots.length === 2 ? quietFeed.snapshots[1] - quietFeed.snapshots[0] : NaN;
  check(
    "a sync on a stream the browser reconnected loads the snapshot at once, not after a backoff",
    quietFeed.snapshots.length === 2 && quietFeed.streams >= 2 && quietGap < 900,
    `${quietFeed.snapshots.length} snapshots, ${quietFeed.streams} streams, the second snapshot +${quietGap} ms after the first`,
  );
  // A feed reset while its stream is open: the first connection stays open, and 1.5 s after it
  // opened the server sends `sync`. A server of the smoke's own holds the stream (a route cannot
  // answer in two parts); later streams are held open with nothing on them.
  const resetName = "a sync on a stream open longer than its first moments loads the snapshot at once";
  if (engine === "webkit") skip(resetName, "a routed request is cross-origin there");
  else {
    /** @type {number[]} */
    const syncsSent = [];
    /** @type {import("node:http").ServerResponse[]} */
    const held = [];
    const resetServer = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      res.write("retry: 60000\n\n");
      held.push(res);
      if (held.length === 1)
        setTimeout(() => {
          syncsSent.push(Date.now());
          res.end('event: sync\ndata: {"reason":"cursor-expired"}\n\n');
        }, 1500);
    });
    await new Promise((resolve) => resetServer.listen(0, "127.0.0.1", () => resolve(undefined)));
    const resetPort = /** @type {import("node:net").AddressInfo} */ (resetServer.address()).port;
    /** @type {Awaited<ReturnType<typeof feedTimes>>} */
    let resetFeed = { snapshots: [], streams: 0, streamsAt: [], since: [] };
    try {
      resetFeed = await feedTimes("reset", () => "", { forward: `http://127.0.0.1:${resetPort}/live` });
      for (const end = Date.now() + 5000; resetFeed.snapshots.length < 2 && Date.now() < end; ) await page.waitForTimeout(50);
      await stopFeed("reset");
    } finally {
      await unrouteFeed("reset");
      for (const res of held) res.destroy();
      resetServer.close();
    }
    const resetGap = resetFeed.snapshots.length === 2 && syncsSent.length ? resetFeed.snapshots[1] - syncsSent[0] : NaN;
    check(resetName, resetFeed.snapshots.length === 2 && resetGap < 500, `${resetFeed.snapshots.length} snapshots, the second ${resetGap} ms after the sync was sent`);
  }

  // subscribe()'s other recovery paths (#1068). A patch already applied is dropped, and one that
  // skips a seq loads a new snapshot: seq 2, 2 again, 3, then 5.
  const feedsLogged = errors.length;
  located.value = true;
  /** @param {number} seq */
  const patchEvent = (seq) => `event: patch\nid: a-${seq}\ndata: {"seq":${seq},"changes":[]}\n\n`;
  const gapFeed = await feedTimes("gap", (n) => (n === 1 ? `${patchEvent(2)}${patchEvent(2)}${patchEvent(3)}${patchEvent(5)}` : "retry: 60000\n\n"));
  await feedLive("gap", 2);
  const gapPatches = await feedPatches("gap");
  const gapStates = await stopFeed("gap");
  await unrouteFeed("gap");
  check(
    "a patch that skips a seq loads a new snapshot, and a patch already applied is dropped",
    gapFeed.snapshots.length === 2 && gapFeed.streams === 2 && gapPatches.join() === "2,3" && gapFeed.since[1] === "a-1" && gapStates.startsWith("syncing live syncing live"),
    `${gapFeed.snapshots.length} snapshots, patches ${gapPatches.join(",")}, second stream since ${gapFeed.since[1]}; ${gapStates}`,
  );
  // A stream answered with an HTTP error ends EventSource for good: subscribe() listens again from
  // the last patch's cursor, with no snapshot, after a wait that doubles every second error in a
  // row (1, 1, 1, 2, 2 s), and a stream that opens starts again (1 s). The first stream sends
  // seq 2 and ends; the browser reconnects (after 100 ms) to a 503, then subscribe() four times to
  // a 503 and once to a stream that ends; the browser reconnects to a 503, and subscribe() to a
  // stream.
  const failedFeed = await feedTimes("failed", (n) =>
    n === 1 ? `retry: 100\n\n${patchEvent(2)}` : n === 7 ? "retry: 100\n\n" : n <= 8 ? { status: 503 } : "retry: 60000\n\n",
  );
  // Long enough for a loaded browser that runs each timer seconds late; it ends once live.
  const failedLive = await feedLive("failed", 3, 60_000);
  const failedStates = await stopFeed("failed");
  await unrouteFeed("failed");
  // The runtime's six waits, one as each source closed: the timer it set then, which must be 1, 1,
  // 1, 2 and 2 s, and 1 s again after the sixth source, which closed after a stream had opened,
  // and the time from the close to the next source, at least that long. A loaded Firefox ran a 1 s
  // timer about 6 s late (#1102), which says nothing of the runtime, so the time taken has no upper
  // bound.
  const failedAt = await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    const sources = w.__sources
      .filter((/** @type {EventSource} */ s) => s.url.includes("/feed/failed/live"))
      .map((/** @type {any} */ s) => ({ opened: /** @type {number} */ (s.openedAt), closed: /** @type {number | null} */ (s.closedAt ?? null), next: /** @type {number | undefined} */ (s.nextTimer), by: /** @type {number} */ (s.openedBy) }));
    const timers = /** @type {number[]} */ (w.__timers);
    // The first timer set after the close, which the runtime's error listener, run straight after
    // the smoke's, sets in the same dispatch.
    const asked = sources.map((s) => (s.next === undefined ? null : (timers[s.next] ?? null)));
    return { sources, asked };
  });
  const waits = [0, 1, 2, 3, 4, 5];
  const failedAsked = failedAt.asked.slice(0, 6);
  const failedGaps = waits.map((i) => Math.round((failedAt.sources[i + 1]?.opened ?? NaN) - (failedAt.sources[i]?.closed ?? NaN)));
  const seenGaps = [2, 3, 4, 5, 6, 8].map((i) => failedFeed.streamsAt[i] - failedFeed.streamsAt[i - 1]);
  check(
    "a stream answered with an error is listened to again from the last patch, after 1, 1, 1, 2 then 2 s, and 1 s again after a stream opened, with no snapshot",
    failedFeed.snapshots.length === 1 &&
      failedFeed.streams === 9 &&
      failedFeed.since.slice(2).every((since) => since === "a-2") &&
      failedAt.sources.length >= 7 &&
      failedAsked.join() === "1000,1000,1000,2000,2000,1000" &&
      // Each next source opened by the timer set as the one before it closed, and not sooner
      // (5 ms for the clocks' granularity). The runtime opens it inside that timer's callback
      // (`retry(() => listen(..))`); a wait added before it would fail this link, not the backoff.
      waits.every((i) => failedAt.sources[i + 1]?.by === failedAt.sources[i]?.next) &&
      failedGaps.every((gap, i) => gap >= /** @type {number} */ (failedAsked[i]) - 5) &&
      failedLive &&
      failedStates.includes("reconnecting live"),
    `${failedLive ? "live 3 times" : "not live 3 times within 60 s"}, ${failedFeed.snapshots.length} snapshots, ${failedFeed.streams} streams since ${failedFeed.since.join(" ")}, ${failedAt.sources.length} sources, waits asked ${failedAsked.join(", ")} ms and taken ${failedGaps.map((g) => `${g} ms`).join(", ")} (as Playwright saw the requests: ${seenGaps.map((g) => `+${g} ms`).join(", ")}); ${failedStates}`,
  );
  // A snapshot that fails is fetched again on the same schedule, counted with the stream's errors:
  // four fail, so the runtime waits 1, 1, 1 then 2 s, and the fifth loads. A loaded snapshot starts
  // the count again, so its stream, answered with a 503, is listened to again after 1 s (2 s if the
  // count went on), and the feed goes live. Each snapshot request and source records the timer
  // whose callback started it, which must be the one set after the failure before it.
  await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    const fetch_ = window.fetch;
    const fetches = (w.__retriedFetches = /** @type {{ at: number, by: number }[]} */ ([]));
    w.__retriedRestore = () => void (window.fetch = fetch_);
    window.fetch = (input, init) => {
      if (String(input).endsWith("/feed/retried")) fetches.push({ at: performance.now(), by: w.__timerRunning() });
      return fetch_.call(window, input, init);
    };
  });
  const retriedFeed = await feedTimes("retried", (n) => (n === 1 ? { status: 503 } : "retry: 60000\n\n"), { snapshot: (n) => (n <= 4 ? 500 : 200) });
  // Long enough for a loaded browser that runs each timer seconds late; it ends once live.
  const retriedLive = await feedLive("retried", 1, 60_000);
  const retriedStates = await stopFeed("retried");
  await unrouteFeed("retried");
  const retriedAt = await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    w.__retriedRestore();
    const timers = /** @type {number[]} */ (w.__timers);
    const fetches = /** @type {{ at: number, by: number }[]} */ (w.__retriedFetches);
    const sources = w.__sources
      .filter((/** @type {EventSource} */ s) => s.url.includes("/feed/retried/live"))
      .map((/** @type {any} */ s) => ({ next: /** @type {number | undefined} */ (s.nextTimer), by: /** @type {number} */ (s.openedBy) }));
    // The timer that started each later snapshot request, then the one that started the second source.
    const by = [...fetches.slice(1).map((f) => f.by), sources[1]?.by ?? -1];
    return { fetches, sources, by, asked: by.map((i) => (i >= 0 ? (timers[i] ?? null) : null)) };
  });
  const retriedGaps = retriedAt.fetches.slice(1).map((f, i) => Math.round(f.at - retriedAt.fetches[i].at));
  check(
    "a snapshot that fails is fetched again after 1, 1, 1 then 2 s, and a loaded snapshot starts the count again: its stream's error waits 1 s",
    retriedFeed.snapshots.length === 5 &&
      retriedAt.fetches.length === 5 &&
      retriedFeed.streams === 2 &&
      retriedAt.sources.length === 2 &&
      retriedAt.asked.join() === "1000,1000,1000,2000,1000" &&
      // Each request after the first started by a timer, the source after the 503 by the one set as it closed.
      retriedAt.by.every((i) => i >= 0) &&
      new Set(retriedAt.by).size === 5 &&
      retriedAt.sources[1].by === retriedAt.sources[0].next &&
      // Not sooner than asked (5 ms for the clock's granularity), from one request's start to the next.
      retriedGaps.every((gap, i) => gap >= /** @type {number} */ (retriedAt.asked[i]) - 5) &&
      retriedLive &&
      retriedStates.startsWith("syncing reconnecting live"),
    `${retriedLive ? "live" : "not live within 60 s"}, ${retriedFeed.snapshots.length} snapshots, ${retriedFeed.streams} streams, waits asked ${retriedAt.asked.join(", ")} ms, snapshot requests ${retriedGaps.map((g) => `+${g} ms`).join(", ")}; ${retriedStates}`,
  );
  // An answer that is JSON but not a snapshot (no epoch) is a failed snapshot: never handed to the
  // script, logged, and fetched again after 1 s (#1039).
  const malformedFeed = await feedTimes("malformed", () => "retry: 60000\n\n", { body: (n) => (n === 1 ? '{"seq":1,"rows":[]}' : '{"epoch":"a","seq":1,"rows":[]}') });
  await feedLive("malformed", 1, 60000);
  const malformedSnapshots = await feedSnapshots("malformed");
  const malformedStates = await stopFeed("malformed");
  await unrouteFeed("malformed");
  const malformedGap = malformedFeed.snapshots.length === 2 ? malformedFeed.snapshots[1] - malformedFeed.snapshots[0] : NaN;
  check(
    "a snapshot that is not one is not handed to the script, and is fetched again no sooner than 1 s",
    malformedFeed.snapshots.length === 2 && malformedSnapshots === 1 && malformedGap >= 900 && malformedFeed.streams === 1 && malformedStates.startsWith("syncing live"),
    `${malformedFeed.snapshots.length} fetched, ${malformedSnapshots} handed on, +${malformedGap} ms, ${malformedFeed.streams} streams; ${malformedStates}`,
  );
  // A patch that is not one (not JSON, then an upsert with no value) lost its write: the snapshot
  // is loaded again, after 1 s and then 2 s while the next stream's patch is not one either, and a
  // good patch after that is applied (#1039). Its stream is closed, so the browser does not resume it.
  const rejectedFeed = await feedTimes("rejected", (n) =>
    n === 1
      ? "event: patch\nid: a-2\ndata: <html>\n\n"
      : n === 2
        ? 'event: patch\nid: a-2\ndata: {"seq":2,"changes":[{"op":"upsert","id":"x"}]}\n\n'
        : `retry: 60000\n\n${patchEvent(2)}`,
  );
  await feedLive("rejected", 3, 60000);
  // The third stream's patch comes in a task after it opens.
  await page.waitForFunction((name) => (/** @type {any} */ (window)).__feeds[name].patches.length > 0, "rejected", { timeout: 5000 }).catch(() => {});
  const rejectedPatches = await feedPatches("rejected");
  const rejectedStates = await stopFeed("rejected");
  await unrouteFeed("rejected");
  const rejectedGaps = rejectedFeed.snapshots.slice(1).map((at, i) => at - rejectedFeed.snapshots[i]);
  // Each wait is bounded below only: a loaded browser runs a timer late, as #1102 found.
  check(
    "a patch that is not one is not handed to the script: the snapshot loads again no sooner than 1 s, then 2 s, and the next good patch applies",
    rejectedFeed.snapshots.length === 3 &&
      rejectedFeed.streams === 3 &&
      rejectedGaps[0] >= 900 &&
      rejectedGaps[1] >= 1900 &&
      rejectedPatches.join() === "2" &&
      rejectedStates.startsWith("syncing live syncing live syncing live"),
    `${rejectedFeed.snapshots.length} snapshots, ${rejectedFeed.streams} streams, ${rejectedGaps.map((g) => `+${g} ms`).join(", ")}, patches ${rejectedPatches.join(",")}; ${rejectedStates}`,
  );
  // The browsers' own errors for the 503 streams and the 500 snapshot are the point of these
  // checks, not faults, and the runtime logs the failed snapshot once (Firefox gives the logged
  // error's text as `Error`, so there it is known by coming from the runtime).
  located.value = false;
  const feedErrors = errors.slice(feedsLogged).filter((e) => !/(can.t establish a connection to the server at|Failed to load resource: .* at) \S+\/feed\/(failed|retried)\b/.test(e));
  const snapshotLogged = feedErrors.filter((e) =>
    /^(Error: )?corten: feed \/feed\/(retried answered 500|malformed sent no snapshot|rejected sent a bad patch)\b|^Error at \S+\/corten\.js$/.test(e),
  );
  const logged = (/** @type {RegExp} */ text) => snapshotLogged.filter((e) => text.test(e)).length;
  check(
    "a snapshot that fails, one that is not a snapshot and each patch that is not one are logged once",
    snapshotLogged.length === 7 &&
      // Firefox gives each as `Error`, from the runtime.
      (snapshotLogged.every((e) => e.startsWith("Error at ")) || (logged(/retried answered 500/) === 4 && logged(/malformed sent no snapshot/) === 1 && logged(/rejected sent a bad patch/) === 2)),
    feedErrors.join(" | ") || "nothing logged",
  );
  const feedOthers = feedErrors.filter((e) => !snapshotLogged.includes(e));
  // Checked here, while their text names where each came from, and not again at the end.
  check("the feed checks log no other console error", feedOthers.length === 0, feedOthers.join(" | "));
  errors.splice(feedsLogged);
}
