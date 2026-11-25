// Reads a callgrind profile for the calls a program makes into its allocator.

const ALLOCATES = new Set(["malloc", "calloc", "realloc", "posix_memalign", "aligned_alloc", "memalign", "mallocx", "rallocx"]);
const FREES = new Set(["free", "sdallocx", "dallocx"]);

/**
 * Calls into the allocator from outside it: allocations (malloc, calloc, realloc and the aligned
 * forms), frees, and each function's own count. A call jemalloc makes to itself is not one. The
 * profile is one written with `--compress-strings=no`, so every line names its function in full.
 * @param {string} profile
 */
export function allocatorCalls(profile) {
  /** @type {Record<string, number>} */
  const calls = {};
  let object = "";
  /** @type {string | null} */
  let callee = null;
  for (const line of profile.split("\n")) {
    if (line.startsWith("ob=")) object = line.slice(3).trim();
    else if (line.startsWith("cfn=")) callee = line.slice(4).trim();
    else if (line.startsWith("calls=") && callee !== null) {
      // A function callgrind saw call itself is named again with `'2`.
      const name = /** @type {string} */ (callee.split("'")[0]);
      if (!object.includes("jemalloc") && (ALLOCATES.has(name) || FREES.has(name))) {
        calls[name] = (calls[name] ?? 0) + Number(line.slice(6).trim().split(/\s+/)[0]);
      }
      callee = null;
    }
  }
  const total = (/** @type {Set<string>} */ names) => Object.entries(calls).reduce((sum, [name, count]) => sum + (names.has(name) ? count : 0), 0);
  return { allocations: total(ALLOCATES), frees: total(FREES), calls };
}
