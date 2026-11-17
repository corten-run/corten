// Synchronous process boundary for the reviewed lifecycle. No shell, retries or logs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { isAbsolute } from "node:path";
import { setImmediate as turn } from "node:timers/promises";

export async function controlCheckpoint(interrupted) {
  // Cross a poll phase even when entered from a check-phase callback. Promise
  // microtasks alone cannot deliver OS signals deferred by a synchronous child.
  await turn(); await turn();
  assert.ok(!interrupted(), "controller cancelled; preserve reservation/evidence/host");
}

export const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
export const controlEnvironment = (binary) => {
  const env = {};
  for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "TEMP", "TMP",
    ...(["ssh", "scp"].includes(binary) ? ["SSH_AUTH_SOCK", "ProgramData"] : [])])
    if (process.env[key] !== undefined) env[key] = process.env[key];
  return { ...env, GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" };
};
export function shellTransport({ repo, spawn = spawnSync } = {}) {
  assert.ok(isAbsolute(repo));
  // Capture inherited credentials/config locations once, never re-read mutable
  // process.env between account proof and a mutation. Nothing is logged or saved.
  const environments = new Map(["git", "doctl", "ssh", "scp"].map((binary) => [binary, controlEnvironment(binary)]));
  return (binary, args, timeout = 60000, allowFail = false, _expiry, control) => {
    assert.ok(["git", "doctl", "ssh", "scp"].includes(binary), "unsupported control executable");
    assert.ok(Array.isArray(args) && args.every((v) => typeof v === "string" && !v.includes("\0")));
    assert.ok(Number.isSafeInteger(timeout) && timeout > 0 && timeout <= 15 * 60000, "bounded control timeout required");
    let argv = [...args], input, executable = binary;
    if (binary === "doctl") {
      // doctl otherwise retries 429/5xx requests, including ambiguous mutations.
      argv = [...args, "--http-retry-max", "0", "--api-url", "https://api.digitalocean.com", "--interactive=false", "--trace=false", "--verbose=false"];
    }
    if (binary === "ssh" || binary === "scp") {
      argv = args.map((value) => {
        if (!value.startsWith("UserKnownHostsFile=")) return value;
        const path = value.slice("UserKnownHostsFile=".length);
        assert.ok(!/["$%\r\n\0]/.test(path), "SSH config expansion in state path refused");
        return `UserKnownHostsFile="${path}"`;
      });
      argv.unshift("-F", "none", "-o", "ForwardAgent=no", "-o", "ClearAllForwardings=yes", "-o", "PermitLocalCommand=no", "-o", "ControlMaster=no", "-o", "ControlPath=none");
      if (binary === "ssh") {
        assert.match(args.at(-2), /^root@(?:\d{1,3}\.){3}\d{1,3}$/);
        input = `set -euo pipefail\n${args.at(-1)}\n`; argv[argv.length - 1] = control ? control.command : "/bin/bash -s";
      } else {
        assert.equal(args.slice(-2).filter((v) => /^root@(?:\d{1,3}\.){3}\d{1,3}:\/bench\//.test(v)).length, 1, "one owned remote SCP endpoint required");
        assert.ok(args.slice(-2).some((v) => isAbsolute(v)), "absolute local SCP endpoint required");
        if (control) {
          executable = "sftp";
          const pair = args.slice(-2), remote = pair.find((v) => v.startsWith("root@")), local = pair.find((v) => v !== remote);
          const [target, path] = remote.split(":");
          assert.ok(!/[\r\n\0]/.test(local + path) && !path.split("/").some((p) => p === ".." || p === "."), "invalid SFTP batch path");
          const batch = (v) => `"${(process.platform === "win32" ? v.replaceAll("\\", "/") : v).replace(/[\\"*?\[\]]/g, "\\$&")}"`;
          input = pair[0] === remote ? `get ${batch(path)} ${batch(local)}\n` : `put ${batch(local)} ${batch(path)}\n`;
          argv = [...argv.slice(0, -2), "-b", "-", "-s", control.command, target];
        } else argv.unshift("-B"); // Explicit legacy evidence transport, never SCP -O.
      }
    }
    let result;
    try {
      result = spawn(executable, argv, { cwd: repo, shell: false, windowsHide: true, encoding: "utf8", input,
        stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], timeout, killSignal: "SIGKILL", maxBuffer: 16 * 1024 ** 2, env: { ...environments.get(binary) } });
    } catch { result = { status: null, error: new Error("control spawn uncertain"), stdout: "", stderr: "" }; }
    const failed = result.error || result.status !== 0 || result.signal;
    // spawnSync only proves the direct child has ended. On every platform a
    // timeout/signal/overflow can leave descendants alive. Never retry, and keep
    // the lifecycle locks until an operator establishes the whole tree is gone.
    if (result.error || result.signal || !Number.isInteger(result.status))
      throw Object.assign(new Error("control tree uncertain; preserve locks/state/evidence/host"), { controlTreeUncertain: true });
    if (control) {
      const id = control.request.invocation.id;
      assert.match(id, /^[a-f0-9]{32}$/);
      const ack = new RegExp(`^CORTEN_CONTROL ${id} ([a-f0-9]{64})\\r?$`, "m").exec(result.stderr ?? "");
      const terminal = new RegExp(`^CORTEN_RESULT ${id} ([0-9]{1,3})\\r?$`, "m").exec(result.stderr ?? "");
      if (!ack || !terminal || result.status === 255 || Number(terminal[1]) !== result.status)
        throw Object.assign(new Error("remote control completion uncertain; preserve locks/state/evidence/host"), { controlTreeUncertain: true });
    }
    if (failed && !allowFail) throw new Error("control process failed or uncertain; preserve state/evidence/host");
    // Keep stdout only for fixed parsers. Never return credentials/stacks/stderr.
    return { status: failed ? result.status === 0 ? null : result.status ?? null : 0, stdout: result.stdout ?? "", stderr: "",
      ...(["ssh", "scp"].includes(binary) ? { remoteDrained: false } : {}),
      ...(failed ? { error: new Error("control result uncertain") } : {}) };
  };
}
