// @ts-check
// RelativeTime (relative_time.rs). The server wrote the time relative to now; this writes it again,
// in the same locale and style, whenever its text would change. One timer serves every relative
// time on the page, set for the soonest change, and the page's own clock is read again when it
// comes back (from sleep, a hidden tab or the back/forward cache), since a timer may not have run.

/** The units, largest first, in seconds (the server's: crates/corten/src/i18n/format.rs). */
const UNITS = /** @type {const} */ ([
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
  ["second", 1],
]);

/** @typedef {{ at: number, format: Intl.RelativeTimeFormat, next: number }} Entry */
/** The relative times on the page: the instant each counts to, its format, and when its text next changes. @type {Map<HTMLTimeElement, Entry>} */
const live = new Map();
/**
 * The entries by when their text next changes, soonest first (a binary heap), so a tick redraws
 * only those due, not every time on the page. An item whose entry is gone or has moved on (an
 * aborted time, one connected again) is left in until it reaches the top, or the heap is rebuilt.
 * @type {{ next: number, time: HTMLTimeElement, entry: Entry }[]}
 */
let queue = [];
/** One format per locale and style; `null` for a locale the browser does not have. @type {Map<string, Intl.RelativeTimeFormat | null>} */
const formats = new Map();
let timer = 0;
/** When the timer fires (`Date.now()` time), or Infinity. */
let due = Infinity;
let watching = false;

/**
 * Keeps `time` current, until `signal` aborts. A locale the browser does not have keeps the
 * server's text, which Intl would otherwise write in the browser's own language.
 * @param {HTMLTimeElement} time @param {string} locale @param {string} style
 * @param {AbortSignal} signal
 */
export function connect(time, locale, style, signal) {
  const at = Date.parse(time.dateTime);
  if (Number.isNaN(at) || signal.aborted) return;
  const key = `${locale} ${style}`;
  let format = formats.get(key);
  if (format === undefined) {
    const options = { style: /** @type {Intl.RelativeTimeFormatStyle} */ (style), numeric: /** @type {const} */ ("always") };
    format = new Intl.RelativeTimeFormat(locale, options);
    if (!speaks(format, locale)) format = null;
    formats.set(key, format);
  }
  if (!format) return;
  const now = Date.now();
  const entry = { at, format, next: now + untilChange(at, now) };
  live.set(time, entry);
  // Gone: left out of the next tick, and dropped from the queue when it comes up. A wake for it
  // alone finds nothing to change.
  signal.addEventListener("abort", () => live.get(time) === entry && live.delete(time), { once: true });
  draw(time, now);
  watch();
  enqueue(time, entry);
  // A timer whose time has passed has not run yet (the page slept, the clock was set forward):
  // it may be a day away by the timer's own clock, so this time sets its own.
  if (entry.next < due || due <= now) setTimer(entry.next, now);
}

/**
 * Whether `format` writes `locale`'s language in its script. A browser without the locale falls
 * back to a parent (`sr-Latn` to `sr`, in Cyrillic) or to its own language, and the server's
 * text is then the right one to keep. A region the browser lacks (`de-AT` as `de`) is the same
 * language in the same script, though a word may differ from the server's.
 * @param {Intl.RelativeTimeFormat} format @param {string} locale
 */
function speaks(format, locale) {
  const want = new Intl.Locale(locale).maximize();
  const got = new Intl.Locale(format.resolvedOptions().locale).maximize();
  return want.language === got.language && want.script === got.script;
}

/** The unit `ms` (from now; negative: before) is written in, and its size in milliseconds. @param {number} ms */
function unitOf(ms) {
  const seconds = Math.floor(Math.abs(ms) / 1000);
  const [unit, size] = UNITS.find(([, size]) => seconds >= size) ?? UNITS[UNITS.length - 1];
  return { unit, step: size * 1000 };
}

