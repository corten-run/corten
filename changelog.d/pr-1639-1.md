- Stop Nuxt catalog pages from prefetching the unrelated home chunk, which Chromium could
  cancel during catalog navigation. Keep the home link and browser resource checks intact.
