- Benchmark CI checks the pinned runtime images, client-heavy replay and host proof, htmx source,
  and simulated launch and cleanup failures without starting benchmark apps.
  ([#1583 Eight hermetic benchmark test files run in no check, and one of them, node-runtime.test.mjs, has failed unnoticed since the catalog's Node pin moved to raw.mjs](https://github.com/corten-run/corten/issues/1583))
