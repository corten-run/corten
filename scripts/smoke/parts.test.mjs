import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { failedPartLink } from "./parts.mjs";

for (const pending of ["context", "page"]) {
  test(`failed-part setup closes its context when opening the ${pending} times out`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const started = Promise.withResolvers();
    const release = Promise.withResolvers();
    let closed = 0;
    let pages = 0;
    const context = {
      async newPage() {
        pages++;
        if (pending === "page") {
          started.resolve();
          await release.promise;
        }
        return { context: () => context };
      },
      async close() { closed++; },
    };
    const browser = {
      async newContext() {
        if (pending === "context") {
          started.resolve();
          await release.promise;
        }
        return context;
      },
      async newPage() { return (await this.newContext()).newPage(); },
    };

    const result = failedPartLink(/** @type {any} */ (browser));
    await started.promise;
    t.mock.timers.tick(10_000);
    assert.match(await result, /failed-part setup timed out/);
    assert.equal(closed, pending === "page" ? 1 : 0);

    release.resolve();
    await nextTurn();
    assert.equal(closed, 1);
    assert.equal(pages, pending === "page" ? 1 : 0, "do not open a page in a late context");
  });
}
