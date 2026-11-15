// One private credential value per approved action. No config copies, token
// environment/arguments, mutable doctl provider subprocesses, redirects or HTTP/mutation retries.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { request as httpsRequest } from "node:https";
import { setTimeout as delay } from "node:timers/promises";
import { debuglog } from "node:util";
import { url as inspectorUrl } from "node:inspector";
import { controlCheckpoint, controlEnvironment } from "./cloud-transport.mjs";
import { host } from "./cloud-contract.mjs";
import { providerDiagnostic, providerFailure } from "./cloud-options.mjs";

const origin = "https://api.digitalocean.com";
const stopped = (uncertain = false, diagnostic) => Object.assign(new Error("provider control failed; preserve state/evidence/host"),
  uncertain ? { controlUncertain: true } : {}, diagnostic ? { providerDiagnostic: diagnostic } : {});
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const validContext = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value);
const diagnosticOption = /^--(?:inspect(?:-brk|-wait)?|trace-tls|tls-keylog|heapsnapshot-signal|heap-prof|cpu-prof|report-on-signal|report-on-fatalerror|report-uncaught-exception|trace-events-enabled|trace-event-categories|experimental-network-inspection)$/;
function nodeOptionArgs(text) {
  // Match Node's ParseNodeOptionsEnvVar: spaces separate arguments outside
  // double quotes; inside quotes a backslash escapes the next character.
  const args = []; let quoted = false, next = true;
  for (let i = 0; i < text.length; i++) {
    let ch = text[i];
    if (ch === "\\" && quoted) { if (++i === text.length) return null; ch = text[i]; }
    else if (ch === " " && !quoted) { next = true; continue; }
    else if (ch === '"') { quoted = !quoted; continue; }
    if (next) { args.push(ch); next = false; } else args[args.length - 1] += ch;
  }
  return quoted ? null : args;
}
const diagnosticOptions = (args) => args === null || args.some((arg, index) => {
  arg = arg.replaceAll("_", "-"); const equals = arg.indexOf("="), name = equals === -1 ? arg : arg.slice(0, equals);
  if (diagnosticOption.test(name)) return true;
  // Inactive heap-limit=0 and inspector-port/profile-interval metadata do not
  // enable diagnostics; Node's test runner propagates those defaults explicitly.
  return name === "--heapsnapshot-near-heap-limit" && (equals === -1 ? args[index + 1] : arg.slice(equals + 1)) !== "0";
});
const diagnosticConfiguration = () =>
  ["NODE_DEBUG", "NODE_DEBUG_NATIVE", "SSLKEYLOGFILE"].some((name) => Boolean(process.env[name]))
  || [nodeOptionArgs(process.env.NODE_OPTIONS ?? ""), process.execArgv].some(diagnosticOptions) || inspectorUrl() !== undefined
  || process.report.reportOnSignal || process.report.reportOnFatalError || process.report.reportOnUncaughtException;
// Node caches debug enablement independently of mutable process.env. Checking
// only the current variable (or filtering child env) cannot protect this process.
const diagnosticsAtImport = diagnosticConfiguration() || debuglog("http").enabled || debuglog("https").enabled;
function privateDiagnostics() {
  if (diagnosticsAtImport || diagnosticConfiguration() || debuglog("http").enabled || debuglog("https").enabled)
    throw new Error("provider diagnostics must be disabled");
}

function restRequest({ method, path, credential, body, timeout, interrupted = () => false }, connect = httpsRequest) {
  return new Promise((resolve, reject) => {
    let settled = false, req, timer, cancellation;
    const finish = (error, result) => {
      if (settled) return; settled = true; clearTimeout(timer); clearInterval(cancellation);
      if (error) { req?.destroy(); reject(stopped(true)); } else resolve(result);
    };
    try {
      privateDiagnostics();
      assert.ok(path.startsWith("/v2/") && !path.startsWith("//"));
      assert.ok(Number.isSafeInteger(timeout) && timeout > 0 && timeout <= 900000);
      assert.ok(!interrupted());
      const input = body === undefined ? undefined : JSON.stringify(body);
      req = connect(new URL(path, origin), { method, agent: false, rejectUnauthorized: true,
        headers: { authorization: `Bearer ${credential}`, accept: "application/json", ...(input === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(input) }) } }, (res) => {
        const chunks = []; let bytes = 0;
        res.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > 16 * 1024 ** 2) { res.destroy(); finish(stopped(true)); } else chunks.push(chunk);
        });
        res.on("error", () => finish(stopped(true)));
        res.on("aborted", () => finish(stopped(true)));
        res.on("end", () => {
          if (settled) return;
          try {
            assert.ok(Number.isInteger(res.statusCode));
            // Error bodies are never parsed/returned: they can contain raw values.
            const value = res.statusCode >= 200 && res.statusCode < 300 && bytes ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
            finish(null, { status: res.statusCode, value });
          } catch { finish(stopped(true)); }
        });
      });
      req.on("error", () => finish(stopped(true)));
      timer = setTimeout(() => finish(stopped(true)), timeout);
      cancellation = setInterval(() => { if (interrupted()) finish(stopped(true)); }, 25);
      req.end(input);
    } catch { finish(stopped(true)); }
  });
}

