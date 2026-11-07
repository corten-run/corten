// How each app is built, for build.mjs: the image its toolchain is in, its build context, the
// commands of its Dockerfile's dependency layer and build step, and one edit to its item page's
// view. Kept apart from build.mjs so builds.test.mjs can check it without Docker. No side effects.
import { quote } from "./round.mjs";

/**
 * @typedef {{
 *   tools: string,
 *   stage?: string,
 *   context: string,
 *   workdir: string,
 *   env?: Record<string, string>,
 *   dockerfile?: string,
 *   setup?: string,
 *   add?: string,
 *   deps: string,
 *   build: string,
 *   dev?: string,
 *   check?: string,
 *   test?: string,
 *   edits?: { kind: string, edit: string, from: string, to: string }[],
 *   timings?: { bin: string, own: string[], touch: string },
 *   edit: string,
 *   change?: { from: string, to: string },
 * }} Recipe
 */

/**
 * The edit every rebuild makes: a title on the price-alert form's submit button, in the file that
 * holds the item page's markup for it. Each app's file has exactly one such button
 * (builds.test.mjs checks it), and the change means the same thing in every framework. An app
 * whose markup is not HTML (Maud) says how in its recipe's `change`.
 */
export const button = { from: '<button type="submit">', to: '<button type="submit" title="Set the price alert">' };

/** The htmx their Dockerfiles ADD (checked by its digest), into the directory each serves it from. */
const htmx = (/** @type {string} */ dest) => `--checksum=sha256:d6fdc75f204e6bdefa99b69bf1e6d4ac69b8a364f77929f45c13476b4000f717 https://unpkg.com/htmx.org@2.0.11/dist/htmx.min.js ${dest}`;

/** cargo fetch's flag for the platform it runs on, so it downloads no other platform's crates. */
const hostTarget = '--target "$(rustc -vV | sed -n "s/^host: //p")"';

const node = (/** @type {string} */ file, /** @type {Record<string, string>=} */ env) => ({
  tools: "node:24-bookworm-slim",
  context: "",
  workdir: "/app",
  env,
  deps: "npm install --no-audit --no-fund",
  // The Dockerfiles prune dev dependencies after building; a rebuild needs them, and Docker's
  // rebuild starts from the install layer before the prune, so the prune is left out.
  build: "npm run build",
  edit: file,
});

/**
 * The apps' recipes. `context` is relative to the repository root (empty: the app's directory
 * under bench/fullstack/apps), as is `stage`'s Dockerfile; `edit` and `timings.touch` are relative
 * to the context. `stage` names a stage of the app's Dockerfile to build `tools` from; otherwise
 * `tools` is an image. `dev` is the build a development loop runs after each save (`corten dev`
 * runs `cargo build`), for the apps whose dev loop compiles; the others' dev servers compile what
 * a request needs as it comes, which this does not measure. `add` is what the Dockerfile ADDs from
 * the network after copying the source (an ADD line's arguments). `setup` runs once in the source
 * image, untimed, for what the steps need that the toolchain image lacks (bash and GNU date on
 * Alpine, an empty Go build cache). The Rust Dockerfiles fetch and compile their crates in one
 * step; `cargo fetch` (for the build's own platforms) is this benchmark's, so downloading is timed
 * apart from compiling as in the other apps. `dockerfile` is the app's Dockerfile, relative to the
 * repository root, when it is not in its context. `timings` asks for cargo's per-crate
 * timings and rustc's passes and macro expansion for one binary, whose own crates' names start
 * with one of `own`.
 *
 * For the Rust apps, the editor's and the tests' loops too: `check` is what an editor runs for its
 * diagnostics after a save (rust-analyzer's check on save is `cargo check`, with the features its
 * documentation has an editor set), and `test` compiles the tests without running them. `edits`
 * are other kinds of change than the button's, each measured as a development rebuild: `kind`
 * names it, `edit` is its file (relative to the context) and `from` must appear in it once.
 * @type {Record<string, Recipe>}
 */
