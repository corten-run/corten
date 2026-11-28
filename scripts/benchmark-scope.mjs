import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

// Every Catalog and Evidence job sets up Node from .node-version.
const tooling = [".node-version", "package.json", "package-lock.json", ".dockerignore", ".gitattributes", ".gitignore",
  "scripts/benchmark-scope.mjs", "scripts/benchmark-scope.test.mjs", "scripts/steady.mjs"];
const rustInputs = ["Cargo.toml", "Cargo.lock", ".cargo", "rust-toolchain", "rust-toolchain.toml", "crates"];
// Exact paths only. Other workloads files can supply shared parity inputs.
const fleetControllerFiles = new Set(["CLOUD.md", "cloud-production.mjs", "droplet.mjs", "fleet-production.test.mjs",
  "fleet-provider-test-worker.mjs", "fleet-verify.mjs", "group-continuation.mjs"].map(name => "bench/workloads/" + name));
const catalogShared = [...tooling, ".github/workflows/catalog.yml", "bench/load-tool.mjs",
  // The classic TypeScript compiler native replay's binding parser loads, and its package.
  "bench/typescript.mjs", "bench/package.json", "bench/package-lock.json",
  "bench/catalog", "bench/client-heavy", "bench/fullstack-browser", "bench/hardening",
  "bench/json-api", "bench/live", "bench/marketplace", "bench/mixed-production", "bench/workloads",
  // The catalog and marketplace checkers read these for every app.
  "bench/fullstack/apps/axum-maud/static/style.css", "bench/fullstack/apps/axum-maud/static/components.css",
];
const kernelInputs = [...tooling, ".github/workflows/benchmark-evidence.yml", "bench", "scripts"];
// Includes the core suite's committed source-custody roots, checked against captureSources.
const evidenceInputs = [...kernelInputs, ...rustInputs,
  "README.md", "CONTRIBUTING.md", "AGENTS.md", "docs", "examples/card-market"];
// What the Request Cost job counts, and what it counts with: the crates the request path is built
// from and their locked versions, the kit, and the job itself. The kit's probe builds from
// crates/corten and crates/corten-macros alone; the feed's two crates are here because a request
// for a feed runs them, though no case of the kit does. A .gitattributes in any directory says
// what `git archive` puts in the tree build.sh builds from (selectRequestCost).
const requestCostInputs = [".node-version", ".github/workflows/request-cost.yml", "scripts/benchmark-scope.mjs",
  "Cargo.toml", "Cargo.lock", "crates/corten", "crates/corten-macros", "crates/corten-feed", "crates/corten-protocol",
  "bench/request-cost"];
const matches = (path, inputs) => inputs.some(input => path === input || path.startsWith(`${input}/`));
const sha = /^[0-9a-f]{40}$/;
const scopeWorkflows = { catalog: "catalog.yml", evidence: "benchmark-evidence.yml", "ci-base": "ci.yml" };

export function selectScope(allApps, paths) {
  if (paths === undefined) return { apps: allApps, json: true };
  const selected = new Set();
  let json = false;
  for (const path of paths) {
    if (matches(path, rustInputs) || matches(path, ["bench/catalog/corten"])) {
      selected.add("corten");
    } else if (fleetControllerFiles.has(path)) {
      // Only the Corten Dockerfiles copy the root context. Keep the harness and both JSON jobs.
      selected.add("corten");
      json = true;
    } else if (matches(path, catalogShared)) {
      return { apps: allApps, json: true };
    } else if (path.startsWith("bench/fullstack/apps/")) {
      const [, , , app, file] = path.split("/");
      if (!file || (app !== "aspnet-aot" && !allApps.includes(app))) return { apps: allApps, json: true };
      if (app === "aspnet-aot") json = true;
      else selected.add(app);
      // FastAPI's native and trace checks reuse the Express driver.
      if (path === "bench/fullstack/apps/express/check-native.mjs") selected.add("fastapi");
      // These Gin helpers also drive the other compiled apps' alert checks.
      if (/^bench\/fullstack\/apps\/gin\/(check-alerts|compiled-check|hydration-diagnostics)\.mjs$/.test(path)) {
        for (const peer of ["drogon", "topcoat", "leptos"]) selected.add(peer);
      }
    } else if (matches(path, ["bench/fullstack"])) {
      return { apps: allApps, json: true };
    }
  }
  return { apps: allApps.filter(app => selected.has(app)), json };
}

export function selectEvidence(paths) {
  return paths === undefined || paths.some(path => matches(path, evidenceInputs));
}

export function selectKernel(paths) {
  return paths === undefined || paths.some(path => matches(path, kernelInputs));
}

export function selectRequestCost(paths) {
  return paths === undefined || paths.some(path => matches(path, requestCostInputs) || /(^|\/)\.gitattributes$/.test(path));
}

