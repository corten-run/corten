- A connection keeps one timer for its requests' deadlines once a handler of its has waited,
  instead of making one a request, which took a lock all threads share twice a request. Deadlines
  fire when they did. Found while measuring [#2003 Proposal: serve each connection on the core that accepted it (App::per_core), opt-in](https://github.com/corten-run/corten/pull/2003).
