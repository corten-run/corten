- The Corten catalog benchmark app parses `API_BASE` once at startup, follows no redirect from its
  upstream and reads only a successful answer as a record, as the axum + Maud contender does. An
  `API_BASE` that is empty, not a URL or one no path can be added to now stops the app at startup;
  before, every request that fetched a record failed.
