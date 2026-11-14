import { readFileSync } from "node:fs";

// Only verified record-response violations can become replayable negative attempts.
// Browser/harness failures need not write that artifact; retain their original error.
export function readFailedCheck(file, checkerError, verify) {
  try {
    const failure = JSON.parse(readFileSync(file, "utf8"));
    verify(failure);
    return { failure };
  } catch (error) {
    throw new Error(`${checkerError.message}\nFailed-check evidence unavailable or invalid: ${error.message}`, { cause: checkerError });
  }
}
