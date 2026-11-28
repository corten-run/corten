import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { extractNativeSource, nativeBuildArchiveArgs, nativeBuildContext } from "./build-context.mjs";
import { executionMountArgs } from "./execution-inputs.mjs";
import { sourceSnapshot } from "./source-audit.mjs";
import { commands } from "../json-api/process.mjs";
import { sha256 } from "./capture.mjs";
import { fixtureGitCommands, fixtureGitEnv } from "../../scripts/fixture-git.mjs";

// The same 30 s deadline io.command gave these fixture Git calls. The archives below run Git through
// `io`, which fixtureGitCommands gives the same environment.
const fixtureGit = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"], env: fixtureGitEnv(), timeout: 30_000 }).trim();

test("native archive arguments share a fixed tree timestamp without changing Corten commit archives", () => {
  const commit = "a".repeat(40), prefix = ["-c", "core.autocrlf=false", "-c", "core.eol=lf", "archive", "--format=tar"];
  for (const app of ["aspnet", "spring", "django", "express", "fastapi", "topcoat", "gin", "drogon"]) {
    assert.deepEqual(nativeBuildArchiveArgs(commit, app), [...prefix, "--mtime=1970-01-01T00:00:00Z", `${commit}:bench/fullstack/apps/${app}`]);
    assert.deepEqual(nativeBuildArchiveArgs(commit, app, { output: "context.tar" }), [...prefix, "--mtime=1970-01-01T00:00:00Z", "--output", "context.tar", `${commit}:bench/fullstack/apps/${app}`]);
  }
  assert.deepEqual(nativeBuildArchiveArgs(commit, "corten"), [...prefix, commit]);
  assert.deepEqual(nativeBuildArchiveArgs(commit, "corten", { output: "context.tar" }), [...prefix, "--output", "context.tar", commit]);
  for (const [id, app] of [["HEAD", "express"], [commit, "../express"], [commit, "express:evil"]]) assert.throws(() => nativeBuildArchiveArgs(id, app));
});

test("fresh Git extraction supplies only the empty mount point under the read-only source bind", async () => {
  const root = mkdtempSync(join(tmpdir(), "corten-mixed-archive-")), io = fixtureGitCommands(commands(root));
  try {
    const file = "bench/worker.mjs", body = 'import "playwright";\n';
    mkdirSync(join(root, "bench")); writeFileSync(join(root, file), body);
    fixtureGit(root, "init", "--quiet");
    fixtureGit(root, "-c", "core.autocrlf=false", "add", file);
    const commit = () => {
      fixtureGit(root, "-c", "user.name=Archive Test", "-c", "user.email=archive@example.test", "commit", "--quiet", "-m", "archive fixture");
      return fixtureGit(root, "rev-parse", "HEAD");
    };
    const clean = commit(), out = join(root, "out"), dependencies = join(out, "execution/dependencies");
    mkdirSync(dependencies, { recursive: true });
    const source = await extractNativeSource(io, out, clean), archive = join(out, "build-source.tar");
    assert.deepEqual((await io.command("tar", ["-tf", archive])).split(/\r?\n/), ["bench/", file]);
    assert.equal(sha256(readFileSync(archive)), source.archiveSha256);
    assert.equal(readFileSync(join(source.root, file), "utf8"), body);
    assert.deepEqual(readdirSync(source.root).sort(), ["bench", "node_modules"]);
    assert.deepEqual(readdirSync(join(source.root, "node_modules")), []);
    assert.deepEqual(executionMountArgs(source.root, out), ["-v", `${source.root}:/src:ro`, "-v", `${dependencies}:/src/node_modules:ro`,
      "-v", `${out}:/out`, "-w", "/src"]);

    writeFileSync(join(root, "node_modules"), "tracked collision");
    fixtureGit(root, "add", "--force", "node_modules");
    const collision = commit(), other = join(root, "collision");
    mkdirSync(other);
    await assert.rejects(extractNativeSource(io, other, collision), { code: "EEXIST" });
    assert.equal(readFileSync(join(other, "build-source/node_modules"), "utf8"), "tracked collision");
  } finally {
    io.dispose();
    assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith("corten-mixed-archive-"));
    rmSync(root, { recursive: true });
  }
});

