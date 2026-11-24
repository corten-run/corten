- **Breaking:** A request HTTP does not allow gets `400` before anything of the app runs: an HTTP/1.1 request
  with no `Host` line or with two, a `Host` that is not a host and maybe a port (`421` before), a request-target
  with a byte outside ASCII, or `*` without `OPTIONS`. HTTP/1.0 and `app.test()` still need no `Host`; a
  hand-written HTTP/1.1 health check must send one
  ([RFC 9112, 3.2](https://www.rfc-editor.org/rfc/rfc9112#section-3.2)).
