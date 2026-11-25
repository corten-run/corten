- The JSON API benchmark can run its load generator on CPUs 4-15 of a 16-CPU host with the opt-in `json-c16-generator-v1` layout; default runs and saved results are unchanged.
  This is apparatus placement, not a measured speedup. [#2057 JSON API r67 has insufficient apparatus headroom during fast adapters' warmups](https://github.com/corten-run/corten/issues/2057).