test("Docker stdin context excludes ignored working-tree inputs and stays bound to the committed archive", async () => {
  const root = mkdtempSync(join(tmpdir(), "corten-mixed-context-")), io = fixtureGitCommands(commands(root));
  const image = `corten-mixed-context-test-${process.pid}`;
  let built = false;
  try {
    const app = join(root, "bench/fullstack/apps/express"), output = join(root, "evidence");
    mkdirSync(app, { recursive: true }); mkdirSync(output);
    const file = "bench/fullstack/apps/express/server.mjs";
    writeFileSync(join(root, file), "export const actual = 'committed';\n");
    writeFileSync(join(app, "Dockerfile"), "FROM scratch\nCOPY server.mjs /server.mjs\n");
    fixtureGit(root, "init", "--quiet");
    fixtureGit(root, "add", "bench");
    fixtureGit(root, "-c", "user.name=Context Test", "-c", "user.email=context@example.test", "commit", "--quiet", "-m", "native context fixture");
    const commit = fixtureGit(root, "rev-parse", "HEAD");
    const paths = fixtureGit(root, "ls-tree", "-r", "--name-only", commit, "--", "bench").split(/\r?\n/);
    const expected = sourceSnapshot(root, paths).sourceFiles;
    writeFileSync(join(root, ".git/info/exclude"), "Injected.cs\nevidence/\n");
    writeFileSync(join(app, "Injected.cs"), "ignored code that Docker COPY . . must never receive");
    assert.equal(fixtureGit(root, "status", "--porcelain"), "");
    const context = await nativeBuildContext(io, output, commit, "express", expected);
    assert.equal(context.sha256, sha256(context.input));
    assert.equal(context.dockerfile, "Dockerfile");
    assert.equal(existsSync(join(output, "express-build-context/Injected.cs")), false);
    assert.equal(readFileSync(join(output, "express-build-context/server.mjs"), "utf8"), "export const actual = 'committed';\n");
    const repeated = join(root, "repeated-evidence"); mkdirSync(repeated);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const repeatedContext = await nativeBuildContext(io, repeated, commit, "express", expected);
    assert.equal(repeatedContext.sha256, context.sha256, "independent prebuild review and later build must receive identical immutable tar bytes");
    assert.deepEqual(repeatedContext.input, context.input);
    writeFileSync(join(app, "server.mjs"), "changed after archive");
    assert.equal(context.sha256, sha256(context.input));
    const received = await io.command(process.execPath, ["-e", "let n=0;process.stdin.on('data',b=>n+=b.length);process.stdin.on('end',()=>console.log(n))"], { input: context.input });
    assert.equal(Number(received), context.input.length);
    if (process.env.MIXED_CONTEXT_DOCKER_TEST === "1") {
      built = true;
      await io.command("docker", ["build", "--label", "agent.owner=codex", "--label", "agent.task=mixed-context-test",
        "--label", `run.corten.mixed-production.context=${context.sha256}`, "-t", image, "-f", context.dockerfile, "-"],
      { input: context.input, timeout: 60000 });
      const inspected = JSON.parse(await io.command("docker", ["image", "inspect", image]))[0];
      assert.equal(inspected.Config.Labels["run.corten.mixed-production.context"], context.sha256);
      assert.equal(inspected.RootFS.Layers.length, 1);
    }
    await assert.rejects(io.command(process.execPath, ["-e", "process.exit(0)"], { input: "not a byte buffer" }), /Buffer/);
  } finally {
    if (built) await io.command("docker", ["image", "rm", image], { cleanup: true });
    io.dispose();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith("corten-mixed-context-"));
    rmSync(root, { recursive: true });
  }
});
