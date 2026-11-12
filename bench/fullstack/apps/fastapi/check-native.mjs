// Only the HTTP test driver is shared; this starts FastAPI's own native image and sources.
import { checkNative } from "../express/check-native.mjs";
await checkNative("fastapi", process.argv[2], { quick: process.argv.includes("--quick"), regressionsOnly: process.argv.includes("--regressions-only"), label: process.argv.includes("--before") ? "before" : "after" });
