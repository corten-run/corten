// Validate an extracted formatting capture only. No Docker, HTTP or benchmark launch.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkFormattingCapture } from "./contract.mjs";

try {
  assert.equal(process.argv.length, 3, "usage: node bench/marketplace/check-capture.mjs <capture.json>");
  const capture = JSON.parse(readFileSync(process.argv[2], "utf8"));
  console.log(JSON.stringify(checkFormattingCapture(capture), null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
