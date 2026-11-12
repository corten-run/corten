// Same Linux kernel CLOCK_MONOTONIC as the injector, including on Docker Desktop.
// This short-lived observer exits before the parent verifies zero owned containers.
import { readFileSync } from "node:fs";
console.log(JSON.stringify({ monotonicNs: String(process.hrtime.bigint()),
  bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() }));
