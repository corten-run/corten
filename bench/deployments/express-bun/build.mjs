import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, readdirSync, lstatSync, appendFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const here = dirname(fileURLToPath(import.meta.url)), root = fileURLToPath(new URL("../../../", import.meta.url));
export const pins = JSON.parse(readFileSync(join(here, "pins.json"), "utf8"));
export const adapter = join(root, "bench/fullstack/apps/express");
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function sourceFiles(base = adapter) {
  const walk = (prefix) => readdirSync(join(base, prefix)).sort().flatMap((name) => {
    const path = `${prefix}/${name}`, stat = lstatSync(join(base, path));
    assert.ok(!stat.isSymbolicLink(), "native sources must not be external links");
    return stat.isDirectory() ? walk(path) : [path];
  });
  return ["package.json", "server.mjs", ...["lib", "views", "static"].flatMap(walk)].sort()
    .map((path) => ({ path, sha256: sha256(readFileSync(join(base, path))) }));
}
export function command(executable, args, { log, stdoutFile, stderrFile, timeoutMs = 120000, cwd = root } = {}) {
  for (const path of [stdoutFile, stderrFile]) if (path) writeFileSync(path, "");
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", expired = false;
    const timer = setTimeout(() => { expired = true; child.kill(); }, timeoutMs);
    child.stdout.on("data", (part) => { stdout += part; if (log) appendFileSync(log, part); if (stdoutFile) appendFileSync(stdoutFile, part); });
    child.stderr.on("data", (part) => { stderr += part; if (log) appendFileSync(log, part); if (stderrFile) appendFileSync(stderrFile, part); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (expired || code !== 0) reject(new Error(`${executable} ${args[0]} ${expired ? "timed out" : `exit ${code}`}: ${stderr.slice(-2000)}`));
      else resolve(stdout.trim());
    });
  });
}
export const docker = (args, options) => command("docker", args, options);
export async function ownedInspector(args, task, { timeoutMs = 120000 } = {}) {
  const name = `${task}-inspector-${randomBytes(6).toString("hex")}`;
  try {
    return await docker(["run", "--rm", "--name", name, "--network", "none", "--cpus", "1", "--memory", "512m", "--pids-limit", "128",
      "--label", "agent.owner=codex", "--label", `agent.task=${task}`, ...args], { timeoutMs });
  } finally {
    try { await docker(["rm", "-f", "-v", name], { timeoutMs: 15000 }); }
    catch (error) { if (!/No such container:/i.test(error.message)) throw error; }
  }
}
export function verifyIdentity(node, bun, sources, manifest) {
  assert.equal(bun.versions.bun, pins.bunVersion, "wrong Bun runtime");
  assert.ok(!node.versions.bun, "Node baseline must execute Node, not Bun");
  assert.match(node.versions.node, /^24\./, "wrong Node major");
  for (const identity of [node, bun]) {
    assert.deepEqual(identity.installed, manifest.dependencies, "native Express dependency versions differ");
    for (const source of sources) assert.equal(identity.sources.find((entry) => entry.path === source.path)?.sha256, source.sha256, `stale native source: ${source.path}`);
    assert.deepEqual(identity.sources.map((entry) => entry.path).sort(), [...new Set([...sources.map((entry) => entry.path), "static/htmx.min.js"])].sort(), "unexpected image source files");
    assert.equal(identity.sources.find((entry) => entry.path === "static/htmx.min.js")?.sha256, "d6fdc75f204e6bdefa99b69bf1e6d4ac69b8a364f77929f45c13476b4000f717");
  }
  assert.deepEqual(node.sources, bun.sources, "runtime source trees differ");
  assert.equal(node.dependenciesSha256, bun.dependenciesSha256, "runtime dependency trees differ");
  assert.equal(node.lockSha256, bun.lockSha256, "runtime dependency locks differ");
}
export async function inspectIdentities(image, task, options) {
  const identities = {};
  for (const runtime of ["node", "bun"]) identities[runtime] = JSON.parse(await ownedInspector([image, runtime, "/qualification/identity.mjs"], task, options));
  return identities;
}
export async function build(out, task) {
  const sources = sourceFiles(), tag = `corten-express-bun:${task}`, iid = join(out, "image.id");
  await docker(["build", "--platform", pins.platform, "--label", "agent.owner=codex", "--label", `agent.task=${task}`,
    "--build-arg", `NODE_IMAGE=${pins.nodeImage}`, "--build-arg", `BUN_IMAGE=${pins.bunImage}`, "--iidfile", iid,
    "-t", tag, "-f", join(here, "Dockerfile"), root], { log: join(out, "build.log"), timeoutMs: 300000 });
  const image = readFileSync(iid, "utf8").trim();
  assert.match(image, /^sha256:[a-f0-9]{64}$/);
  const identities = await inspectIdentities(image, task);
  verifyIdentity(identities.node, identities.bun, sources, JSON.parse(readFileSync(join(adapter, "package.json"), "utf8")));
  assert.deepEqual(sourceFiles(), sources, "native source changed during image build");
  const result = { image, tag, pins, sources, identities, inspect: JSON.parse(await docker(["image", "inspect", image]))[0] };
  writeFileSync(join(out, "build.json"), JSON.stringify(result, null, 2) + "\n");
  return result;
}