function changedPaths(base, head, cwd, env) {
  // Keep both sides of a move and don't hide gitlinks from source-custody checks.
  return execFileSync("git", ["diff", "--name-only", "--no-renames", "--ignore-submodules=none", "-z", base, head, "--"], {
    cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, env,
  }).split("\0").filter(Boolean);
}

function isEarlierCommit(base, head, cwd, env) {
  return typeof base === "string" && sha.test(base) && base !== head &&
    spawnSync("git", ["merge-base", "--is-ancestor", base, head], { cwd, stdio: "ignore", env }).status === 0;
}

async function successfulMainBase({ GITHUB_API_URL, GITHUB_REPOSITORY, GITHUB_TOKEN }, workflow, fetchRuns) {
  const url = new URL(`${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY}/actions/workflows/${workflow}/runs`);
  url.search = new URLSearchParams({ branch: "main", event: "push", status: "success", per_page: "1" });
  const response = await fetchRuns(url, {
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${GITHUB_TOKEN}` },
    redirect: "error", signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return undefined;
  const { workflow_runs: runs } = await response.json();
  if (!Array.isArray(runs)) return undefined;
  const run = runs[0];
  if (run?.event === "push" && run.head_branch === "main" && run.status === "completed" && run.conclusion === "success"
      && typeof run.head_sha === "string" && sha.test(run.head_sha)) return run.head_sha;
}

// Git runs with `env`, by default this process's environment; a test passes one without the caller's GIT_DIR.
export async function mainPushBase(event, cwd, env = process.env, { workflow, fetchRuns = fetch } = {}) {
  const { GITHUB_EVENT_NAME, GITHUB_SHA, GITHUB_REF, GITHUB_REPOSITORY, GITHUB_WORKFLOW_REF, GITHUB_TOKEN, PUSH_BEFORE } = event;
  // Called workflows see the caller's event and workflow_ref, not their own.
  const file = scopeWorkflows[workflow];
  if (file && GITHUB_EVENT_NAME === "push" && GITHUB_REF === "refs/heads/main"
      && GITHUB_WORKFLOW_REF === `${GITHUB_REPOSITORY}/.github/workflows/${file}@${GITHUB_REF}`) {
    try {
      // Only a successful run proves the scope job and its selected checks finished. Use the
      // prior tip only to detect a force-push; the successful run can predate a rewrite.
      const base = GITHUB_TOKEN && sha.test(GITHUB_SHA ?? "") && await successfulMainBase(event, file, fetchRuns);
      if (isEarlierCommit(base, GITHUB_SHA, cwd, env)
          && (PUSH_BEFORE === base || isEarlierCommit(PUSH_BEFORE, GITHUB_SHA, cwd, env))) {
        return base;
      }
    } catch {
      // Do not print the response or error from an authenticated request.
    }
    console.warn("Successful main push base unavailable; using the conservative fallback.");
  }
  return undefined;
}

export async function eventPaths(event, cwd, env = process.env, options) {
  const { GITHUB_EVENT_NAME, GITHUB_SHA } = event;
  if (GITHUB_EVENT_NAME === "pull_request") {
    assert.match(GITHUB_SHA ?? "", sha);
    // Actions tests the synthetic merge, including any base-side path moves.
    return changedPaths(`${GITHUB_SHA}^1`, GITHUB_SHA, cwd, env);
  }
  const base = await mainPushBase(event, cwd, env, options);
  if (base) {
    try {
      return changedPaths(base, GITHUB_SHA, cwd, env);
    } catch {
      console.warn("Main push diff unavailable; selecting every benchmark job.");
    }
  }
  return undefined;
}

if (import.meta.main) {
  const { GITHUB_OUTPUT, PARITY_APPS } = process.env;
  const workflow = process.argv[2];
  const options = { workflow };
  if (workflow === "ci-base") {
    console.log(await mainPushBase(process.env, undefined, process.env, options) ?? "root");
  } else {
    const paths = await eventPaths(process.env, undefined, process.env, options);
    if (workflow === "catalog") {
      const { apps, json } = selectScope(JSON.parse(PARITY_APPS), paths);
      appendFileSync(GITHUB_OUTPUT, `apps=${JSON.stringify(apps)}\njson=${json}\n`);
    } else if (workflow === "evidence") {
      appendFileSync(GITHUB_OUTPUT, `run=${selectEvidence(paths)}\nkernel=${selectKernel(paths)}\n`);
    } else if (workflow === "request-cost") {
      appendFileSync(GITHUB_OUTPUT, `run=${selectRequestCost(paths)}\n`);
    } else {
      throw new Error("Expected catalog, evidence, request-cost or ci-base");
    }
  }
}
