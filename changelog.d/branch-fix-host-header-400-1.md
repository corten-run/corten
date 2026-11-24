- **Breaking:** A request HTTP does not allow gets `400` before anything of the app runs: an HTTP/1.1 request
  with no `Host` line, any request with two, a `Host` that is not a host and maybe a port, a request-target with a
  byte outside ASCII, or `*` without `OPTIONS`. A health check written by hand sends `Host`
  ([RFC 9112, 3.2](https://www.rfc-editor.org/rfc/rfc9112#section-3.2)).
