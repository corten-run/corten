- **Breaking:** `corten-cluster` uses async-nats 0.53 for its TLS and server-discovery fixes.
  Set `async-nats = "0.53"` in the app's `Cargo.toml` so its client matches `Cluster::start`.
  Review the [async-nats 0.53 release notes](https://github.com/nats-io/nats.rs/releases/tag/async-nats%2Fv0.53.0)
  for changes to connection settings.
