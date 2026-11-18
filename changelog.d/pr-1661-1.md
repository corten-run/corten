- Builds without `compress` no longer generate page ETags for clients that do not explicitly
  accept a non-identity content coding, unless the request sends `If-None-Match`.