// Production calls this only inside the clean credential worker. Dependency
// injection is for synthetic controls, never an IPC/CLI option.
export function createProviderEngine({ repo, spawn = spawnSync, connect = httpsRequest,
  request = (options) => restRequest(options, connect), interrupted = () => false, sleep = delay, now = Date.now } = {}) {
  const env = controlEnvironment("doctl");
  let credential, context;
  const consume = (selected) => {
    privateDiagnostics();
    assert.ok(validContext(selected), "saved provider context required");
    if (context !== undefined) { assert.equal(selected, context, "provider context changed"); assert.ok(typeof credential === "string", "credential consumption unavailable"); return; }
    context = selected;
    let result;
    try {
      // auth token is a read-only local consumption API; unlike auth init/switch
      // it neither changes the default context nor refreshes/writes OAuth state.
      result = spawn("doctl", ["auth", "token", "--context", context, "--http-retry-max", "0", "--api-url", origin,
        "--interactive=false", "--trace=false", "--verbose=false"], { cwd: repo, shell: false, windowsHide: true,
        encoding: "buffer", stdio: ["ignore", "pipe", "pipe"], timeout: 10000, killSignal: "SIGKILL", maxBuffer: 8192, env: { ...env } });
      if (result.error || result.signal || !Number.isInteger(result.status)) throw stopped(true);
      if (result.status !== 0) throw stopped();
      const value = (Buffer.isBuffer(result.stdout) ? result.stdout.toString("utf8") : String(result.stdout ?? "")).replace(/\r?\n$/, "");
      // Boolean assertion only: a failure must never echo a credential.
      assert.ok(value.length >= 20 && value.length <= 4096 && /^[A-Za-z0-9._~+/-]+=*$/.test(value));
      credential = value;
    } catch (error) { throw stopped(error?.controlUncertain === true, { code: "provider-credential" }); }
    finally { if (Buffer.isBuffer(result?.stdout)) result.stdout.fill(0); if (Buffer.isBuffer(result?.stderr)) result.stderr.fill(0); }
  };
  return async (args, timeout = 60000, allowFail = false) => {
    assert.ok(Array.isArray(args) && args.at(-2) === "--context", "saved provider context required");
    consume(args.at(-1));
    assert.ok(!interrupted(), "controller cancelled");
    const command = args.slice(0, -2), deadline = now() + timeout;
    let code = "provider-command";
    let listTime = deadline - timeout;
    const readRemaining = () => {
      const current = now();
      if (!Number.isFinite(current) || !Number.isFinite(deadline) || current < listTime || current >= deadline || interrupted()) throw stopped(true);
      listTime = current; return Math.ceil(deadline - current);
    };
    const call = async (phase, method, path, body, expected = 200) => {
      await controlCheckpoint(interrupted);
      const remaining = phase === "list" || phase === "get" ? readRemaining() : Math.ceil(deadline - now());
      if (interrupted() || remaining <= 0) throw stopped(true);
      code = `${phase}-request`;
      let response;
      try { response = await request({ method, path, body, credential, timeout: remaining, interrupted }); }
      catch { throw stopped(true); }
      try { await controlCheckpoint(interrupted); } catch { throw stopped(); }
      if (phase === "list" || phase === "get") readRemaining();
      if (response?.status !== expected) {
        const diagnostic = providerDiagnostic({ code: `${phase}-http`, httpStatus: response?.status }) ?? { code: `${phase}-http` };
        throw Object.assign(stopped(false, diagnostic), { httpFailure: true });
      }
      return response.value;
    };
    const refuseCreate = (diagnostic) => {
      // A known semantic refusal is recoverable on this worker, not success.
      // Deadline/cancellation must never be converted into that narrow result.
      const current = now();
      if (!Number.isFinite(current) || !Number.isFinite(deadline) || current < listTime || current >= deadline || interrupted()) throw stopped(true);
      throw Object.assign(stopped(false, diagnostic), { createSemanticFailure: true });
    };
    try {
      let value;
      if (command[0] === "account") {
        assert.deepEqual(command, ["account", "get", "--output", "json"]);
        value = (await call("account", "GET", "/v2/account"))?.account ?? null;
      } else if (command[2] === "list") {
        assert.deepEqual(command, ["compute", "droplet", "list", "--output", "json"]);
        let requests = 0;
        for (;;) {
          const rows = [], seen = new Set(); let total;
          for (let page = 1; page <= 100; page++) {
            if (!(requests < 100)) throw stopped(false, { code: "list-response-bounds" }); requests++;
            const result = await call("list", "GET", `/v2/droplets?page=${page}&per_page=200`);
            code = "list-response";
            // Attach subcodes only at refused predicates, never to checkpoints.
            if (!Array.isArray(result?.droplets)) throw stopped(false, { code: "list-response-shape" });
            if (!(result.droplets.length <= 200)) throw stopped(false, { code: "list-response-bounds" });
            if (!(Number.isSafeInteger(result.meta?.total) && result.meta.total >= 0)) throw stopped(false, { code: "list-response-total" });
            if (!(result.meta.total <= 20000)) throw stopped(false, { code: "list-response-bounds" });
            for (const droplet of result.droplets) {
              if (!positive(droplet?.id)) throw stopped(false, { code: "list-response-id" });
              if (seen.has(droplet.id)) throw stopped(false, { code: "list-response-duplicate" });
              seen.add(droplet.id); rows.push(droplet);
            }
            if (result.links !== undefined && !(result.links && typeof result.links === "object" && !Array.isArray(result.links))) throw stopped(false, { code: "list-response-links" });
            if (result.links?.pages !== undefined && !(result.links.pages && typeof result.links.pages === "object" && !Array.isArray(result.links.pages))) throw stopped(false, { code: "list-response-pages" });
            const next = result.links?.pages?.next;
            if (next !== undefined) {
              if (typeof next !== "string") throw stopped(false, { code: "list-response-next" });
              let url; try { url = new URL(next); } catch { throw stopped(false, { code: "list-response-next" }); }
              if (!(url.origin === origin && url.pathname === "/v2/droplets" && !url.username && !url.password && !url.hash)) throw stopped(false, { code: "list-response-next" });
              const fields = [...url.searchParams.keys()].sort();
              if (!(fields.length === 2 && fields[0] === "page" && fields[1] === "per_page")) throw stopped(false, { code: "list-response-next" });
              if (!(url.searchParams.get("page") === String(page + 1) && url.searchParams.get("per_page") === "200")) throw stopped(false, { code: "list-response-next" });
            }
            readRemaining();
            // Only these two internal count conditions permit a fresh page1.
            // All page/ID/link validation above must succeed first. No catch on
            // the public list-response code, and no rows survive the retake.
            const changed = total !== undefined && result.meta.total !== total;
            total ??= result.meta.total;
            if (changed || next === undefined && rows.length !== total) {
              if (requests === 100) throw stopped(false, { code: "list-response-count", detail: changed ? "total-changed" : "terminal-count-mismatch" });
              // Only count inconsistency permits a paced page1 retake. Waiting
              // spends the original deadline, never a fresh request budget.
              await sleep(Math.min(1000, readRemaining()));
              readRemaining(); break;
            }
            if (next === undefined) { value = rows; break; }
            if (!(rows.length < total && page < 100)) throw stopped(false, { code: "list-response-bounds" });
          }
          if (value !== undefined) break;
        }
        assert.ok(value !== undefined, "incomplete provider census");
      } else if (command[2] === "get") {
        assert.equal(command.length, 6);
        assert.deepEqual(command.slice(0, 3), ["compute", "droplet", "get"]);
        assert.deepEqual(command.slice(4), ["--output", "json"]);
        assert.ok(/^[1-9]\d*$/.test(command[3]) && positive(Number(command[3])), "positive exact droplet ID required");
        const result = await call("get", "GET", `/v2/droplets/${command[3]}`);
        code = "get-response";
        assert.ok(result?.droplet && !Array.isArray(result.droplet) && result.droplet.id === Number(command[3]));
        value = [result.droplet];
      } else if (command[2] === "create") {
        assert.equal(command.length, 17);
        assert.deepEqual(command.filter((_, i) => ![3, 5, 7, 9, 11, 13].includes(i)), ["compute", "droplet", "create", "--size", "--region", "--image", "--ssh-keys", "--tag-names", "--wait", "--output", "json"]);
        assert.equal(command[5], host.size); assert.equal(command[7], host.region); assert.equal(command[9], host.image);
        assert.ok(/^corten-bench-groups-r[1-9]\d{0,8}-[a-f0-9]{16}$/.test(command[3]) && /^[1-9]\d*$/.test(command[11]));
        assert.ok(/^corten-bench,corten-bench-groups,corten-bench-groups-run-[a-f0-9]{16}$/.test(command[13]));
        assert.equal(command[13], `corten-bench,corten-bench-groups,corten-bench-groups-run-${command[3].slice(-16)}`);
        const sshKey = Number(command[11]); assert.ok(positive(sshKey), "bounded numeric SSH key ID required");
        const result = await call("create", "POST", "/v2/droplets", { name: command[3], size: host.size, region: host.region, image: host.image,
          ssh_keys: [sshKey], tags: command[13].split(",") }, 202);
        code = "create-response";
        if (!positive(result?.droplet?.id)) refuseCreate({ code });
        code = "create-link";
        const actions = result.links?.actions;
        // Subcodes describe only a refused predicate, never a later checkpoint.
        if (!Array.isArray(actions)) refuseCreate({ code: "create-link-shape" });
        if (actions.length !== 1) refuseCreate({ code: "create-link-count" });
        if (!positive(actions[0]?.id)) refuseCreate({ code: "create-link-id" });
        // Project only consumed IDs. Unused rel/href metadata has no authority:
        // never read, parse, follow or forward it. The canonical GET proves the
        // action's actual type, resource and completion, not a link's spelling.
        const dropletId = result.droplet.id, actionId = actions[0].id;
        for (;;) {
          const response = await call("create-action", "GET", `/v2/actions/${actionId}`);
          code = "create-action-response";
          const action = response?.action;
          if (!(action?.id === actionId && action.resource_type === "droplet" && action.type === "create")) refuseCreate({ code });
          // The action model permits integer zero as well as null. Neither is
          // completion proof: only a completed action bound to this droplet is.
          if (!(action.resource_id === dropletId || action.status === "in-progress" && (action.resource_id === null || action.resource_id === 0))) refuseCreate({ code });
          if (action.status === "completed") { assert.equal(action.resource_id, dropletId); break; }
          if (action.status !== "in-progress") refuseCreate({ code });
          code = "create-action-pending";
          await sleep(Math.min(1000, Math.max(0, deadline - now())));
        }
        value = [{ id: dropletId }];
      } else {
        assert.equal(command.length, 5); assert.deepEqual(command.slice(0, 3), ["compute", "droplet", "delete"]); assert.equal(command[4], "--force");
        assert.ok(/^[1-9]\d*$/.test(command[3]));
        await call("delete", "DELETE", `/v2/droplets/${command[3]}`, undefined, 204); value = null;
      }
      code = "provider-output";
      const stdout = value === null ? "" : JSON.stringify(value);
      assert.ok(!stdout.includes(credential), "private provider response refused");
      if (command[2] === "list" || command[2] === "get") readRemaining();
      return { status: 0, stdout, stderr: "" };
    } catch (error) {
      const diagnostic = providerFailure(error) ?? { code };
      if (error?.controlUncertain) throw stopped(true, diagnostic);
      if (allowFail && (error?.createSemanticFailure === true || error?.httpFailure
        && (command[2] !== "get" || diagnostic.code === "get-http" && diagnostic.httpStatus === 404)))
        return { status: 1, stdout: "", stderr: "", providerDiagnostic: diagnostic, error: stopped(false, diagnostic) };
      throw stopped(false, diagnostic);
    }
  };
}
