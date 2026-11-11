// @ts-check
import { ready } from "corten";

// The browser benchmark waits for this mark: the first page's scripts are imported.
ready.then(() => {
  /** @type {Window & { __hydratedAt?: number }} */ (window).__hydratedAt = performance.now();
});
