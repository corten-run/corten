import assert from "node:assert/strict";
import { test } from "node:test";
import { capture } from "./catalog-observer-probe.mjs";

test("hosted catalog log retains only fixed operations, codes and integer timing", () => {
  const fixed = ["process-name-recheck", "process-pid-changed", "process-start-changed", "process-stat-recheck",
    "snapshot-membership-recheck", "executable-capture", "executable-proof",
    "executable-recheck", "executable-recheck-renamed", "executable-recheck-inode", "executable-recheck-reference",
    "executable-recheck-size-or-mtime", "executable-recheck-ctime", "executable-recheck-pin", "executable-recheck-successor"];
  for (const operation of fixed) assert.deepEqual(capture({ operation, code: "ERR_ASSERTION", samples: 2,
    catalogCensus: { entryGapMs: 100, censusMs: 3, attempts: 2 } }), {
    operation, code: "ERR_ASSERTION", samples: 2, entryGapMs: 100, censusMs: 3, attempts: 2,
  });
  for (const operation of ["/proc/123/exe", "executable-recheck-inode\nprivate", {}, null, undefined]) {
    assert.deepEqual(capture({ operation, code: "/private", samples: "unbounded", catalogCensus: { attempts: {} }, path: "/private" }),
      { operation: "unknown", code: "unknown", samples: null, entryGapMs: null, censusMs: null, attempts: null });
  }
  assert.equal(capture(null), null);
});