/** Writes `time`'s text as of `now`, as the server does: whole units toward zero, after `now` the future. @param {HTMLTimeElement} time @param {number} now */
function draw(time, now) {
  const entry = live.get(time);
  if (!entry) return;
  const ms = entry.at - now;
  const { unit, step } = unitOf(ms);
  const n = Math.floor(Math.abs(ms) / step);
  const text = entry.format.format(ms > 0 ? n : -n, unit);
  // The same text node, changed in place, so a selection in it is kept.
  const node = time.firstChild;
  if (node instanceof Text && node === time.lastChild) {
    if (node.data !== text) node.data = text;
  } else if (time.textContent !== text) time.textContent = text;
}

/** Milliseconds until the text for `at` changes, from `now`. @param {number} at @param {number} now */
function untilChange(at, now) {
  const ms = at - now;
  const { step } = unitOf(ms);
  // Ahead: when the count drops below the whole units it has. Behind (or now): when one more
  // unit has passed.
  return ms > 0 ? (ms % step) + 1 : step - (-ms % step);
}

/** @param {number} next @param {number} now */
function setTimer(next, now) {
  clearTimeout(timer);
  due = next;
  timer = setTimeout(tick, next - now);
}

/** Whether a queued item is still its time's current entry, as queued. @param {{ next: number, time: HTMLTimeElement, entry: Entry }} item */
const current = (item) => live.get(item.time) === item.entry && item.entry.next === item.next;

/** Queues `time` at its entry's next change. @param {HTMLTimeElement} time @param {Entry} entry */
function enqueue(time, entry) {
  // Items left behind by aborted times (a list a patch redraws again and again) are swept out
  // once they outnumber the live ones.
  // (`time` itself is left out, as it is pushed below.)
  if (queue.length > 2 * live.size + 32) {
    queue = [...live].filter(([other]) => other !== time).map(([time, entry]) => ({ next: entry.next, time, entry }));
    queue.sort((a, b) => a.next - b.next);
  }
  const item = { next: entry.next, time, entry };
  let i = queue.push(item) - 1;
  while (i > 0) {
    const up = (i - 1) >> 1;
    if (queue[up].next <= item.next) break;
    queue[i] = queue[up];
    i = up;
  }
  queue[i] = item;
}

/** Takes the soonest item off the queue. */
function dequeue() {
  const top = queue[0];
  const last = /** @type {typeof top} */ (queue.pop());
  if (queue.length) {
    let i = 0;
    for (;;) {
      let child = 2 * i + 1;
      if (child >= queue.length) break;
      if (child + 1 < queue.length && queue[child + 1].next < queue[child].next) child += 1;
      if (queue[child].next >= last.next) break;
      queue[i] = queue[child];
      i = child;
    }
    queue[i] = last;
  }
  return top;
}

/**
 * Writes the relative times whose text changes by now (with `all`, every one: the clock may have
 * jumped) and sets the timer for the soonest next change.
 * @param {boolean} [all]
 */
function tick(all = false) {
  clearTimeout(timer);
  timer = 0;
  const was = due;
  due = Infinity;
  const now = Date.now();
  // The timer came well before its time by the page's clock: the clock was set back, so every
  // queued instant is off by as much. Drawn again from the clock, as a page coming back is.
  if (now < was - 1000) all = true;
  if (all) {
    for (const [time, entry] of live) {
      draw(time, now);
      entry.next = now + untilChange(entry.at, now);
    }
    queue = [...live].map(([time, entry]) => ({ next: entry.next, time, entry })).sort((a, b) => a.next - b.next);
  } else {
    while (queue.length && (queue[0].next <= now || !current(queue[0]))) {
      const item = dequeue();
      if (!current(item)) continue;
      draw(item.time, now);
      item.entry.next = now + untilChange(item.entry.at, now);
      enqueue(item.time, item.entry);
    }
  }
  if (queue.length) setTimer(queue[0].next, now);
}

/** Once a page has a relative time: read the clock again when the page comes back. */
function watch() {
  if (watching) return;
  watching = true;
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && live.size && tick(true));
  addEventListener("pageshow", (event) => event.persisted && live.size && tick(true));
}