export const recipes = {
  corten: {
    tools: "rust:1-bookworm",
    context: ".",
    dockerfile: "examples/card-market/Dockerfile",
    workdir: "/src",
    // zstd from the image's libzstd, as the Dockerfile builds it.
    env: { ZSTD_SYS_USE_PKG_CONFIG: "1" },
    // The workspace's lockfile names every example's dependencies, so this downloads more than
    // card-market builds; the build compiles only what card-market needs.
    deps: `cargo fetch ${hostTarget}`,
    build: "cargo build --release -p card-market",
    dev: "cargo build -p card-market",
    check: "cargo check -p card-market",
    test: "cargo test -p card-market --no-run",
    edit: "examples/card-market/src/views/alert.rs",
    edits: [
      { kind: "handler", edit: "examples/card-market/src/app.rs", from: "for v in found.iter().take(4) {", to: "for v in found.iter().take(5) {" },
      {
        kind: "shared type",
        edit: "examples/card-market/src/model.rs",
        from: "#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToJson)]\npub struct Summary {",
        to: "#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToJson)]\npub struct Summary {",
      },
      { kind: "message", edit: "examples/card-market/locales/en.json", from: '"near_mint": "Near Mint",', to: '"near_mint": "Near mint",' },
      {
        kind: "route",
        edit: "examples/card-market/src/main.rs",
        from: "    pub struct Sitemap;\n",
        to: '    pub struct Sitemap;\n\n    #[route("/humans.txt", get = app::robots)]\n    pub struct Humans;\n',
      },
    ],
    timings: { bin: "card-market", own: ["corten", "card-market"], touch: "examples/card-market/src/main.rs" },
  },
  leptos: {
    tools: "bb-tools-leptos",
    stage: "bench/fullstack/apps/leptos",
    context: "",
    workdir: "/src",
    deps: `cargo fetch ${hostTarget} --target wasm32-unknown-unknown`,
    build: "cargo leptos build --release",
    dev: "cargo leptos build",
    // The server's code, as Leptos's documentation has rust-analyzer check it.
    check: "cargo check --features ssr",
    test: "cargo test --features ssr --no-run",
    edit: "src/app.rs",
  },
  topcoat: {
    tools: "bb-tools-topcoat",
    stage: "bench/fullstack/apps/topcoat",
    context: "",
    workdir: "/src",
    deps: `cargo fetch --locked ${hostTarget}`,
    build: "cargo build --release --locked && topcoat asset bundle --release",
    dev: "cargo build --locked",
    check: "cargo check --locked",
    test: "cargo test --locked --no-run",
    edit: "src/main.rs",
  },
  "axum-maud": {
    tools: "rust:1-bookworm",
    context: "",
    workdir: "/src",
    deps: `cargo fetch --locked ${hostTarget}`,
    build: "cargo build --release --locked",
    dev: "cargo build --locked",
    check: "cargo check --locked",
    test: "cargo test --locked --no-run",
    edit: "src/pages.rs",
    change: { from: 'button type="submit" {', to: 'button type="submit" title="Set the price alert" {' },
  },
  gin: {
    tools: "bb-tools-gin",
    stage: "bench/fullstack/apps/gin",
    context: "",
    workdir: "/src",
    // templ's install leaves its packages built in the cache, which the app's build would reuse.
    setup: "apk add --no-cache bash coreutils sed && go clean -cache -modcache",
    deps: "go mod download",
    build: 'templ generate && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/itempage .',
    dev: "templ generate && go build -o /tmp/itempage .",
    edit: "views.templ",
  },
  drogon: {
    tools: "bb-tools-drogon",
    stage: "bench/fullstack/apps/drogon",
    context: "",
    workdir: "/src",
    add: htmx("static/htmx.min.js"),
    // Drogon from its tagged release, built and installed as its Dockerfile does: a C++ app's
    // framework, compiled from source as the Rust apps' are.
    deps: [
      "git clone --quiet --depth 1 --branch v1.9.14 --recurse-submodules --shallow-submodules https://github.com/drogonframework/drogon /drogon",
      'test "$(git -C /drogon rev-parse HEAD)" = 3aae769cc405cf5abb9d477675c6430924f02c7c',
      "cmake -S /drogon -B /drogon/build -DCMAKE_BUILD_TYPE=Release -DBUILD_EXAMPLES=OFF -DBUILD_ORM=OFF -DBUILD_TESTING=OFF",
      'cmake --build /drogon/build -j"$(nproc)"',
      "cmake --install /drogon/build",
      "rm -rf /drogon",
    ].join(" && "),
    build: 'cmake -S . -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build -j"$(nproc)"',
    dev: 'cmake -S . -B debug -DCMAKE_BUILD_TYPE=Debug && cmake --build debug -j"$(nproc)"',
    edit: "views/ItemPage.csp",
  },
  nextjs: node("app/items/[id]/interactive.tsx", { NEXT_TELEMETRY_DISABLED: "1" }),
  "tanstack-start": node("src/routes/items.$id.tsx"),
  sveltekit: node("src/routes/items/[id]/+page.svelte"),
  "react-router": node("app/routes/item.tsx"),
  astro: node("src/pages/items/[id].astro"),
  nuxt: node("app/pages/items/[id].vue"),
  aspnet: {
    tools: "mcr.microsoft.com/dotnet/sdk:10.0",
    context: "",
    workdir: "/src",
    add: htmx("wwwroot/htmx.min.js"),
    deps: "dotnet restore",
    build: "dotnet publish -c Release -o /out --no-restore",
    edit: "Pages/Item.cshtml",
  },
  spring: {
    tools: "maven:3.9-eclipse-temurin-25",
    context: "",
    workdir: "/src",
    add: htmx("src/main/resources/static/htmx.min.js"),
    deps: "mvn -q -B dependency:go-offline",
    build: "mvn -q -B package -DskipTests",
    edit: "src/main/resources/templates/item.html",
  },
  django: {
    tools: "python:3.14-slim",
    context: "",
    workdir: "/app",
    env: { PYTHONDONTWRITEBYTECODE: "1", PYTHONUNBUFFERED: "1", DJANGO_SETTINGS_MODULE: "itempage.settings" },
    add: htmx("static/htmx.min.js"),
    deps: "pip install --no-cache-dir -r requirements.txt",
    build: "python -m django collectstatic --noinput -v 0",
    edit: "templates/item.html",
  },
  rails: {
    tools: "bb-tools-rails",
    stage: "bench/fullstack/apps/rails",
    context: "",
    workdir: "/rails",
    deps: 'bundle install && rm -rf ~/.bundle/ "${BUNDLE_PATH}"/ruby/*/cache "${BUNDLE_PATH}"/ruby/*/bundler/gems/*/.git && bundle exec bootsnap precompile -j 1 --gemfile',
    build: "chmod +x bin/* && bundle exec bootsnap precompile -j 1 app/ lib/ && SECRET_KEY_BASE_DUMMY=1 ./bin/rails assets:precompile",
    edit: "app/views/items/show.html.erb",
  },
  laravel: {
    tools: "bb-tools-laravel",
    stage: "bench/fullstack/apps/laravel",
    context: "",
    workdir: "/app",
    deps: "composer install --no-dev --no-interaction --no-scripts --no-autoloader --prefer-dist -q",
    build: [
      "cp .env.example .env && composer dump-autoload --optimize --no-dev -q",
      "php artisan key:generate --force -q && php artisan package:discover -q",
      "php artisan octane:install --server=frankenphp -n -q",
      "php artisan route:cache -q && php artisan view:cache -q",
    ].join(" && "),
    edit: "resources/views/livewire/price-alert.blade.php",
  },
  phoenix: {
    tools: "bb-tools-phoenix",
    stage: "bench/fullstack/apps/phoenix",
    context: "",
    workdir: "/app",
    deps: "mix deps.get --only prod && mix deps.compile",
    // --overwrite: a rebuild replaces the release the clean build made rather than asking.
    build: "mix compile && mix esbuild.install --if-missing && mix assets.deploy && mix release --overwrite",
    edit: "lib/item_page_web/live/item_live.ex",
  },
};

