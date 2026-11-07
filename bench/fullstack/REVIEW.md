# Reviewing a bench/fullstack app

This is for people who work on one of the frameworks in [the full-stack comparison](README.md).
Each app in `apps/` was written by Corten's maintainers in what we took to be its framework's
usual way. If yours is set up in a way its users would not deploy, the comparison is wrong, and
we want to fix it.

## What is measured

Every app serves the same marketplace item page (the same markup and stylesheets as Corten's
card-market example, checked by `parity.mjs` and `look.mjs`) and the same item as JSON;
`aspnet-aot` serves only the JSON. Each runs in one CPU and 1 GiB. A round measures:

1. Requests a second and per CPU-second under load, at a fixed rate and at 64 and 256 users,
   with items in memory and fetched from an item API (`run-ssr.mjs`).
2. Instructions per request (`count.mjs`), cold start, the bytes a page loads, and the build
   time.
3. In Chromium, on desktop and a throttled phone profile: a cold load of the item page, a
   client-side navigation and the form action (`browser.mjs`).
4. What each app does around the page: headers, caching, errors, limits, health endpoints
   (`conform.mjs`, the feature matrix).

The README's Method and Caveats sections say how. Caveat 5 gives the rule for worker counts (the
app table's Stack column has each app's) and the settings chosen so the item API does the same work
in every app, and caveat 15 the logging; each app's Dockerfile and settings files have the rest.

There are two tiers:

1. **Defaults**: each app as its framework starts it in production mode, with the worker count
   its documentation gives for one CPU. This shows what a framework gives you as it comes.
2. **Matched**: the apps add a production profile, started by `PROFILE=matched` and
   `MAX_CONNECTIONS`, each with only what its framework, or the companion its documentation
   points to, provides; a part the framework has nothing for stays unmet (README, "The matched
   tier", which names the tier's apps and which of them have their profile so far). An app joins
   the tier once it starts with its profile.

## What may change

1. In the defaults tier, a setting stays the framework's production default unless its
   documentation says a production deployment changes it: the production build or mode, worker
   and thread counts for one CPU, the runtime version. A setting that makes the app do the same
   work as the others (caveat 5's connection pools to the item API) stays, or is replaced by one
   that does the same work. A setting a review changes from its default goes into caveat 5,
   with the documentation that recommends it, or why it keeps the work the same.
2. The app's code, written the way the framework's users write it (its templates, components,
   routing, forms and data loading), as long as `check-app.mjs` passes and the page keeps the
   same interactions as every other app (README, the paragraphs after the app table: the sort,
   the form action, client-side navigation, and "Show all" as a GET form that works without
   JavaScript). Streaming the page counts as tuning (caveat 5) unless the framework's
   documentation makes it the usual way to render a page; say which in the pull request.
3. In the matched tier, which middleware, settings or builder options meet each part of the
   profile.

## What may not

1. Caching a rendered page or the JSON on the server, or anything else that skips work a request
   asks for. The cache headers, ETag and 304 the matched profile asks for are not this: they tell
   the client, and every request is still rendered.
2. Rendering the page at build time or serving it as a static file.
3. Changing what the page or the JSON says, the page's markup or its styles (`check-app.mjs`
   compares them with Corten's).
4. Tuning beyond what the framework's documentation recommends for one CPU, such as more
   processes than its guidance, or a setting chosen only to pass a test (caveat 5).
5. In the matched tier, tuning beyond the profile, or writing a handler, error mapper or server
   loop by hand for a part the framework does not provide.

## How to propose a change

Open a pull request that changes `bench/fullstack/apps/<app>`, with what you changed and why its
users would deploy it that way. Update with it:

1. The app's build recipe in `builds.mjs` when its Dockerfile changes, or the file with the
   price-alert form moves or its submit button changes (`builds.test.mjs`, run by
   `npm run check`, checks both).
2. The README's Stack column and the label in `apps.mjs` when a version changes.
3. Caveat 5 when the change sets a setting away from its default.

Keep the `/live/...` routes: [bench/live](../live/README.md) measures them from the same images
(caveat 6).

`check-app.mjs` must pass. It needs the item fixture (`bench/fullstack/fixtures/items.json`), which
is made from an item API that is not in this repository (caveat 2), so a Corten maintainer runs it
on the pull request and posts its output. With a fixture of your own (items shaped as in
`examples/card-market/fixtures/demo.json`, under the ids `bench/fullstack/fixtures/fetch.mjs`
lists), from the repository root:

```sh
npm ci && npx playwright install chromium
docker build -f examples/card-market/Dockerfile -t cb-corten .
docker build -t cb-<app> bench/fullstack/apps/<app>
node bench/fullstack/check-app.mjs <app>
```

The next round that includes the app measures it as changed; the numbers from before stay in
the rounds that measured them, which name the commit they ran.

A review that finds nothing to change counts too: say so in an issue or a pull request.

## The record

Each app's row in the README's app table says whether its framework's maintainers have reviewed
it: who, when, and what changed, with a link to the review. Corten's maintainers update the row
when a review is done. A row that says "not yet" has had no outside review.
