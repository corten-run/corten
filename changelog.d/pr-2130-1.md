- A benchmark observer that sees a Docker participant rename itself or exec its
  entrypoint just after it starts takes that participant's snapshot again, starting
  no new attempt after 250 ms, and admits it only for the same container start, PID and process
  start time. Any other missing snapshot still cancels the run
  ([#2052 Fullstack Browser r70 is cancelled after builds and before any browser case runs](https://github.com/corten-run/corten/issues/2052)).