/**
 * `command` after touching `path`, quoted as one shell word: a route's file name can hold `$` or
 * brackets (`items.$id.tsx`, `[id]`), which the shell would otherwise read.
 */
export const touchThen = (/** @type {string} */ path, /** @type {string} */ command) => `touch ${quote(path)} && ${command}`;

/** Whether an app's builds are cargo's, whose output names each crate it compiles. */
export const cargoBuilds = (/** @type {Recipe} */ r) => /\bcargo\b/.test(r.build);

/** The edit an app's rebuilds make. */
export const changeOf = (/** @type {string} */ name) => recipes[name].change ?? button;

/** The app's Dockerfile, relative to the repository root. */
export const dockerfileOf = (/** @type {string} */ name) => recipes[name].dockerfile ?? `${contextOf(name)}/Dockerfile`;

/** The app's build context, relative to the repository root. */
export const contextOf = (/** @type {string} */ name) => recipes[name].context || `bench/fullstack/apps/${name}`;

/** The Dockerfile build.mjs builds an app's source image from: its toolchain and its context. */
export const sourceDockerfile = (/** @type {string} */ name) => {
  const r = recipes[name];
  return [
    `FROM ${r.tools}`,
    ...(r.setup ? [`RUN ${r.setup}`] : []),
    ...Object.entries(r.env ?? {}).map(([k, v]) => `ENV ${k}=${JSON.stringify(v)}`),
    `WORKDIR ${r.workdir}`,
    "COPY . .",
    ...(r.add ? [`ADD ${r.add}`] : []),
    "",
  ].join("\n");
};

