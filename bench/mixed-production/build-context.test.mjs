import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { nativeBuildContext } from "./build-context.mjs";
import { sourceSnapshot } from "./source-audit.mjs";
import { commands } from "../json-api/process.mjs";
import { sha256 } from "./capture.mjs";

test("Docker stdin context excludes ignored working-tree inputs and stays bound to the committed archive", async () => {
  const root = mkdtempSync(join(tmpdir(), "corten-mixed-context-")), io = commands(root);
  const image = `corten-mixed-context-test-${process.pid}`;
  let built = false;
  try {
    const app = join(root, "bench/fullstack/apps/express"), output = join(root, "evidence");
    mkdirSync(app, { recursive: true }); mkdirSync(output);
    const file = "bench/fullstack/apps/express/server.mjs";
    writeFileSync(join(root, file), "export const actual = 'committed';\n");
    writeFileSync(join(app, "Dockerfile"), "FROM scratch\nCOPY server.mjs /server.mjs\n");
    await io.command("git", ["init", "--quiet"]);
    await io.command("git", ["add", "bench"]);
    await io.command("git", ["-c", "user.name=Context Test", "-c", "user.email=context@example.test", "commit", "--quiet", "-m", "native context fixture"]);
    const commit = await io.command("git", ["rev-parse", "HEAD"]);
    const paths = (await io.command("git", ["ls-tree", "-r", "--name-only", commit, "--", "bench"])).split(/\r?\n/);
    const expected = sourceSnapshot(root, paths).sourceFiles;
    writeFileSync(join(root, ".git/info/exclude"), "Injected.cs\nevidence/\n");
    writeFileSync(join(app, "Injected.cs"), "ignored code that Docker COPY . . must never receive");
    assert.equal(await io.command("git", ["status", "--porcelain"]), "");
    const context = await nativeBuildContext(io, output, commit, "express", expected);
    assert.equal(context.sha256, sha256(context.input));
    assert.equal(context.dockerfile, "Dockerfile");
    assert.equal(existsSync(join(output, "express-build-context/Injected.cs")), false);
    assert.equal(readFileSync(join(output, "express-build-context/server.mjs"), "utf8"), "export const actual = 'committed';\n");
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
