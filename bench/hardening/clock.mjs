// Same Linux kernel CLOCK_MONOTONIC as the injector, including on Docker Desktop.
// This short-lived observer exits before the parent verifies zero owned containers.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
export const nativeClock = () => ({ monotonicNs: String(process.hrtime.bigint()),
  bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() });
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(JSON.stringify(nativeClock()));