/**
 * The script one measured step runs in its container: `command` with its output kept in a file
 * (the last lines printed when it fails), then its wall time, the CPU time the container used while
 * it ran (the cgroup's counter before and after, so neither the container's start nor another
 * cgroup's work counts) and the
 * peak of its anonymous memory (what the processes hold, without the page cache the build's
 * files fill, which the cgroup's own peak counts), sampled five times a second by bash's builtins
 * alone, so the sampler adds no processes' CPU time. It writes its peak when it is stopped. A
 * command that fails also reports how many processes the kernel killed for passing the
 * container's memory cap (memory.events' oom_kill), so a build that ran out of memory says so.
 * @param {string} command
 */
export const stepScript = (command) => [
  "rm -f /tmp/anon-peak",
  "get() { local k v; [[ -r $1 ]] || { echo 0; return; }; while read -r k v; do if [[ $k == \"$2\" ]]; then echo \"$v\"; return; fi; done < \"$1\"; echo 0; }",
  "usec() { get /sys/fs/cgroup/cpu.stat usage_usec; }",
  "anon() { local k v; while read -r k v; do if [[ $k == anon ]]; then a=$v; return; fi; done < /sys/fs/cgroup/memory.stat; }",
  "sample() { local m=0 a=0 t; exec {t}<> <(:); trap 'echo \"$m\" > /tmp/anon-peak; exit 0' TERM; while :; do anon; (( a > m )) && m=$a; read -r -t 0.2 -u \"$t\" _; done; }",
  "sample & sampler=$!",
  "c=$(usec); s=$(date +%s%N)",
  `if ! (${command}) > /tmp/step.log 2>&1; then kill $sampler 2>/dev/null; tail -n 80 /tmp/step.log; echo "BENCH oomKills $(get /sys/fs/cgroup/memory.events oom_kill)"; echo 'BENCH failed'; exit 1; fi`,
  "e=$(date +%s%N)",
  "kill $sampler 2>/dev/null; wait $sampler 2>/dev/null",
  "cat /tmp/step.log",
  "echo \"BENCH ms $(( (e - s) / 1000000 ))\"",
  "echo \"BENCH cpuUsec $(( $(usec) - c ))\"",
  "echo \"BENCH anonPeakBytes $(cat /tmp/anon-peak 2>/dev/null || echo 0)\"",
].join("\n");

/**
 * The measurements in a step's output: `BENCH <key> <number>` lines.
 * @param {string} output
 * @returns {{ ms: number, cpuS: number, peakMiB: number, compiled?: string[] } | null}
 */
export function readStep(output) {
  /** @type {Record<string, number>} */
  const got = {};
  for (const line of output.split("\n")) {
    const m = /^BENCH (\w+) (\d+)\s*$/.exec(line);
    if (m) got[m[1]] = Number(m[2]);
  }
  // No memory sample means the sampler never ran, so the step's numbers are not to be trusted.
  if (!(got.ms >= 0 && got.cpuUsec >= 0 && got.anonPeakBytes > 0)) return null;
  // What cargo compiled (or checked), so a rebuild that compiled more than the edited crate shows it.
  const compiled = [...output.matchAll(/^\s+(?:Compiling|Checking) (\S+) v/gm)].map((m) => m[1]);
  return { ms: got.ms, cpuS: +(got.cpuUsec / 1e6).toFixed(1), peakMiB: Math.round(got.anonPeakBytes / 2 ** 20), ...(compiled.length ? { compiled } : {}) };
}

/** How many processes a failed step's container lost to its memory cap (0 when none, or not said). */
export const oomKills = (/** @type {string} */ output) => Number(/^BENCH oomKills (\d+)\s*$/m.exec(output)?.[1] ?? 0);

