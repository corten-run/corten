- **Breaking:** A request HTTP does not allow gets `400` before anything of the app runs: an HTTP/1.1 request with
  no `Host` line (a health check written by hand must send one), any with two, a `Host` that is no host, a target
  outside ASCII, or `*` without `OPTIONS` ([RFC 9112, 3.2](https://www.rfc-editor.org/rfc/rfc9112#section-3.2)).
