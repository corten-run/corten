// The kept pages' store with and without the rule for a full store (docs/design.md, Choice 70):
// the clock that makes room, and an answer kept in a full store only when its URL's mark is
// set. Requests are drawn from a Zipf law over the app's URLs, with a share from a crawler that
// asks for new URLs. It counts how often the handler runs and how often an answer is copied
// into the store, over the second half of the requests. A model: pages of one size, one
// language, no writes.
// node bench/catalog/sim-kept-store.mjs
const C = 5461; // pages of 6 KiB in 32 MiB
const BITS = 1 << 20; // marks at that bound
// Instructions a request, counted under callgrind on the catalog benchmark's page: a kept page
// given, an answer kept in a full store and with room, and one not kept (83,109 for a new URL in
// a full store was an average with about 6 in 100 that were kept).
const COST = { hit: 44208, keptFull: 92179, keptRoom: 95193, unkept: 82500 };

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function zipf(n, s) {
  const cdf = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) cdf[i] = sum += 1 / Math.pow(i + 1, s);
  return (u) => {
    const x = u * sum;
    let lo = 0, hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cdf[mid] < x) lo = mid + 1; else hi = mid;
    }
    return lo;
  };
}
const mix = (x) => {
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return (x ^ (x >>> 16)) >>> 0;
};

// life: an answer's lifetime in requests (Infinity: never lapses).
function run({ rule, urls, skew, crawl, walk, life, requests, seed, burst = 1 }) {
  const next = rng(seed), draw = zipf(urls, skew);
  const slots = new Array(C + 1).fill(null), where = new Map();
  let hand = 0, count = 0, free = [];
  for (let i = C; i >= 0; i--) free.push(i);
  const marks = new Uint32Array(BITS >> 5);
  let marked = 0, crawled = 0;
  const asked = (url) => {
    const h = mix(url), word = (h >>> 5) % marks.length, bit = 1 << (h & 31);
    if (marks[word] & bit) return true;
    marks[word] |= bit;
    if (marked++ >= BITS / 8) { marks.fill(0); marked = 0; }
    return false;
  };
  const drop = (i) => { where.delete(slots[i].url); slots[i] = null; free.push(i); count--; };
  const out = { handler: 0, copies: 0, hits: 0, ir: 0, n: 0 };
  const warm = requests / 2;
  for (let t = 0; t < requests; t++) {
    let url;
    if (next() < crawl) url = urls + (walk ? crawled++ % walk : Math.floor(crawled++ / burst));
    else url = draw(next());
    const counted = t >= warm;
    const at = where.get(url);
    if (at !== undefined && slots[at].until > t) {
      slots[at].used = true;
      if (counted) { out.hits++; out.ir += COST.hit; out.n++; }
      continue;
    }
    const full = count > C - C / 8;
    if (rule && full && !asked(url)) {
      if (counted) { out.handler++; out.ir += COST.unkept; out.n++; }
      continue;
    }
    if (at !== undefined) drop(at);
    const i = free.pop();
    slots[i] = { url, used: false, until: t + life };
    where.set(url, i);
    count++;
    let steps = slots.length * 2;
    while (count > C && steps-- > 0) {
      hand = (hand + 1) % slots.length;
      const e = slots[hand];
      if (!e || hand === i) continue;
      if (e.until > t && e.used) { e.used = false; continue; }
      drop(hand);
    }
    if (counted) { out.handler++; out.copies++; out.ir += full ? COST.keptFull : COST.keptRoom; out.n++; }
  }
  return out;
}

const pct = (x, n) => (100 * x / n).toFixed(1).padStart(5);
console.log("urls     skew crawl walk    life   | handler% base rule | copies% base rule | instr base   rule   change");
const requests = 4_000_000;
for (const [crawl, burst] of [[1, 2], [1, 3], [0.3, 2]]) {
  const cfg = { urls: 50_000, skew: 0.9, crawl, walk: 0, life: Infinity, requests, seed: 7, burst };
  const a = run({ ...cfg, rule: false }), b = run({ ...cfg, rule: true });
  console.log(`each new URL ${burst} times in a row, ${crawl} of requests: handler% ${pct(a.handler, a.n)} ${pct(b.handler, b.n)}  instr ${(a.ir / a.n).toFixed(0)} ${(b.ir / b.n).toFixed(0)}`);
}
for (const urls of [4000, 50_000, 1_000_000]) {
  for (const skew of [0.6, 0.9, 1.1]) {
    for (const [crawl, walk] of [[0, 0], [0.3, 0], [0.3, 100_000]]) {
      for (const life of [Infinity, 200_000]) {
        const cfg = { urls, skew, crawl, walk, life, requests, seed: 7 };
        const a = run({ ...cfg, rule: false }), b = run({ ...cfg, rule: true });
        const ia = a.ir / a.n, ib = b.ir / b.n;
        console.log(
          `${String(urls).padEnd(8)} ${skew}  ${crawl}   ${String(walk).padEnd(7)} ${String(life).padEnd(8)}|` +
          `          ${pct(a.handler, a.n)} ${pct(b.handler, b.n)} |         ${pct(a.copies, a.n)} ${pct(b.copies, b.n)} |` +
          ` ${ia.toFixed(0).padStart(6)} ${ib.toFixed(0).padStart(6)} ${((ib / ia - 1) * 100).toFixed(1).padStart(6)}%`,
        );
      }
    }
  }
}
