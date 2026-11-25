- JSON API benchmark replay recognizes k6's wrapped request-timeout warning when
  the captured metrics account for it. The run still fails its load threshold
  ([#2058 JSON API r67 rejects k6’s wrapped request timeout warning despite counted timeouts](https://github.com/corten-run/corten/issues/2058)).
