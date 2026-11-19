- The Corten catalog benchmark app parses `API_BASE` once at startup and does not follow an upstream's
  redirects, as the axum + Maud contender does. A base no path can be added to now fails at startup,
  not on the first request.
