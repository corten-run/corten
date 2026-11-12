// Read-only deployment selection. This module never builds, launches or promotes an image.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { qualificationSettings } from "../marketplace/feature-contract.mjs";
import { contractSha256, definition, groupNames, registrySchema, retainedFamilies, selectedApps } from "./registry.mjs";

export const deploymentSchema = "benchmark-deployments/v1";
export const receiptSchema = "benchmark-deployment-review/v1";
const freeze = (value) => {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
// Only JSON values are fingerprinted; reject values JSON.stringify would silently discard.
function canonical(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") { assert.ok(Number.isFinite(value), "finite JSON number required"); return value; }
  if (Array.isArray(value)) return value.map(canonical);
  assert.ok(value && Object.getPrototypeOf(value) === Object.prototype, "plain JSON object required");
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}
export const deploymentSha256 = (value) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const digest = (value, at) => assert.match(value ?? "", /^[a-f0-9]{64}$/, `${at}: sha256 required`);
const string = (value, at) => assert.ok(typeof value === "string" && value.trim(), `${at}: text required`);
function keys(value, wanted, at) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${at}: object required`);
  assert.deepEqual(Object.keys(value).sort(), [...wanted].sort(), `${at}: exact keys required`);
}
const appRoot = (app) => `bench/fullstack/apps/${app}`;
const productionGroups = ["localized-marketplace", "mixed-production", "hardening"];
const profiles = ["aspnet", "nextjs", "express", "fastapi", "django", "leptos", "topcoat"];

// These describe checked-in launch paths, not framework support or passing group results.
const native = freeze({
  aspnet: { framework: "ASP.NET Core Razor Pages", runtime: ".NET 10 JIT", build: "dotnet publish -c Release", server: "Kestrel", workers: "one application process; .NET thread pool", command: ["dotnet", "ItemPage.dll"], refs: ["Program.cs", "ItemPage.csproj"], middleware: "Program.cs: Razor Pages, static files; PROFILE=matched adds native production middleware" },
  "aspnet-aot": { framework: "ASP.NET Core minimal API (JSON only)", runtime: ".NET 10 Native AOT", build: "dotnet publish -c Release -r linux-x64; PublishAot in ItemJson.csproj", server: "Kestrel", workers: "one application process; native .NET thread pool", command: ["/app/ItemJson"], refs: ["Program.cs", "ItemJson.csproj"], middleware: "Program.cs native JSON production middleware; no Razor or HTML substitute" },
  express: { framework: "Express + EJS", runtime: "Node 24", build: "npm install; unbundled server.mjs", server: "node:http + Express", workers: "one application process; no cluster", command: ["node", "server.mjs"], refs: ["server.mjs", "package.json"], middleware: "server.mjs: express.static/urlencoded; PROFILE=matched adds connect-timeout, compression, Helmet, private cache headers" },
  fastapi: { framework: "FastAPI + Jinja2", runtime: "CPython 3.14", build: "pip install requirements.txt", server: "Uvicorn via fastapi run; matched uses uvicorn directly", workers: "one application process; loop/http auto selection from installed uvicorn[standard], must be recorded in receipts", command: ["sh", "-c", 'if [ "$PROFILE" = matched ]; then exec uvicorn app.main:app --host 0.0.0.0 --port 8080 ${MAX_CONNECTIONS:+--limit-concurrency "$MAX_CONNECTIONS"}; else exec fastapi run app/main.py --host 0.0.0.0 --port 8080; fi'], refs: ["requirements.txt", "app/main.py"], middleware: "app/main.py: matched TrustedHost, GZip, production headers and RequestBodyLimit; default leaves these off" },
  django: { framework: "Django templates + htmx", runtime: "CPython 3.14", build: "pip install requirements.txt; collectstatic", server: "Gunicorn WSGI sync", workers: "three preloaded sync workers", command: ["gunicorn", "itempage.wsgi", "--bind", "0.0.0.0:8080", "--workers", "3", "--preload"], refs: ["requirements.txt", "itempage/settings.py", "start_matched.py", "requirements-matched.txt"], middleware: "itempage/settings.py: Security, WhiteNoise, Common, CSRF, clickjacking; matched adds CSP, GZip, ProductionHeaders, host/body bounds" },
  nextjs: { framework: "Next.js Pages Router + React SSR", runtime: "Node 24", build: "npm run build; npm prune --omit=dev", server: "custom Node Next.js server", workers: "one application process", command: ["node", "server.mjs"], refs: ["package.json", "server.mjs", "server-profile.mjs", "next.config.mjs"], middleware: "server-profile.mjs and next.config.mjs; PROFILE=matched is a separate build and runtime configuration" },
  spring: { framework: "Spring Boot + Thymeleaf", runtime: "Java 25 JRE", build: "mvn package -DskipTests", server: "embedded Tomcat", workers: "one JVM; Tomcat-managed thread pool", command: ["java", "-jar", "app.jar"], refs: ["pom.xml", "src/main/resources/application.properties"], middleware: "Spring application and application.properties; no extra production profile asserted" },
  "axum-maud": { framework: "axum + Maud", runtime: "Rust native release", build: "cargo build --release --locked", server: "axum", workers: "one process; Tokio runtime as source configures", command: ["/app/server"], refs: ["Cargo.toml", "src/main.rs"], middleware: "src/main.rs native tower/axum layers" },
  gin: { framework: "Gin + templ", runtime: "Go native", build: "templ generate; CGO_ENABLED=0 go build -trimpath -ldflags=-s -w", server: "Go net/http", workers: "one process; Go scheduler", command: ["/app/itempage"], refs: ["go.mod", "main.go"], middleware: "main.go native Gin handlers; GIN_MODE=release" },
  drogon: { framework: "Drogon CSP views", runtime: "C++ native release", build: "CMake Release; compiled CSP views", server: "Drogon", workers: "one process; IO threads from cpuCount() in src/main.cc", command: ["/app/server"], refs: ["CMakeLists.txt", "src/main.cc"], middleware: "src/main.cc native handlers and static document root" },
  leptos: { framework: "Leptos SSR + WASM hydration", runtime: "Rust native server + browser WASM", build: "cargo leptos build --release --cargo-locked", server: "axum / Leptos", workers: "one process; Tokio runtime as source configures", command: ["/app/server"], refs: ["Cargo.toml", "src/main.rs"], middleware: "src/main.rs native layers; LEPTOS_ENV=PROD" },
  topcoat: { framework: "Topcoat", runtime: "Rust native release", build: "cargo build --release --locked; topcoat asset bundle --release", server: "Topcoat", workers: "one process; native shards as source configures", command: ["/app/server"], refs: ["Cargo.toml", "src/main.rs"], middleware: "src/main.rs native Topcoat configuration" },
  rails: { framework: "Rails + Hotwire", runtime: "CRuby 3.4.11", build: "bundle install; bootsnap precompile; assets:precompile", server: "Puma", workers: "one worker by checked-in default; three request threads (config/puma.rb); receipt must record WEB_CONCURRENCY and RAILS_MAX_THREADS", command: ["./bin/rails", "server"], refs: ["Gemfile", "config/puma.rb", "config/environments/production.rb", "config/cable.yml"], middleware: "Rails production middleware; Action Cable async adapter for live transport; jemalloc preload in Dockerfile" },
  laravel: { framework: "Laravel + Blade / Livewire", runtime: "PHP 8.4", build: "composer --no-dev; optimized autoload; route:cache; view:cache", server: "Octane on FrankenPHP", workers: "two explicitly configured persistent workers; not CPU auto", command: ["php", "artisan", "octane:frankenphp", "--host=0.0.0.0", "--port=8080", "--workers=2"], refs: ["composer.json", "bootstrap/app.php"], middleware: "Laravel bootstrap/app.php middleware; pcntl,intl,zip,opcache,uv installed; php.ini-production; no JIT claim" },
  nuxt: { framework: "Nuxt + Vue", runtime: "Node 24", build: "npm run build", server: "Nitro node output", workers: "one application process", command: ["node", ".output/server/index.mjs"], refs: ["package.json", "nuxt.config.ts"], middleware: "Nuxt/Nitro checked-in configuration" },
  astro: { framework: "Astro + client router", runtime: "Node 24", build: "npm run build; npm prune --omit=dev", server: "Astro Node adapter", workers: "one application process", command: ["node", "--import", "./dist/server/virtual_astro_middleware.mjs", "dist/server/entry.mjs"], refs: ["package.json", "astro.config.mjs"], middleware: "generated middleware preloaded before listening; astro.config.mjs" },
  sveltekit: { framework: "SvelteKit", runtime: "Node 24", build: "npm run build; npm prune --omit=dev", server: "adapter-node", workers: "one application process", command: ["node", "build"], refs: ["package.json", "vite.config.ts"], middleware: "SvelteKit native hooks; workload-specific Dockerfile.marketplace pins origin" },
  "react-router": { framework: "React Router + Express", runtime: "Node 24", build: "npm run build; npm prune --omit=dev", server: "Express + @react-router/express", workers: "one application process", command: ["node", "server.mjs"], refs: ["package.json", "server.mjs", "react-router.config.ts"], middleware: "compression, immutable assets, static files, React Router handler in server.mjs" },
  "tanstack-start": { framework: "TanStack Start + React", runtime: "Node 24", build: "npm run build", server: "Nitro node output", workers: "one application process", command: ["node", ".output/server/index.mjs"], refs: ["package.json", "vite.config.ts"], middleware: "TanStack Start / Nitro plugins in vite.config.ts" },
  phoenix: { framework: "Phoenix + HEEx / LiveView", runtime: "Elixir 1.19 / OTP 28 release", build: "MIX_ENV=prod mix compile; assets.deploy; mix release", server: "Phoenix endpoint (configured adapter)", workers: "one BEAM node; native schedulers; no synthetic worker tuning", command: ["/app/bin/item_page", "start"], refs: ["mix.exs", "config/config.exs", "config/runtime.exs"], middleware: "Phoenix endpoint/router configuration; Channels + PubSub native live transport" },
});

export const optionSources = freeze({
  bunExpress: "https://bun.sh/guides/ecosystem/express",
  bunPackaging: "https://bun.sh/docs/compiler/executables",
  bunBytecode: "https://bun.sh/docs/compiler/bytecode",
  bunMachineAot: "https://bun.sh/docs/compiler/aot",
  aspnetAot: "https://learn.microsoft.com/en-us/aspnet/core/fundamentals/native-aot?view=aspnetcore-10.0",
  pythonServers: "https://docs.djangoproject.com/en/dev/howto/deployment/",
  uvicorn: "https://uvicorn.dev/settings/",
  granian: "https://github.com/emmett-framework/granian",
  nuitka: "https://nuitka.net/user-documentation/user-manual.html",
  phpServers: "https://laravel.com/framework/docs/octane",
  phpCompiler: "https://www.php.net/manual/en/opcache.configuration.php",
});

function representative(group, app) {
  const matched = productionGroups.includes(group) && profiles.includes(app);
  const profile = matched ? "matched" : "framework-default";
  if (group === "client-heavy") {
    const adapter = app === "corten" ? "state" : app;
    return { id: `${app}-browser-production`, app, role: "representative", implementation: "source-present",
      configuration: { framework: app === "corten" ? "Corten views" : app, runtime: "browser ES modules", build: "bench/browser/build.mjs production bundles",
        server: "bench/browser/serve.mjs static host, not an application server comparison", workers: "browser main thread; no synthetic server workers",
        command: ["node", "bench/browser/serve.mjs"], profile: "production", environment: {}, edge: "none configured", middleware: "static benchmark host only",
        builds: { screen: { context: ".", dockerfile: null, args: {} } },
        sourceRefs: ["bench/browser/build.mjs", "bench/browser/serve.mjs", "bench/browser/package.json", `bench/browser/apps/${adapter}`] } };
  }
  if (app === "corten") {
    const area = group === "catalog-page" ? "catalog" : ["live-delivery", "recoverable-live"].includes(group) ? "live/apps" : "marketplace";
    const areas = group === "json-api" ? { "catalog-v1": "catalog", "marketplace-v2": "marketplace" } : { app: area };
    return { id: `corten-${group}-native`, app, role: "representative", implementation: "source-present",
      configuration: { framework: "Corten", runtime: "Rust native release", build: "cargo release using the checked-in Dockerfile and Cargo profiles",
        server: "corten::serve (hyper HTTP/1.1)", workers: "one application process; Tokio configuration from source",
        command: [area === "live/apps" ? "/app/server" : "/server"], profile, environment: matched ? { PROFILE: "matched", MAX_CONNECTIONS: String(qualificationSettings.maxConnections) } : { PROFILE: "" }, edge: "none configured; deployed-edge remains pending exact edge manifest",
        middleware: "native App defaults and app source; no features removed for parity",
        builds: Object.fromEntries(Object.entries(areas).map(([key, path]) => [key, { context: ".", dockerfile: `bench/${path}/corten/Dockerfile`, args: {} }])),
        sourceRefs: [...new Set(Object.values(areas).flatMap((path) => [`bench/${path}/corten/Dockerfile`, `bench/${path}/corten/Cargo.toml`, `bench/${path}/corten/src/main.rs`]))] } };
  }
  const n = native[app]; assert.ok(n, `no deployment manifest for ${app}`);
  const context = appRoot(app), dockerfile = `${context}/${app === "sveltekit" && group === "fullstack-browser" ? "Dockerfile.marketplace" : "Dockerfile"}`;
  const configuration = { framework: n.framework, runtime: n.runtime, build: n.build, server: n.server, workers: n.workers,
    command: n.command, middleware: n.middleware, profile, environment: { ...(n.runtime === "Node 24" ? { NODE_ENV: "production" } : {}),
      PROFILE: matched ? "matched" : "", ...(matched ? { MAX_CONNECTIONS: String(qualificationSettings.maxConnections) } : {}) },
    edge: "none configured; deployed-edge requires its own exact topology and budget",
    builds: Object.fromEntries((group === "json-api" ? ["catalog-v1", "marketplace-v2"] : ["app"]).map((key) => [key, { context, dockerfile, args: matched ? { PROFILE: "matched" } : {} }])),
    sourceRefs: [dockerfile, ...n.refs.map((ref) => `${context}/${ref}`)] };
  if (app === "django" && matched) Object.assign(configuration, { server: "Granian WSGI HTTP/1", workers: "one worker; one runtime thread; one runtime blocking thread; three Python blocking threads (start_matched.py)", command: ["python", "start_matched.py"] });
  if (app === "laravel" && group === "recoverable-live") Object.assign(configuration, {
    command: ["sh", "-c", "php artisan reverb:start --host=0.0.0.0 --port=8081 & exec php artisan octane:frankenphp --host=0.0.0.0 --port=8080 --workers=2"],
    server: "Octane on FrankenPHP + separate Reverb process", workers: "two Octane workers plus Reverb; all inside the same declared app budget",
    sourceRefs: [...configuration.sourceRefs, "bench/live/apps.mjs"],
  });
  return { id: `${app}-${matched ? "matched" : "native"}`, app, role: "representative", implementation: "source-present", configuration };
}

function candidates(group, app, baseline) {
  const choices = [];
  const candidate = (id, change, sources, implementation = "pending-implementation") => choices.push({ id, app, role: "candidate", implementation, basedOn: baseline.id, change, sources,
    reason: "Not qualified. Requires its own exact configuration, native parity and repeated performance review for the entire group." });
  if (app === "express") {
    candidate("express-bun", { runtime: "Bun", framework: "Express + EJS retained", buildMode: "ordinary runtime", implementationPath: "bench/deployments/express-bun" }, [optionSources.bunExpress]);
    choices.at(-1).configurationTemplate = { framework: baseline.configuration.framework, runtime: "Bun 1.4.4 (exact binary and dependencies in native receipt)",
      build: { context: ".", dockerfile: "bench/deployments/express-bun/Dockerfile", argsFrom: "bench/deployments/express-bun/pins.json", args: ["NODE_IMAGE", "BUN_IMAGE"] },
      command: ["bun", "server.mjs"], workers: "one application process; same image and npm tree as Node comparator", server: "Bun node:http compatibility running Express, not Bun.serve",
      middleware: baseline.configuration.middleware, environment: baseline.configuration.environment,
      receipt: { schema: "express-bun-qualification/v1", cells: "Node/Bun x fixture/API x default/matched", readyForLoad: false, readyForMeasurement: false },
      status: "Pending integration of native lane files and exact group qualification; narrower runtime checks alone cannot admit this alternative" };
    candidate("express-bun-packaged", { runtime: "Bun", framework: "Express + EJS retained", buildMode: "bun build --compile; runtime packaging, not machine AOT" }, [optionSources.bunPackaging]);
    candidate("express-bun-bytecode", { runtime: "Bun", framework: "Express + EJS retained", buildMode: "bun build --compile --bytecode; bytecode, not machine AOT" }, [optionSources.bunBytecode]);
    candidate("express-bun-machine-aot", { runtime: "Bun", framework: "Express + EJS retained", buildMode: "experimental bun compile machine AOT; compatibility unverified" }, [optionSources.bunMachineAot]);
  }
  if (app === "django" && baseline.configuration.profile === "matched") {
    candidate("django-gunicorn-sync", { server: "Gunicorn WSGI sync", workers: "three preloaded sync workers", buildProfile: "defaults", productionParity: "must independently pass; baseline middleware differs" }, [optionSources.pythonServers], "source-present");
    choices.at(-1).configuration = { ...baseline.configuration, server: native.django.server, workers: native.django.workers, command: native.django.command,
      profile: "framework-default", environment: { PROFILE: "" }, builds: { app: { context: appRoot(app), dockerfile: `${appRoot(app)}/Dockerfile`, args: {} } } };
  }
  if (app === "django") {
    candidate("django-uvicorn-asgi", { server: "Uvicorn ASGI", command: ["uvicorn", "itempage.asgi:application", "--host", "0.0.0.0", "--port", "8080", "--no-access-log"], sourceRefs: ["bench/live/apps.mjs"], scope: "existing live launch override; not qualified for other groups" }, [optionSources.pythonServers], "source-present");
    choices.at(-1).configuration = { ...baseline.configuration, server: "Uvicorn ASGI", command: choices.at(-1).change.command,
      workers: "one application process; Uvicorn loop/http auto selection must be captured", sourceRefs: [...baseline.configuration.sourceRefs, "bench/live/apps.mjs"] };
  }
  if (app === "fastapi") {
    candidate("fastapi-uvicorn-asyncio", { server: "Uvicorn", loop: "asyncio; explicit selection rather than auto", compiler: "CPython" }, [optionSources.uvicorn]);
    candidate("fastapi-uvicorn-uvloop", { server: "Uvicorn", loop: "uvloop; explicit selection rather than auto", compiler: "CPython" }, [optionSources.uvicorn]);
    candidate("fastapi-granian-asgi", { server: "Granian ASGI", workers: "must be declared, not auto tuned", supportScope: "upstream ASGI interface only", doubts: "no checked-in FastAPI Granian launch; lifespan, cancellation and production middleware require native evidence" }, [optionSources.granian]);
  }
  if (["fastapi", "django"].includes(app)) candidate(`${app}-nuitka`, { compiler: "Nuitka", server: "retain native framework and declared server/loop; packaging and extension compatibility unverified", supportScope: "upstream Python compilation, not a checked-in app build", doubts: "dynamic imports, templates/static assets, native extensions and framework startup require a concrete build and native parity receipts" }, [optionSources.nuitka]);
  if (app === "laravel") {
    for (const server of ["roadrunner", "swoole"]) candidate(`laravel-octane-${server}`, { framework: "Laravel retained", server: `Octane on ${server}`, workers: "must be declared with equal total budget", supportScope: "upstream Octane server integration only", doubts: "no checked-in server image/launch; dependency or extension compatibility, worker state isolation and Livewire/Reverb behavior unverified" }, [optionSources.phpServers]);
    candidate("laravel-frankenphp-jit", { framework: "Laravel retained", server: "Octane on FrankenPHP", compiler: "OPcache JIT; exact INI, CLI enablement and buffer must be declared and measured; not native AOT", supportScope: "PHP runtime option only; existing image installs OPcache", doubts: "installed OPcache is not enabled JIT; native runtime settings and meaningful repeated benefit remain unmeasured" }, [optionSources.phpCompiler]);
  }
  return choices;
}

export function deploymentPlan(group) {
  const d = definition(group);
  return freeze({ schema: deploymentSchema, registry: registrySchema, group, contractSha256: contractSha256(group),
    selected: selectedApps(group), cases: structuredClone(d.cases), capabilities: d.capabilities, retainedFamilies,
    budgetPolicy: "Exact group runner/reservation work and total CPU/memory/process/edge budgets; no overrides or enlargement here.",
    selectionPolicy: "One named deployment per app for the entire group, fixed before the round across every case, phase and pass. No automatic fallback or promotion.",
    execution: "plan-only; not execution authorization or certification",
    apps: selectedApps(group).map((app) => {
      const current = representative(group, app);
      return { app, representative: current.id, deployments: [current, ...candidates(group, app, current)].map((entry) => ({ ...entry, qualification: "pending", evidence: [] })) };
    }) });
}

function entryFor(group, app, id) {
  const row = deploymentPlan(group).apps.find((row) => row.app === app);
  assert.ok(row, "deployment app must be in the exact registry selection");
  const entry = row.deployments.find((entry) => entry.id === id);
  assert.ok(entry, "unknown deployment mode; never auto-qualified");
  return entry;
}
function reference(ref) {
  keys(ref, ["path", "sha256"], "artifact reference"); string(ref.path, "artifact path"); digest(ref.sha256, "artifact hash");
  assert.ok(!/[\\:\x00-\x1f]/.test(ref.path) && ref.path.split("/").every((part) => part && part !== "." && part !== ".."), "artifact must be a relative local path without traversal");
}
const receiptKinds = ["implementation", "native-parity", "performance", "independent-review"];

// The caller supplies the actual frozen reservation, not a locally guessed/default budget.
// An alternative needs a concrete configuration, never a candidate name standing in for one.
export function deploymentDescriptor(group, app, id, binding) {
  const entry = entryFor(group, app, id);
  keys(binding, ["commit", "images", "configuration", "budget", "evidence"], "deployment binding");
  assert.match(binding.commit ?? "", /^[a-f0-9]{40}$/, "exact commit required");
  const configuration = binding.configuration ?? entry.configuration;
  assert.ok(configuration, "candidate requires an implemented configuration manifest");
  if (entry.role === "representative") assert.deepEqual(configuration, entry.configuration, "representative configuration cannot be silently changed");
  else assert.equal(configuration.framework, representative(group, app).configuration.framework, "alternative must retain the native framework; no replacement server app");
  for (const field of ["framework", "runtime", "build", "server", "workers", "middleware", "profile", "edge"]) string(configuration[field], field);
  assert.ok(Array.isArray(configuration.command) && configuration.command.length > 0, "exact launch command required");
  configuration.command.forEach((part) => string(part, "command argument"));
  assert.ok(configuration.environment && typeof configuration.environment === "object" && !Array.isArray(configuration.environment), "runtime environment manifest required");
  assert.ok(Array.isArray(configuration.sourceRefs) && configuration.sourceRefs.length > 0, "native source configuration references required");
  assert.ok(configuration.builds && Object.keys(configuration.builds).length > 0, "build manifests required");
  keys(binding.images, Object.keys(configuration.builds), "immutable images for every build");
  for (const image of Object.values(binding.images)) assert.match(image, /^sha256:[a-f0-9]{64}$/, "immutable image digest required, not tag");
  assert.ok(binding.budget && Object.keys(binding.budget).length > 0, "exact reservation budget required");
  keys(binding.evidence, receiptKinds, "evidence references");
  for (const ref of Object.values(binding.evidence)) if (ref !== null) reference(ref);
  const subject = { schema: deploymentSchema, registry: registrySchema, group, app, deployment: id, contractSha256: contractSha256(group),
    cases: definition(group).cases, commit: binding.commit, images: binding.images, configuration, budget: binding.budget };
  const descriptor = { ...subject, bindingSha256: deploymentSha256(subject), evidence: binding.evidence };
  return freeze({ ...structuredClone(descriptor), descriptorSha256: deploymentSha256(descriptor) });
}

// readArtifact returns bytes. Hashes bind references, not their truth. Only trusted native
// runner validators supplied as code (never CLI/JSON flags) can verify the captured evidence.
export function screenDeployment(descriptor, { readArtifact, verifyNative, verifyPerformance } = {}) {
  const { descriptorSha256, bindingSha256, evidence, ...subject } = descriptor;
  digest(descriptorSha256, "descriptor");
  assert.equal(deploymentSha256({ ...subject, bindingSha256, evidence }), descriptorSha256, "deployment descriptor changed");
  assert.equal(deploymentSha256(subject), bindingSha256, "deployment binding changed");
  const entry = entryFor(subject.group, subject.app, subject.deployment);
  assert.deepEqual(deploymentDescriptor(subject.group, subject.app, subject.deployment, { commit: subject.commit, images: subject.images,
    configuration: subject.configuration, budget: subject.budget, evidence }), descriptor, "stale group contract or malformed descriptor");
  const result = (status, reason) => ({ deployment: subject.deployment, bindingSha256, descriptorSha256, status, reason, certified: false, executionAuthorized: false });
  if (!readArtifact) return result("pending", "Evidence references have not been read or verified.");
  const readBytes = (ref) => {
    reference(ref);
    const bytes = readArtifact(ref.path);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), ref.sha256, "artifact bytes differ from reference");
    return bytes;
  };
  const read = (ref) => JSON.parse(readBytes(ref).toString());
  const receipts = Object.fromEntries(receiptKinds.filter((kind) => evidence[kind] !== null).map((kind) => {
    const receipt = read(evidence[kind]);
    assert.equal(receipt.schema, receiptSchema); assert.equal(receipt.kind, kind);
    assert.equal(receipt.bindingSha256, bindingSha256, "receipt belongs to a different commit/image/config/contract/case/budget");
    string(receipt.author, "evidence author"); string(receipt.reason, "evidence reason");
    assert.ok(["complete", "pending", "unsupported", "failed"].includes(receipt.status), "unknown receipt status");
    return [kind, receipt];
  }));
  for (const status of ["failed", "unsupported", "pending"]) {
    const found = Object.values(receipts).find((r) => r.status === status);
    if (found) return result(status, found.reason);
  }
  if (receiptKinds.some((kind) => evidence[kind] === null)) return result("pending", "Missing exact deployment evidence; representative is not certified.");
  const parity = receipts["native-parity"], performance = receipts.performance, review = receipts["independent-review"];
  assert.deepEqual(parity.cases, subject.cases, "native parity must cover the exact entire group matrix");
  assert.deepEqual(performance.cases, subject.cases, "performance review must cover the exact entire group matrix");
  for (const receipt of [receipts.implementation, parity, performance]) assert.notEqual(review.author, receipt.author, "reviewer must be independent of implementation and evidence authors");
  assert.deepEqual(review.reviewed, Object.fromEntries(receiptKinds.filter((kind) => kind !== "independent-review").map((kind) => [kind, evidence[kind]])), "review must bind all evidence references");
  for (const receipt of [receipts.implementation, parity, performance]) {
    assert.ok(Array.isArray(receipt.artifacts) && receipt.artifacts.length > 0, "raw evidence artifacts required");
    for (const ref of receipt.artifacts) readBytes(ref);
  }
  assert.ok(Array.isArray(performance.runs) && performance.runs.length > 1, "repeated performance evidence required");
  const repeats = new Set();
  for (const run of performance.runs) {
    string(run.repeat, "performance repeat"); assert.ok(!repeats.has(run.repeat), "duplicate performance repeat"); repeats.add(run.repeat);
    assert.deepEqual(run.cases.map((row) => row.key), subject.cases.map((row) => row.key), "each repeat must measure the whole matrix");
    for (const row of run.cases) {
      keys(row.metrics, ["cpuUsec", "memoryBytes", "startupMs", "p95Ms"], "CPU/memory/startup/latency metrics");
      for (const value of Object.values(row.metrics)) assert.ok(Number.isFinite(value) && value >= 0, "finite measured metrics required");
      readBytes(row.artifact);
    }
  }
  assert.equal(review.scope, "entire-group", "per-row configuration cherry-picking is forbidden");
  if (entry.role === "candidate") {
    digest(performance.baselineBindingSha256, "performance baseline");
    assert.notEqual(performance.baselineBindingSha256, bindingSha256, "alternative must be compared with the representative");
    assert.equal(review.baselineBindingSha256, performance.baselineBindingSha256);
    string(review.tradeoff, "meaningful repeated CPU/memory/startup/latency tradeoff review");
    const baseline = performance.baseline;
    assert.equal(baseline?.bindingSha256, performance.baselineBindingSha256, "exact representative comparison descriptor required");
    assert.equal(baseline.group, subject.group); assert.equal(baseline.app, subject.app); assert.equal(baseline.commit, subject.commit);
    assert.equal(baseline.deployment, representative(subject.group, subject.app).id, "alternative comparison must retain the named representative");
    assert.deepEqual(baseline.budget, subject.budget, "alternative comparison must use the same total budget");
    const baselineScreen = screenDeployment(baseline, { readArtifact, verifyNative, verifyPerformance });
    if (baselineScreen.status !== "reviewed-for-selection") return result("pending", "Representative comparison lacks independent exact evidence validation.");
  }
  if (typeof verifyNative !== "function" || typeof verifyPerformance !== "function") return result("pending-independent-validation", "Receipt structure and hashes checked only; native runner and repeated performance validators are required.");
  assert.equal(verifyNative({ descriptor, receipts, read, readBytes }), true, "native implementation/parity validation did not pass");
  assert.equal(verifyPerformance({ descriptor, receipts, read, readBytes }), true, "repeated group-level CPU/memory/startup/latency validation did not pass");
  return result("reviewed-for-selection", "Exact evidence verified by native validators and independently reviewed; not full benchmark certification.");
}

// Intent, not a launch plan: one fixed descriptor for each selected app, never per row.
export function fixedSelection(group, descriptors, validators = {}) {
  assert.ok(Array.isArray(descriptors));
  assert.deepEqual(descriptors.map((d) => d.app), selectedApps(group), "all registry apps required once, in registry order");
  const first = descriptors[0];
  for (const descriptor of descriptors) {
    assert.equal(descriptor.group, group); assert.equal(descriptor.commit, first.commit, "one fixed round commit required");
    assert.deepEqual(descriptor.budget, first.budget, "equal total deployment budgets required; no enlargement for a failing app");
  }
  const screens = descriptors.map((descriptor) => screenDeployment(descriptor, validators));
  for (const [i, descriptor] of descriptors.entries()) {
    const entry = entryFor(group, descriptor.app, descriptor.deployment);
    if (entry.role === "candidate") assert.equal(screens[i].status, "reviewed-for-selection", "performance alternatives require complete independent group qualification");
  }
  const selection = { schema: "benchmark-deployment-selection/v1", group, contractSha256: contractSha256(group), commit: first.commit,
    budget: first.budget, cases: definition(group).cases, phases: "all phases and passes use this same selection; no mid-round fallback",
    selected: descriptors.map((d, i) => ({ app: d.app, deployment: d.deployment, descriptorSha256: d.descriptorSha256, screen: screens[i] })),
    deployments: deploymentPlan(group).apps, retainedFamilies, executionAuthorized: false };
  return freeze({ ...structuredClone(selection), selectionSha256: deploymentSha256(selection) });
}

// A runner must compare every phase with the hash saved before the round, not a newly
// computed selection after an app fails. This check performs no execution or fallback.
export function verifyPhaseSelection(selection, reservedSha256, observed) {
  digest(reservedSha256, "reserved selection");
  const { selectionSha256, ...body } = selection;
  assert.equal(selectionSha256, reservedSha256, "selection changed after reservation");
  assert.equal(deploymentSha256(body), reservedSha256, "selection content changed after reservation");
  assert.equal(selection.contractSha256, contractSha256(selection.group), "stale group selection");
  assert.deepEqual(selection.selected.map((row) => row.app), selectedApps(selection.group));
  assert.deepEqual(selection.cases, definition(selection.group).cases);
  keys(observed, ["app", "case", "descriptorSha256", "selectionSha256"], "phase selection observation");
  assert.equal(observed.selectionSha256, reservedSha256);
  const entry = selection.selected.find((row) => row.app === observed.app);
  assert.ok(entry && selection.cases.some((row) => row.key === observed.case), "unknown phase app/case");
  assert.equal(observed.descriptorSha256, entry.descriptorSha256, "configuration switched mid-round");
  return true;
}

export const outcomeKinds = freeze({
  "app-capacity": "App exhausted its declared equal budget or could not sustain offered work. Preserve raw errors, stop/OOM evidence, useful service and missing phases; not zero throughput or a reason to enlarge the host.",
  "harness-failure": "Driver, upstream, host, browser or provenance evidence invalidated the measurement. Retain it separately; no application capacity conclusion. Diagnose before a separately identified rerun.",
  "functional-failure": "Native observable work, safety, recovery or exact-matrix parity differed. Retain the failed/unsupported app and configuration; no comparative performance pass.",
});

export function deploymentCli(args) {
  assert.ok(args.length === 1, "usage: node bench/workloads/deployments.mjs <group|--all>; read-only plan only, no execution or promotion flags");
  return args[0] === "--all" ? groupNames.map(deploymentPlan) : deploymentPlan(args[0]);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(JSON.stringify(deploymentCli(process.argv.slice(2)), null, 2));
