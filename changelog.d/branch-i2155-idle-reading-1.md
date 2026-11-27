- The request-cost idle tests read a resident memory the stand-in writes, named by
  `IDLE_STATUS_ROOT`, and assert each run's before, after and growth, so a run that reads memory
  once fails them; a run on a host still reads the probe's own `/proc` status
  ([#2155 The idle tests read the stand-in's real resident memory, so a stale after reading passes them](https://github.com/corten-run/corten/issues/2155)).
