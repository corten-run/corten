import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { commandOutput } from "./output.mjs";

test("full raw stdout and stderr survive the bounded diagnostic tail", () => {
  const dir = mkdtempSync(join(tmpdir(), "catalog-output-"));
  try {
    const file = join(dir, "app.log"), output = commandOutput({ file, capture: false });
    const expected = createHash("sha256");
    for (let i = 0; i < 1024; i++) {
      const chunk = Buffer.alloc(16384, i % 251);
      expected.update(chunk); (i % 2 ? output.stderr : output.stdout)(chunk);
    }
    output.close(); output.close();
    const bytes = readFileSync(file);
    assert.equal(bytes.length, 16 * 1024 * 1024);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), expected.digest("hex"));
    assert.equal(output.result(), "");
    assert.equal(Buffer.byteLength(output.diagnostic()), 65536);
    assert.throws(() => output.stdout(Buffer.from("late")), /closed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("ordinary command capture and failure tails remain bounded", () => {
  const output = commandOutput();
  output.stdout(Buffer.alloc(9 * 1024 * 1024, "a"));
  output.stdout(Buffer.from("end\n"));
  assert.equal(output.result().length, 8 * 1024 * 1024 - 1);
  assert.ok(output.result().endsWith("end"));
  output.stderr(Buffer.alloc(100000, "e"));
  output.stderr(Buffer.from("failure"));
  assert.equal(output.diagnostic().length, 65536);
  assert.ok(output.diagnostic().endsWith("failure"));
  output.close();
});

test("split UTF-8 chunks are decoded only after byte capture", () => {
  const output = commandOutput();
  const bytes = Buffer.from("\u20ac\u00a3\n");
  for (const byte of bytes) output.stdout(Buffer.from([byte]));
  assert.equal(output.result(), "\u20ac\u00a3");
  output.close();
});

test("real child output is fully drained to the artifact, including stderr", { timeout: 15000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "catalog-output-child-"));
  const file = join(dir, "app.log"), output = commandOutput({ file, capture: false });
  const child = spawn(process.execPath, ["-e", "const b=Buffer.alloc(65536,120);for(let i=0;i<384;i++)process.stdout.write(b);process.stderr.write('stderr-end');"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  try {
    child.stdout.on("data", output.stdout); child.stderr.on("data", output.stderr);
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    output.close();
    assert.equal(code, 0);
    const raw = readFileSync(file);
    assert.equal(raw.length, 24 * 1024 * 1024 + 10);
    assert.equal(raw.indexOf("stderr-end"), raw.lastIndexOf("stderr-end"));
    assert.ok(raw.includes(Buffer.from("stderr-end")));
    assert.equal(output.result(), "");
  } finally { child.kill(); output.close(); rmSync(dir, { recursive: true, force: true }); }
});
