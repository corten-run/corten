// How often the idle rule reads a rise between two builds that are the same: a model, by
// simulation. It is not a measurement and no check runs it; the kit's page (The hosted job) and
// docs/design.md#choice-counted-or-measured give its figures and say what they are worth.
//
// A job is three comparisons, one for each idle reading. A comparison is three runs of base and
// three of head, every run drawn independently from one normal distribution, since the builds are
// the same, with its mean placed anywhere in a page. Each rule below reads those same six draws
// its own way and allows a rise its own floor, so the rules are compared on the same draws.
//
// The spread is an assumption, not a rate seen on runners: a standard deviation of 1.5 bytes a
// connection over 5,000 connections (7,500 bytes), fitted by eye to the spans the hosted job had
// read when the model was first made. A wider one gives more. Give one spread for all three
// readings or one for each, in bytes a connection, to try another; the mean span of base's three
// that each reading's draws give is printed, to set beside what runs read.
//
//   node bench/request-cost/idle-model.mjs [jobs] [seed] [spread | spread spread spread]
//
// One seed gives the same figures each time (mulberry32). With no arguments: 1,000,000 jobs,
// seed 1, a spread of 1.5.
const [jobs = 1_000_000, seed = 1, ...given] = process.argv.slice(2).map(Number);
const PAGE = 4096, CONNECTIONS = 5000, READINGS = 3;
const spreads = given.length === READINGS ? given : Array.from({ length: READINGS }, () => given[0] ?? 1.5);
if ((given.length > 1 && given.length !== READINGS) || !Number.isSafeInteger(jobs) || jobs <= 0 || !Number.isSafeInteger(seed) || spreads.some((s) => !(s >= 0))) {
  console.error("usage: node idle-model.mjs [jobs] [seed] [spread | spread spread spread], a spread in bytes a connection");
  process.exit(2);
}

let state = seed >>> 0;
const uniform = () => {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const normal = () => Math.sqrt(-2 * Math.log(1 - uniform())) * Math.cos(2 * Math.PI * uniform());
const median = (a) => [...a].sort((x, y) => x - y)[1];
const span = (a) => Math.max(...a) - Math.min(...a);
const pages = (x) => Math.round(x / PAGE) * PAGE;

// Each rule: what a draw in bytes is read as, and the least a rise is allowed.
const rules = {
  "figures a connection, unrounded, base's span alone": { read: (x) => x / CONNECTIONS, floor: 0 },
  "figures a connection, whole bytes, base's span alone": { read: (x) => Math.round(x / CONNECTIONS), floor: 0 },
  "growths in whole pages, base's span alone": { read: pages, floor: 0 },
  "growths in whole pages, one page allowed": { read: pages, floor: PAGE },
  "growths in whole pages, two pages allowed": { read: pages, floor: 2 * PAGE },
  "growths in whole pages, three pages allowed": { read: pages, floor: 3 * PAGE },
  "growths in whole pages, four pages allowed": { read: pages, floor: 4 * PAGE },
};
const names = Object.keys(rules);
const comparisons = Object.fromEntries(names.map((n) => [n, 0])), failed = Object.fromEntries(names.map((n) => [n, 0]));
const spans = spreads.map(() => 0);
for (let job = 0; job < jobs; job += 1) {
  const any = Object.fromEntries(names.map((n) => [n, false]));
  for (let reading = 0; reading < READINGS; reading += 1) {
    const mean = uniform() * PAGE, sd = spreads[reading] * CONNECTIONS;
    const draws = Array.from({ length: 6 }, () => mean + sd * normal());
    spans[reading] += span(draws.slice(0, 3).map(pages));
    for (const name of names) {
      const { read, floor } = rules[name];
      const base = draws.slice(0, 3).map(read), head = draws.slice(3).map(read);
      if (median(head) - median(base) > Math.max(span(base), floor)) {
        comparisons[name] += 1;
        any[name] = true;
      }
    }
  }
  for (const name of names) if (any[name]) failed[name] += 1;
}
console.log(`${jobs.toLocaleString("en-US")} jobs, seed ${seed}, ${CONNECTIONS} connections, ${PAGE}-byte pages`);
spreads.forEach((s, reading) => console.log(`reading ${reading + 1}: a standard deviation of ${s} bytes a connection (${Math.round(s * CONNECTIONS).toLocaleString("en-US")} bytes); base's three growths in whole pages span ${Math.round(spans[reading] / jobs).toLocaleString("en-US")} bytes on average`));
for (const name of names) console.log(`${name}: ${((comparisons[name] / (READINGS * jobs)) * 100).toFixed(2)}% of comparisons, ${((failed[name] / jobs) * 100).toFixed(2)}% of jobs`);
