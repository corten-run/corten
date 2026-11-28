import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

// Every Catalog and Evidence job sets up Node from .node-version.
const tooling = [".node-version", "package.json", "package-lock.json", ".dockerignore", ".gitattributes", ".gitignore",
  "scripts/benchmark-scope.mjs", "scripts/benchmark-scope.test.mjs", "scripts/steady.mjs"];
const rustInputs = ["Cargo.toml", "Cargo.lock", ".cargo", "rust-toolchain", "rust-toolchain.toml", "crates"];
// Exact paths only. Other workloads files can supply shared parity inputs.
const fleetControllerFiles = new Set(["CLOUD.md", "cloud-production.mjs", "droplet.mjs", "fleet.mjs", "fleet.test.mjs", "fleet-production.test.mjs",
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
const cumulativeVersion = "-cumulative-v1";
const mainRunLimit = 100;

export function selectScope(allApps, paths) {
  if (paths === undefined) return { apps: allApps, json: true };
  const selected = new Set();
  let json = false;
  for (const path of paths) {
    if (matches(path, rustInputs) || matches(path, ["bench/catalog/corten"])) {
      selected.add("corten");
    } else if (fleetControllerFiles.has(path) || path === "bench/live/apps/corten/Cargo.lock" || path === "bench/marketplace/corten/Cargo.lock") {
      // Only Corten builds from the root context and uses the two Rust locks. Other files beside
      // the locks can be shared parity drivers. Keep the harness and both JSON jobs.
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

function changedPaths(base, head, cwd, env, everyCommit = false) {
  const diffFlags = ["--name-only", "--no-renames", "--ignore-submodules=none", "-z"];
  // Keep both sides of a move and don't hide gitlinks from source-custody checks.
  const read = args => execFileSync("git", args, {
    cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, env,
  }).split("\0").filter(Boolean);
  if (!everyCommit) return read(["diff", ...diffFlags, base, head, "--"]);
  // Main can fast-forward to a merge that took the checked tree as its second parent.
  // The first-parent changes then describe another branch. Don't narrow the jobs from them.
  // Exclude the checked commit's parents so an ordinary push walks only the new interval.
  const mainline = execFileSync("git", ["rev-list", "--first-parent", head, "--not", `${base}^@`], { cwd, env, encoding: "utf8" });
  if (!mainline.trimEnd().split(/\r?\n/).includes(base)) return undefined;
  const range = [...diffFlags, `${base}..${head}`, "--"];
  // Topic commits count, but a topic merge importing an already checked parent does not
  // introduce that parent's paths. Count its own resolutions, plus all mainline merge changes
  // against the previous main tree (including a resolution that takes a parent's version).
  return [...new Set([
    ...read(["log", "--format=", "--diff-merges=combined", ...range]),
    ...read(["log", "--format=", "--first-parent", "--merges", "--diff-merges=first-parent", ...range]),
  ])].sort();
}

function checkedAncestor(base, head, workflow, cwd, env) {
  if (typeof base !== "string" || !sha.test(base) || base === head) return false;
  if (spawnSync("git", ["merge-base", "--is-ancestor", base, head], { cwd, stdio: "ignore", env }).status !== 0) return false;
  // A green legacy workflow covered only its own push. Recognize the active versioned
  // command in the candidate's workflow, not the date or ancestry of the rollout commit.
  const command = `node scripts/benchmark-scope.mjs ${workflow}${cumulativeVersion}`;
  const invocation = workflow === "ci-base" ? `base=$(${command}) || exit 1` : `run: ${command}`;
  const source = spawnSync("git", ["show", `${base}:.github/workflows/${scopeWorkflows[workflow]}`], {
    cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
  });
  return source.status === 0 && source.stdout.split(/\r?\n/).some(line => line.trim() === invocation);
}

async function successfulMainBase({ GITHUB_API_URL, GITHUB_REPOSITORY, GITHUB_TOKEN }, workflow, fetchRuns, checked) {
  const url = new URL(`${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY}/actions/workflows/${workflow}/runs`);
  const allowsDispatch = workflow === "ci.yml";
  url.search = new URLSearchParams({ branch: "main", status: "success", per_page: String(mainRunLimit) });
  if (!allowsDispatch) url.searchParams.set("event", "push");
  const response = await fetchRuns(url, {
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${GITHUB_TOKEN}` },
    redirect: "error", signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return { reason: `the GitHub Actions API returned HTTP ${response.status}` };
  const runs = (await response.json().catch(() => null))?.workflow_runs;
  if (!Array.isArray(runs)) return { reason: "the GitHub Actions API returned an invalid workflow-runs response" };
  // The API lists newest runs first. CI's manual run validates its explicit base and runs all
  // checks. Other workflows keep using push results (Evidence's manual run can be native-only).
  for (const run of runs.slice(0, mainRunLimit)) {
    if ((run?.event === "push" || (allowsDispatch && run?.event === "workflow_dispatch")) &&
        run.head_branch === "main" && run.status === "completed" && run.conclusion === "success" &&
        checked(run.head_sha)) return { base: run.head_sha };
  }
  return { reason: `none of the most recent ${mainRunLimit} successful main runs is an available earlier ancestor with cumulative coverage` };
}

// Git runs with `env`, by default this process's environment; a test passes one without the caller's GIT_DIR.
export async function mainPushBase(event, cwd, env = process.env, { workflow, fetchRuns = fetch } = {}) {
  const { GITHUB_EVENT_NAME, GITHUB_SHA, GITHUB_REF, GITHUB_REPOSITORY, GITHUB_WORKFLOW_REF, GITHUB_TOKEN } = event;
  // Called workflows see the caller's event and workflow_ref, not their own.
  const file = scopeWorkflows[workflow];
  if (!file || GITHUB_EVENT_NAME !== "push" || GITHUB_REF !== "refs/heads/main"
      || GITHUB_WORKFLOW_REF !== `${GITHUB_REPOSITORY}/.github/workflows/${file}@${GITHUB_REF}`) return undefined;
  if (!GITHUB_TOKEN) return { reason: "the GitHub Actions API token is missing" };
  if (!sha.test(GITHUB_SHA ?? "")) return { reason: "the pushed commit SHA is invalid" };
  // A usable success proves coverage through its commit even if the previous tip was rewritten.
  // The previous tip itself proves no coverage: that run may have stopped or failed.
  try {
    return await successfulMainBase(event, file, fetchRuns, base => checkedAncestor(base, GITHUB_SHA, workflow, cwd, env));
  } catch {
    // Do not print the response or error from an authenticated request.
    return { reason: "the GitHub Actions workflow-runs request failed or timed out" };
  }
}

export async function eventPaths(event, cwd, env = process.env, options) {
  const { GITHUB_EVENT_NAME, GITHUB_SHA } = event;
  if (GITHUB_EVENT_NAME === "pull_request") {
    assert.match(GITHUB_SHA ?? "", sha);
    // Actions tests the synthetic merge, including any base-side path moves.
    return changedPaths(`${GITHUB_SHA}^1`, GITHUB_SHA, cwd, env);
  }
  const result = await mainPushBase(event, cwd, env, options);
  if (result?.reason) console.warn(`Successful main push base unavailable: ${result.reason}; selecting every benchmark job.`);
  if (result?.base) {
    try {
      return changedPaths(result.base, GITHUB_SHA, cwd, env, true);
    } catch {
      console.warn("Main push diff unavailable; selecting every benchmark job.");
    }
  }
  return undefined;
}

if (import.meta.main) {
  const { GITHUB_OUTPUT, PARITY_APPS } = process.env;
  const command = process.argv[2];
  const workflow = command?.endsWith(cumulativeVersion) ? command.slice(0, -cumulativeVersion.length) : command;
  if (command !== "request-cost" && !(Object.hasOwn(scopeWorkflows, workflow) && command === workflow + cumulativeVersion)) {
    throw new Error("Expected catalog-cumulative-v1, evidence-cumulative-v1, request-cost or ci-base-cumulative-v1");
  }
  const options = { workflow };
  if (workflow === "ci-base") {
    const result = await mainPushBase(process.env, undefined, process.env, options);
    if (result?.base) {
      console.log(result.base);
    } else {
      const reason = result?.reason ?? "this is not a direct push to main";
      console.error(`::error::Could not find a cumulative main CI base: ${reason}. Rerun after a transient lookup failure, or dispatch CI on main with an explicitly verified ancestor as base.`);
      process.exitCode = 1;
    }
  } else {
    const paths = await eventPaths(process.env, undefined, process.env, options);
    if (workflow === "catalog") {
      const { apps, json } = selectScope(JSON.parse(PARITY_APPS), paths);
      appendFileSync(GITHUB_OUTPUT, `apps=${JSON.stringify(apps)}\njson=${json}\n`);
    } else if (workflow === "evidence") {
      appendFileSync(GITHUB_OUTPUT, `run=${selectEvidence(paths)}\nkernel=${selectKernel(paths)}\n`);
    } else if (workflow === "request-cost") {
      appendFileSync(GITHUB_OUTPUT, `run=${selectRequestCost(paths)}\n`);
    }
  }
}
