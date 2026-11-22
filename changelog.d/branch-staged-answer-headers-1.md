- A text or bytes answer (`String`, `&'static str`, `Bytes`, `Media`) makes its header map once,
  with room for the headers the app adds, so the security headers no longer grow it on every request.