/**
 * The units of cargo's `--timings` report (target/cargo-timings/cargo-timing.html), which holds
 * them as a JSON array in its script, `const UNIT_DATA = [...];`.
 * @param {string} html
 * @returns {{ name: string, version: string, target: string, start: number, duration: number }[]}
 */
export function timingUnits(html) {
  const start = html.indexOf("const UNIT_DATA = ");
  const end = html.indexOf("\n];", start);
  if (start < 0 || end < 0) throw new Error("cargo's timing report has no UNIT_DATA: its format changed");
  return JSON.parse(html.slice(start + "const UNIT_DATA = ".length, end + 2));
}

/**
 * Where a clean build's compile time went, from its timing units: each unit's seconds summed
 * (units run side by side, so the sum is more than the wall time), split between the app's own
 * crates and its dependencies, and the slowest units, each with when it started and ended (seconds
 * into the build), so what held up the app's own crates shows.
 * @param {{ name: string, target: string, start: number, duration: number }[]} units
 * @param {string[]} own name prefixes of the app's own crates
 */
export function crateCost(units, own) {
  const isOwn = (/** @type {string} */ name) => own.some((p) => name === p || name.startsWith(`${p}-`) || name.startsWith(`${p}_`));
  const sum = (/** @type {typeof units} */ list) => +list.reduce((n, u) => n + u.duration, 0).toFixed(1);
  const entry = (/** @type {typeof units[number]} */ u) => ({ name: u.name, target: u.target.trim(), seconds: u.duration, start: u.start, end: +(u.start + u.duration).toFixed(2) });
  return {
    units: units.length,
    unitSeconds: sum(units),
    ownSeconds: sum(units.filter((u) => isOwn(u.name))),
    dependencySeconds: sum(units.filter((u) => !isOwn(u.name))),
    own: units.filter((u) => isOwn(u.name)).map(entry),
    slowest: [...units].sort((a, b) => b.duration - a.duration).slice(0, 12).map(entry),
  };
}

/**
 * rustc's `-Ztime-passes` lines (`time: 1.234; rss: 1MB -> 2MB (+1MB) name`) of 0.05 s or more,
 * in order, its `total` line apart (the crate's compile time, or null without one), and its
 * `-Zmacro-stats` rows (name, uses, lines, average, bytes, average), the most lines first. The
 * passes nest, so they do not add up to the total: `finish_ongoing_codegen` holds `LLVM_passes`
 * and `LLVM_thinlto`, `link` holds `link_crate`, and in r14 card-market's passes summed to
 * 74.5 s against a total of 37.8 s (and cargo's `--timings` 37.9 s for the crate). Rounds to r14
 * kept `total` inside `passes`, so their `build.json` has it there.
 * @param {string} output
 */
export function rustcPasses(output) {
  /** @type {number | null} */
  let total = null;
  const passes = [];
  const macros = [];
  const num = (/** @type {string} */ s) => Number(s.replace(/[,_]/g, ""));
  // A name too long for its column is on a line of its own, with its numbers on the next.
  let wrapped = "";
  for (const line of output.replace(/\r/g, "").split("\n")) {
    const t = /^time:\s+([\d.]+);\s+rss:\s+(\S+)\s+->\s+(\S+)\s+\(\s*\S+\)\s+(\S+)\s*$/.exec(line);
    if (t && t[4] === "total") total = Number(t[1]);
    else if (t && Number(t[1]) >= 0.05) passes.push({ pass: t[4], seconds: Number(t[1]), rssAfter: t[3] });
    const row = /^macro-stats\s+(\S.*?)?\s+([\d,_]+)\s+([\d,_]+)\s+([\d,_.]+)\s+([\d,_]+)\s+([\d,_.]+)\s*$/.exec(line);
    if (row) {
      const name = row[1] ?? wrapped;
      if (name) macros.push({ macro: name, uses: num(row[2]), lines: num(row[3]), bytes: num(row[5]) });
      wrapped = "";
      continue;
    }
    const lone = /^macro-stats\s+(\S+)\s*$/.exec(line);
    wrapped = lone && !/^[=-]+$/.test(lone[1]) ? lone[1] : "";
  }
  return { total, passes, macros: macros.sort((a, b) => b.lines - a.lines).slice(0, 20) };
}

/** The median of some numbers. */
export const median = (/** @type {number[]} */ xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
