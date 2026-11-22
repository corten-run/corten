- Dedicated benchmark hosts now get an SSH-free window to let the root user
  manager exit before provisioning, without stopping competing work or changing
  the measured workload.
  [#1941 Recoverable-live setup waits for the root user manager until timeout before any adapter runs](https://github.com/corten-run/corten/issues/1941).
