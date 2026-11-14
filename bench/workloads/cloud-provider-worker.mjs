// Fixed production entry. No token or diagnostic output crosses its IPC boundary.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerHooks } from "node:module";

const names = ["cloud-provider-worker.mjs", "cloud-provider-engine.mjs", "cloud-provider.mjs", "cloud-transport.mjs", "cloud-contract.mjs", "cloud-options.mjs",
  "../catalog/droplet-contract.mjs", "../catalog/contract.mjs", "../catalog/group.mjs", "../fullstack/passes.mjs", "../fullstack/inventory.mjs", "../marketplace/contract.mjs", "registry.mjs"];
const stdinEntry = process.argv[1] === "-" && process.argv.length === 3;
const directory = stdinEntry ? dirname(resolve(process.argv[2])) : dirname(fileURLToPath(import.meta.url));
const exact = (value, keys) => assert.deepEqual(Object.keys(value ?? {}).sort(), [...keys].sort());
const diagnosticEnv = /^(?:NODE_|SSL|OPENSSL|LD_|DYLD_)/i;
function action(message, host) {
  exact(message, ["schema", "sequence", "args", "timeout", "allowFail"]);
  assert.ok(Array.isArray(message.args) && message.args.length <= 20 && message.args.every((value) => typeof value === "string" && value.length <= 512 && !value.includes("\0")));
  assert.ok(Number.isSafeInteger(message.timeout) && message.timeout > 0 && message.timeout <= 900000 && typeof message.allowFail === "boolean");
  const args = message.args;
  assert.equal(args.at(-2), "--context"); assert.match(args.at(-1), /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);
  const command = args.slice(0, -2);
  if (command[0] === "account") assert.deepEqual(command, ["account", "get", "--output", "json"]);
  else if (command[2] === "list") assert.deepEqual(command, ["compute", "droplet", "list", "--output", "json"]);
  else if (command[2] === "delete") {
    assert.equal(command.length, 5); assert.deepEqual(command.slice(0, 3), ["compute", "droplet", "delete"]);
    assert.match(command[3], /^[1-9]\d*$/); assert.equal(command[4], "--force");
  } else {
    assert.equal(command.length, 17);
    assert.deepEqual(command.filter((_, i) => ![3, 5, 7, 9, 11, 13].includes(i)), ["compute", "droplet", "create", "--size", "--region", "--image", "--ssh-keys", "--tag-names", "--wait", "--output", "json"]);
    assert.match(command[3], /^corten-bench-groups-r[1-9]\d{0,8}-[a-f0-9]{16}$/);
    assert.equal(command[5], host.size); assert.equal(command[7], host.region); assert.equal(command[9], host.image);
    assert.match(command[11], /^[1-9]\d*$/);
    assert.equal(command[13], `corten-bench,corten-bench-groups,corten-bench-groups-run-${command[3].slice(-16)}`);
  }
}

// Synthetic entries can inject dependencies in code, never through production
// argv/environment/IPC or a configurable provider origin.
export function serveProviderWorker(dependencies = {}) {
  assert.ok(process.connected && process.send, "provider requires an owned IPC child");
  assert.deepEqual(process.execArgv, stdinEntry ? ["--input-type=module"] : []);
  if (stdinEntry) assert.equal(process.argv[2], join(directory, "cloud-provider-worker.mjs"));
  assert.ok(Object.keys(process.env).every((name) => !diagnosticEnv.test(name) || name === "NODE_CHANNEL_FD" || name === "NODE_CHANNEL_SERIALIZATION_MODE"));
  let nonce, sequence = 0, active = false, closing = false, failed = false, run, host, providerFailure;
  const stop = () => { closing = true; if (!active) process.exit(0); };
  process.on("disconnect", stop);
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.on("message", async (message) => {
    if (message?.schema === "cloud-provider-close/v1") {
      try { exact(message, ["schema"]); stop(); } catch { process.exit(2); } return;
    }
    if (active || failed || closing) { failed = true; stop(); return; }
    active = true;
    let ok = false, result = null;
    try {
      if (nonce === undefined) {
        exact(message, ["schema", "nonce", "sources"]); assert.equal(message.schema, "cloud-provider-init/v1");
        assert.match(message.nonce, /^[a-f0-9]{32}$/); nonce = message.nonce;
        assert.deepEqual(message.sources.map((value) => value.name), names);
        const approved = new Map();
        for (const source of message.sources) {
          exact(source, ["name", "sha256"]);
          const path = join(directory, source.name), stat = lstatSync(path);
          assert.ok(stat.isFile() && !stat.isSymbolicLink() && realpathSync(path) === path);
          const bytes = readFileSync(path);
          assert.equal(createHash("sha256").update(bytes).digest("hex"), source.sha256);
          approved.set(pathToFileURL(path).href, bytes);
        }
        // No project code has run before this point. Load only the verified
        // snapshot bytes; a future omitted import fails before evaluation.
        registerHooks({ load(url, context, nextLoad) {
          if (url.startsWith("node:")) return nextLoad(url, context);
          const source = approved.get(url); assert.ok(source, "unapproved provider executable import");
          return { format: "module", source, shortCircuit: true };
        } });
        const engine = await import(pathToFileURL(join(directory, "cloud-provider-engine.mjs")).href);
        providerFailure = (await import(pathToFileURL(join(directory, "cloud-options.mjs")).href)).providerFailure;
        host = (await import(pathToFileURL(join(directory, "cloud-contract.mjs")).href)).host;
        const { createProviderEngine } = engine;
        run = createProviderEngine({ ...dependencies, repo: process.cwd(), interrupted: () => closing }); result = "ready";
      } else {
        action(message, host); assert.equal(message.schema, "cloud-provider-action/v1"); assert.equal(message.sequence, sequence + 1); sequence++;
        result = await run(message.args, message.timeout, message.allowFail);
        // Never serialize exceptions, provider error bodies or native stderr.
        const diagnostic = result.status === 1 ? providerFailure(result) : undefined;
        result = { status: result.status, stdout: result.stdout, stderr: "", ...(diagnostic ? { providerDiagnostic: diagnostic } : {}) };
      }
      ok = true;
    } catch (error) { failed = true; result = providerFailure?.(error) ?? null; }
    finally {
      active = false;
      if (process.connected) process.send({ schema: "cloud-provider-result/v1", nonce: nonce ?? "", sequence, ok, result }, (error) => {
        if (error || closing || failed) process.exit(error || failed ? 2 : 0);
      });
      else process.exit(2);
    }
  });
  process.send({ schema: "cloud-provider-boot/v1" }, (error) => { if (error) process.exit(2); });
}

if (stdinEntry || process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { serveProviderWorker(); } catch { process.exit(2); }
}
