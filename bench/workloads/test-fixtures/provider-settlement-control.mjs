import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { controlRegistration } from "../cloud-control-runtime.mjs";
import { digest } from "../cloud-local.mjs";
import { registration } from "./control-stream-fixture.mjs";

// These tests inject one account failure after binding the allocation but before
// the readiness SSH registers a bootstrap command. Only that allocation is unused.
export function beforeProvisioning(local) {
  const state = JSON.parse(readFileSync(join(local, "state.json")));
  return state.status === "preparing" && state.id === "123" && state.control?.ledger.length === 0;
}

export function settlementControl(t, h) {
  let finishMonitor;
  function spawn(binary, argv, options) {
    if (binary === "git" && argv[0] === "show") {
      const url = new URL("../../../" + argv[1].slice(41), import.meta.url);
      return { status: 0, stdout: readFileSync(url, "utf8").replaceAll("\r\n", "\n") };
    }
    if (binary === "git") return h.run(binary, argv, options.timeout);
    assert.ok(["ssh", "sftp"].includes(binary), "only synthetic SSH/SFTP or Git allowed");
    const saved = h.saved(), request = saved.control?.ledger.at(-1)?.request;
    const control = request && controlRegistration(request);
    let result;
    if (binary === "ssh") {
      assert.equal(argv.at(-1), control?.command ?? "/bin/bash -s");
      const prefix = (control?.inputPrefix ?? "") + "set -euo pipefail\n";
      assert.ok(options.input.startsWith(prefix) && options.input.endsWith("\n"));
      const script = options.input.slice(prefix.length, -1);
      if (request) assert.equal(request.invocation.requestSha256, digest(options.input.slice(control.inputPrefix.length)));
      result = h.run(binary, [...argv.slice(0, -1), script], options.timeout);
      if (script.startsWith("systemctl show"))
        result.stdout = result.stdout.replaceAll(/corten-bench-groups-r21-[a-f0-9]{16}\.service/g, saved.unit);
    } else {
      assert.equal(request.invocation.channel, "sftp");
      assert.deepEqual(argv.slice(-5), ["-b", "-", "-s", control.command, `root@${saved.ip}`]);
      const put = /^put "((?:\\.|[^"\\])*)" "((?:\\.|[^"\\])*)"\n$/.exec(options.input);
      assert.ok(put, "expected one guarded fixture upload");
      const [source, target] = put.slice(1).map((value) => value.replace(/\\(.)/g, "$1"));
      const name = target.slice("/bench/".length);
      assert.match(name, /^[\w.-]+$/);
      const local = join(h.local, name), remote = `root@${saved.ip}:/bench/${name}`;
      assert.equal(target, `/bench/${name}`);
      assert.equal(source, process.platform === "win32" ? local.replaceAll("\\", "/") : local);
      assert.equal(request.invocation.requestSha256, digest(JSON.stringify([local, remote])));
      result = h.run("scp", [local, remote], options.timeout);
    }
    if (!request) return result;
    if (request.seal && result.status === 0) {
      assert.equal(request.epoch, "bootstrap");
      assert.ok(finishMonitor, "bootstrap seal requires a registered monitor");
      finishMonitor();
      finishMonitor = undefined;
    }
    const { id } = request.invocation;
    return { ...result, stderr: `CORTEN_CONTROL ${id} ${digest(JSON.stringify(request))}\nCORTEN_RESULT ${id} ${result.status}\n` };
  }

  function streamSpawn(binary, argv) {
    assert.equal(binary, "ssh");
    const saved = h.saved(), { token, round, commit, control } = saved;
    const expected = { id: control.monitor.id, binding: { round, commit, token, helperSha256: control.helperSha256 } };
    assert.equal(argv.at(-2), `root@${saved.ip}`);
    assert.equal(argv.at(-1), `/usr/bin/python3 -I /run/corten-bench-control-${token}/helper.py monitor ${token} ${Buffer.from(JSON.stringify(expected)).toString("hex")}`);
    const child = new EventEmitter();
    let sequence = 0, ended = false, receivedClose = false, startup, terminal;
    const frame = (kind, payload) => child.stdout.write(JSON.stringify({ schema: "benchmark-control-frame/v1",
      id: expected.id, sequence: ++sequence, kind, payload }) + "\n");
    const close = (code) => {
      if (ended) return;
      ended = true;
      clearImmediate(startup); clearImmediate(terminal);
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      child.emit("close", code, null);
    };
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new Writable({ write(bytes, encoding, next) {
      assert.deepEqual(JSON.parse(bytes), { id: expected.id, kind: "close", payload: {} });
      receivedClose = true; next();
    } });
    child.stdin.on("close", () => close(receivedClose ? 0 : 255));
    startup = setImmediate(() => {
      frame("registered", { ...structuredClone(registration), ...expected });
      frame("progress", { state: "active" });
    });
    finishMonitor = () => {
      assert.equal(ended, false);
      terminal = setImmediate(() => frame("terminal", { id: expected.id, nativeTerminal: true,
        campaign: `${round}-${token}`, sealSha256: "f".repeat(64) }));
    };
    t.after(() => close(255));
    return child;
  }
  return { spawn, streamSpawn, roleCheck: () => [] }; // Synthetic Git has no native binding to generate.
}
