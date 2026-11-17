import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { commands } from "./process.mjs";

test("normal child99 is observable only by the explicit receipt path; legacy commands remain strict", async () => {
  const io = commands(process.cwd());
  try {
    for (const code of [0, 99]) {
      const observed = await io.command(process.execPath, ["--max-old-space-size=256", "-e", `process.exitCode=${code}`], { observeExit: true });
      assert.deepEqual(observed.exit, { code, signal: null, expired: false, interrupted: false });
      assert.deepEqual(observed.ioErrors, []); assert.ok(observed.clock.finishedAt >= observed.clock.startedAt);
    }
    await assert.rejects(io.command(process.execPath, ["--max-old-space-size=256", "-e", "process.exitCode=99"]), /exit 99/);
    await assert.rejects(io.command(process.execPath, ["--max-old-space-size=256", "-e", "process.exitCode=2"], { observeExit: true }), /exit 2/);
  } finally { io.dispose(); }
});

test("full stdout bytes are preserved; timeout, cap and file I/O faults never become normal99 observations", async (t) => {
  const folder = mkdtempSync(join(tmpdir(), "json-command-proof-")), io = commands(process.cwd());
  t.after(() => { io.dispose(); assert.ok(resolve(folder).startsWith(resolve(tmpdir()) + sep)); rmSync(folder, { recursive: true, force: true }); });
  const file = join(folder, "events");
  const observed = await io.command(process.execPath, ["--max-old-space-size=256", "-e", "process.stdout.write(Buffer.from([0,10,13,255]));process.exitCode=99"],
    { observeExit: true, stdoutFile: file, maxStdoutBytes: 4 });
  assert.equal(observed.stdoutBytes, 4); assert.equal(readFileSync(file).toString("hex"), "000a0dff");
  await assert.rejects(io.command(process.execPath, ["--max-old-space-size=256", "-e", "setInterval(()=>{},1000)"], { observeExit: true, timeout: 500 }),
    (e) => e.exit?.expired === true);
  await assert.rejects(io.command(process.execPath, ["--max-old-space-size=256", "-e", "process.stdout.write('too many bytes');process.exitCode=99"],
    { observeExit: true, stdoutFile: join(folder, "capped"), maxStdoutBytes: 1 }), (e) => e.ioErrors?.some((s) => s.includes("cap exceeded")));
  await assert.rejects(io.command(process.execPath, ["--max-old-space-size=256", "-e", "process.stdout.write('bytes');process.exitCode=99"],
    { observeExit: true, stdoutFile: join(folder, "absent", "events") }), (e) => e.ioErrors?.length > 0);
});
