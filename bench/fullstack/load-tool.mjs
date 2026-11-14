import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describeK6 } from "../load-tool.mjs";

export { k6Image } from "../load-tool.mjs";

export function keepLoadTool(dir, k6) {
  const file = join(dir, "tools.json");
  if (existsSync(file)) {
    const previous = JSON.parse(readFileSync(file, "utf8")).k6;
    for (const key of ["image", "imageId", "platform", "version", "versionOutput"]) {
      assert.equal(previous?.[key], k6[key], "load tool differs; use a new result directory");
    }
    return;
  }
  const measured = (folder) => existsSync(folder) && readdirSync(folder).some((name) => /\.json$/.test(name) && !["passes.json", "edge.json"].includes(name));
  const nonLoad = new Set(["passes.json", "edge.json", "cold-start.json", "bytes.json", "build.json", "conformance.json", "browser.json"]);
  const rootLoad = readdirSync(dir).some((name) => name.endsWith(".json") && !nonLoad.has(name));
  assert.ok(!rootLoad && !["raw.tar.xz", "raw.txt"].some((name) => existsSync(join(dir, name)))
    && !["fixture", "api"].some((source) => measured(join(dir, source))), "earlier load tool is unknown; use a new result directory");
  writeFileSync(file, JSON.stringify({ k6 }, null, 2));
}

export async function recordLoadTool(dir) {
  const k6 = await describeK6((args, options = {}) => {
    const result = spawnSync("docker", args, { encoding: "utf8", timeout: options.timeout ?? 30_000, windowsHide: true });
    if (result.status !== 0) throw new Error(result.error?.message ?? result.stderr ?? "Docker failed");
    return result.stdout.trim();
  }, ["--label", `run.corten.fullstack=${dir}`]);
  keepLoadTool(dir, k6);
  return k6;
}
