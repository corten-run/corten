// node --test bench/request-cost/allocations.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { allocatorCalls, instructions } from "./allocations.mjs";

// The shape of a callgrind profile written with --compress-strings=no: a caller's object and
// function, then for each function it calls the callee's object, its name, and the calls.
const profile = `# callgrind format
version: 1
part: 2
thread: 1
events: Ir
summary: 18971934

ob=/work/target/release/probe
fl=/work/crates/corten/src/app.rs
fn=corten::app::serve
16 400
cob=/usr/lib/x86_64-linux-gnu/libjemalloc.so.2
cfi=???
cfn=malloc
calls=16000 0
16 1200000
cfn=free
calls=15000 0
17 900000
cfn=realloc
calls=1000 0
18 90000

fn=core::ptr::drop_in_place
cob=/usr/lib/x86_64-linux-gnu/libjemalloc.so.2
cfn=free
calls=1020 0
20 61200
cob=/work/target/release/probe
cfn=corten::app::answer
calls=1000 0
21 5000

ob=/usr/lib/x86_64-linux-gnu/libjemalloc.so.2
fl=???
fn=realloc
cfn=malloc
calls=7 0
0 700
cfn=free'2
calls=7 0
0 500

totals: 18971934
`;

test("a profile's instructions are its totals line, read whole", () => {
  assert.equal(instructions(profile), 18_971_934);
  assert.equal(instructions("events: Ir\nsummary: 7\n\ntotals: 221809112\n"), 221_809_112);
  assert.throws(() => instructions("events: Ir\nsummary: 7\nsubtotals: 9\n"), /without a totals line/);
});

test("calls into the allocator are counted by function, and jemalloc's calls to itself are not", () => {
  assert.deepEqual(allocatorCalls(profile), { allocations: 17000, frees: 16020, calls: { malloc: 16000, free: 16020, realloc: 1000 } });
});

test("a function callgrind names again for a call to itself counts under its own name", () => {
  const again = "ob=/work/probe\nfn=a\ncfn=malloc'2\ncalls=3 0\n1 1\ncfn=sdallocx\ncalls=2 0\n1 1\n";
  assert.deepEqual(allocatorCalls(again), { allocations: 3, frees: 2, calls: { malloc: 3, sdallocx: 2 } });
});

test("every allocating and freeing function counts as one", () => {
  const called = (/** @type {string[]} */ names) => "ob=/work/probe\nfn=a\n" + names.map((name, at) => `cfn=${name}\ncalls=${at + 1} 0\n1 1\n`).join("");
  const found = allocatorCalls(called(["malloc", "calloc", "realloc", "posix_memalign", "aligned_alloc", "memalign", "mallocx", "rallocx", "free", "sdallocx", "dallocx"]));
  assert.equal(found.allocations, 1 + 2 + 3 + 4 + 5 + 6 + 7 + 8);
  assert.equal(found.frees, 9 + 10 + 11);
});

test("a profile with no call into the allocator counts none", () => {
  assert.deepEqual(allocatorCalls("ob=/work/probe\nfn=a\ncfn=b\ncalls=4 0\n1 1\n"), { allocations: 0, frees: 0, calls: {} });
});

test("the allocator is jemalloc's library, not a program built under a directory of that name", () => {
  const built = "ob=/work/jemalloc-kit/target/release/probe\nfn=a\ncfn=malloc\ncalls=5 0\n1 1\n";
  assert.deepEqual(allocatorCalls(built), { allocations: 5, frees: 0, calls: { malloc: 5 } });
});

test("a calls line belongs to the function named just before it, and one without is refused", () => {
  assert.throws(() => allocatorCalls("ob=/work/probe\nfn=a\ncfn=malloc\ncalls=5 0\n1 1\ncalls=5 0\n1 1\n"), /without the function called/);
});
