import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { parse } from "yaml";

const sharedTrees = ["bench/catalog/", "bench/json-api/", "bench/marketplace/", "bench/workloads/"];
const sharedFiles = new Set([
  ".github/workflows/catalog.yml", "package.json", "package-lock.json", "scripts/steady.mjs",
  "scripts/catalog-scope.mjs", "scripts/catalog-scope.test.mjs", "bench/load-tool.mjs",
  "bench/fullstack/apps.mjs", "bench/fullstack/conformance.mjs", "bench/fullstack/inventory.mjs", "bench/fullstack/passes.mjs",
  // The catalog and marketplace checkers read these for every app.
  "bench/fullstack/apps/axum-maud/static/style.css", "bench/fullstack/apps/axum-maud/static/components.css",
]);

export function selectScope(allApps, paths) {
  if (paths === undefined) return { apps: allApps, json: true };
  const selected = new Set();
  let json = false;
  for (const path of paths) {
    if (path === "Cargo.toml" || path === "Cargo.lock" || path.startsWith("crates/") || path.startsWith("bench/catalog/corten/")) {
      selected.add("corten");
    } else if (sharedFiles.has(path) || sharedTrees.some(tree => path.startsWith(tree))) {
      return { apps: allApps, json: true };
    } else {
      const app = /^bench\/fullstack\/apps\/([^/]+)\//.exec(path)?.[1];
      if (app === "aspnet-aot") json = true;
      else if (app) selected.add(app);
      // These Gin helpers also drive the other compiled apps' alert checks.
      if (/^bench\/fullstack\/apps\/gin\/(check-alerts|compiled-check|hydration-diagnostics)\.mjs$/.test(path)) {
        for (const peer of ["drogon", "topcoat", "leptos"]) selected.add(peer);
      }
    }
  }
  return { apps: allApps.filter(app => selected.has(app)), json };
}

export function changedPaths(base, head, cwd) {
  // Three dots compare the PR head to its merge base, not to changes only on main.
  // No rename detection keeps both paths when a file moves between apps or trees.
  return execFileSync("git", ["diff", "--name-only", "--no-renames", "-z", `${base}...${head}`, "--"], {
    cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
  }).split("\0").filter(Boolean);
}

if (import.meta.main) {
  const { GITHUB_EVENT_NAME, GITHUB_OUTPUT, PARITY_MATRIX, PR_BASE, PR_HEAD } = process.env;
  const paths = GITHUB_EVENT_NAME === "pull_request" ? changedPaths(PR_BASE, PR_HEAD) : undefined;
  const { apps, json } = selectScope(parse(PARITY_MATRIX).app, paths);
  appendFileSync(GITHUB_OUTPUT, `apps=${JSON.stringify(apps)}\njson=${json}\n`);
}
