// One private credential value per approved action. No config copies, token
// environment/arguments, mutable doctl provider subprocesses, redirects or mutation retries.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { request as httpsRequest } from "node:https";
import { ClientRequest, IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { debuglog } from "node:util";
import { url as inspectorUrl } from "node:inspector";
import { controlCheckpoint, controlEnvironment } from "./cloud-transport.mjs";
import { fleetCatalogCommand, fleetCatalogSlugs, preloginUserData, providerCreateHost } from "./cloud-contract.mjs";
import { providerDiagnostic, providerFailure, unsentDelete } from "./cloud-options.mjs";

const origin = "https://api.digitalocean.com";
const stopped = (uncertain = false, diagnostic) => Object.assign(new Error("provider control failed; preserve state/evidence/host"),
  uncertain ? { controlUncertain: true } : {}, diagnostic ? { providerDiagnostic: diagnostic } : {});
const refused = (diagnostic) => ({ status: 1, stdout: "", stderr: "", providerDiagnostic: diagnostic, error: stopped(false, diagnostic) });
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const validContext = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value);

async function placementCatalog(call) {
  const catalog = {};
  for (const kind of ["sizes", "regions"]) {
    const membership = kind === "sizes" ? "regions" : "sizes";
    const rows = [], seen = new Set(); let total;
    for (let page = 1; page <= 10; page++) {
      // Never follow a provider-supplied link. It can only indicate the next
      // page of this one fixed listing under the original command deadline.
      const result = await call("catalog", "GET", `/v2/${kind}?page=${page}&per_page=200`);
      const batch = result?.[kind], count = result?.meta?.total;
      assert.ok(Array.isArray(batch) && batch.length <= 200 && Number.isSafeInteger(count) && count >= 0 && count <= 2000
        && (total === undefined || total === count), "incomplete fleet catalog");
      total = count;
      for (const row of batch) {
        const slug = row?.slug;
        assert.ok(typeof slug === "string" && !seen.has(slug), "invalid fleet catalog slug");
        seen.add(slug);
        if (!fleetCatalogSlugs[kind].includes(slug)) continue;
        assert.ok(typeof row.available === "boolean" && Array.isArray(row[membership])
          && row[membership].every((value) => typeof value === "string"), "incomplete fleet catalog entry");
        rows.push({ slug, available: row.available, [membership]: fleetCatalogSlugs[membership].filter((value) => row[membership].includes(value)) });
      }
      assert.ok(result.links === undefined || result.links && typeof result.links === "object" && !Array.isArray(result.links));
      const pages = result.links?.pages;
      assert.ok(pages === undefined || pages && typeof pages === "object" && !Array.isArray(pages));
      const next = pages?.next;
      if (next === undefined) { assert.equal(seen.size, total, "incomplete fleet catalog"); break; }
      assert.ok(typeof next === "string" && seen.size < total && batch.length > 0 && page < 10, "incomplete fleet catalog pagination");
      const url = new URL(next);
      assert.ok(url.origin === origin && url.pathname === `/v2/${kind}` && !url.username && !url.password && !url.hash
        && url.searchParams.size === 2 && url.searchParams.get("page") === String(page + 1)
        && url.searchParams.get("per_page") === "200", "invalid fleet catalog pagination");
    }
    catalog[kind] = rows;
  }
  return catalog;
}
// Private object identity, never a caller-supplied property or public diagnostic.
const closedAccountRequests = new WeakMap(), settledAccountFailures = new WeakSet();
const unsentDeletes = new WeakSet();
export const isSettledAccountFailure = (error) => settledAccountFailures.has(error);
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

// One clock for an account command, including credential consumption, native
// callbacks, any retry and final settlement. A later sample cannot undo a rollback.
function accountClock(clock) {
  let latest = -Infinity;
  return () => {
    const current = clock();
    latest = Number.isFinite(current) && current >= latest ? current : NaN;
    return latest;
  };
}

function restRequest({ method, path, credential, body, timeout, accountDeadline = Infinity, now = Date.now, interrupted = () => false, deleteProofExpiresAtMs, catalog = false }, connect, resources) {
  return new Promise((resolve, reject) => {
    let settled = false, informationSeen = false, connectEntered = false, sendEntered = false, req, timer, cancellation, failureDetail = "internal-refusal";
    const account = method === "GET" && path === "/v2/account";
    const started = now(), expires = Math.min(started + timeout, accountDeadline);
    if (account && !(started < expires)) {
      reject(stopped(true, { code: "account-request", detail: "deadline" })); return;
    }
    let lastTime = started, outcome;
    const inTime = () => {
      const current = now(), valid = current >= lastTime && current < expires;
      lastTime = current; return valid;
    };
    const record = { requestClosed: false, socketClosed: false, socketSeen: false, responseClosed: false, responseSeen: false, native: false };
    resources.live.add(record);
    const changed = () => {
      if (record.native && record.requestClosed && record.socketSeen && record.socketClosed && (!record.responseSeen || record.responseClosed)) {
        resources.live.delete(record);
        for (const notify of resources.notify) notify();
      }
    };
    const complete = (proof) => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearInterval(cancellation); resources.notify.delete(closed);
      const { detail, result, reset } = outcome;
      if (detail) {
        const error = stopped(true, account ? { code: "account-request", detail } : undefined);
        if (deleteProofExpiresAtMs !== undefined && method === "DELETE" && !sendEntered && !record.responseSeen
          && (!connectEntered || req instanceof ClientRequest && req.destroyed && !req.headersSent)) unsentDeletes.add(error);
        if (proof) closedAccountRequests.set(error, { at: lastTime, reset });
        reject(error);
      } else {
        if (proof) closedAccountRequests.set(result, { at: lastTime });
        resolve(result);
      }
    };
    const closed = () => {
      if (!outcome || resources.live.size) return;
      if (inTime() && !interrupted()) complete(true);
      else { if (!outcome.detail) outcome = { detail: "internal-refusal" }; complete(false); }
    };
    const finish = (detail, result, reset = false) => {
      if (settled) return;
      if (outcome) {
        // Expiry/cancellation during closure must not turn a rejected read into
        // proof, even if its transport later closes. Never renew the deadline.
        if (["deadline", "cancelled", "internal-refusal"].includes(detail)) {
          if (!outcome.detail) outcome = { detail, result };
          complete(false);
        }
        return;
      }
      outcome = { detail, result, reset };
      if (detail) {
        req?.destroy();
      }
      if (account && record.native && !["internal-refusal", "connect", "deadline", "cancelled"].includes(detail)) {
        resources.notify.add(closed); closed();
      } else complete(false);
    };
    try {
      privateDiagnostics();
      assert.ok(path.startsWith("/v2/") && !path.startsWith("//"));
      assert.ok(Number.isSafeInteger(timeout) && timeout > 0 && timeout <= 900000);
      failureDetail = "cancelled"; assert.ok(!interrupted()); failureDetail = "internal-refusal";
      if (account && !inTime()) { finish("deadline"); return; }
      const input = body === undefined ? undefined : JSON.stringify(body);
      const fresh = () => {
        if (deleteProofExpiresAtMs === undefined) return;
        const current = Date.now();
        assert.ok(method === "DELETE" && Number.isSafeInteger(deleteProofExpiresAtMs)
          && current < deleteProofExpiresAtMs && deleteProofExpiresAtMs - current <= 60000, "current retirement proof expired");
      };
      fresh();
      failureDetail = "connect";
      connectEntered = true;
      req = connect(new URL(path, origin), { method, agent: false, rejectUnauthorized: true,
        headers: { authorization: `Bearer ${credential}`, accept: "application/json", ...(input === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(input) }) } }, (res) => {
        record.responseSeen = true; record.native &&= res instanceof IncomingMessage;
        res.once("close", () => { record.responseClosed = true; changed(); });
        const chunks = []; let bytes = 0;
        res.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > 16 * 1024 ** 2) { res.destroy(); finish("body-limit"); } else chunks.push(chunk);
        });
        res.on("error", () => finish("response-error"));
        res.on("aborted", () => finish("response-aborted"));
        res.on("end", () => {
          if (settled || outcome) return;
          if (catalog && !(res instanceof IncomingMessage && res.complete)) { finish("response-aborted"); return; }
          let detail = "response-status";
          try {
            assert.ok(Number.isInteger(res.statusCode));
            // Error bodies are never parsed/returned: they can contain raw values.
            detail = "invalid-json";
            let value = null;
            if (res.statusCode >= 200 && res.statusCode < 300 && bytes) {
              try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
              catch (error) {
                // Only a complete catalog read can send malformed JSON to
                // listing validation instead of failing the transport.
                if (!catalog || !(error instanceof SyntaxError)) throw error;
              }
            }
            finish(null, { status: res.statusCode, value });
          } catch { finish(detail); }
        });
      });
      record.native = req instanceof ClientRequest;
      req.once("close", () => { record.requestClosed = true; changed(); });
      req.once("socket", (socket) => {
        record.socketSeen = true; record.native &&= socket instanceof Socket;
        socket.once("close", () => { record.socketClosed = true; changed(); });
      });
      failureDetail = "internal-refusal";
      if (account) req.once("information", () => { informationSeen = true; });
      req.on("error", (error) => finish("request-error", undefined,
        account && !outcome && record.native && !record.responseSeen && !informationSeen && Error.isError(error)
          && Object.getOwnPropertyDescriptor(error, "code")?.value === "ECONNRESET"));
      const timerStart = now();
      if (account && !(timerStart < expires)) { finish("deadline"); return; }
      const remaining = Math.max(1, expires - timerStart);
      timer = setTimeout(() => finish("deadline"), deleteProofExpiresAtMs === undefined ? remaining
        : Math.min(remaining, Math.max(1, deleteProofExpiresAtMs - Date.now())));
      cancellation = setInterval(() => {
        try { fresh(); if (interrupted()) finish("cancelled"); } catch { finish("internal-refusal"); }
      }, 25);
      const send = () => {
        if (settled) return;
        let detail = "internal-refusal";
        try {
          fresh(); detail = "cancelled"; assert.ok(!interrupted());
          if (account && !inTime()) { finish("deadline"); return; }
          detail = "send"; sendEntered = true; req.end(input);
        } catch { finish(detail); }
      };
      if (deleteProofExpiresAtMs === undefined) send();
      else {
        // end() can queue a mutation before an async Agent assigns a socket.
        // Keep it unbuffered until connection/TLS readiness, then recheck expiry.
        req.once("socket", (socket) => {
          if (socket.encrypted && !socket.authorized) socket.once("secureConnect", send);
          else if (socket.connecting) socket.once("connect", send);
          else send();
        });
      }
    } catch { finish(failureDetail); }
  });
}

// Production calls this only inside the clean credential worker. Dependency
// injection is for synthetic controls, never an IPC/CLI option.
export function createProviderEngine({ repo, spawn = spawnSync, connect = httpsRequest,
  request, interrupted = () => false, sleep = delay, now: clock = Date.now, createMode = null } = {}) {
  const host = providerCreateHost(createMode);
  const env = controlEnvironment("doctl");
  const resources = { live: new Set(), notify: new Set() };
  let unsafe = false, mutationPending = false;
  const nativeRequest = (options) => restRequest(options, connect, resources);
  request ??= (options) => options.accountDeadline === undefined ? nativeRequest(options) : requestAccount(options);
  async function requestAccount(options) {
    try { return await nativeRequest(options); }
    catch (error) {
      const proof = closedAccountRequests.get(error);
      if (!proof?.reset || unsafe || mutationPending) throw error;
      // Spend the same command budget and keep the captured credential. No
      // outward diagnostic can authorize a retry or stand in for native close.
      try { await controlCheckpoint(interrupted); }
      catch { throw stopped(true, providerFailure(error)); }
      const current = options.now();
      if (!(current >= proof.at && current < options.accountDeadline))
        throw stopped(true, providerFailure(error));
      return nativeRequest({ ...options, timeout: Math.ceil(options.accountDeadline - current) });
    }
  }
  let credential, context;
  const consume = (selected, timeout) => {
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
        encoding: "buffer", stdio: ["ignore", "pipe", "pipe"], timeout: Math.min(10000, timeout), killSignal: "SIGKILL", maxBuffer: 8192, env: { ...env } });
      if (result.error || result.signal || !Number.isInteger(result.status)) throw stopped(true);
      if (result.status !== 0) throw stopped();
      const value = (Buffer.isBuffer(result.stdout) ? result.stdout.toString("utf8") : String(result.stdout ?? "")).replace(/\r?\n$/, "");
      // Boolean assertion only: a failure must never echo a credential.
      assert.ok(value.length >= 20 && value.length <= 4096 && /^[A-Za-z0-9._~+/-]+=*$/.test(value));
      credential = value;
    } catch (error) { throw stopped(error?.controlUncertain === true, { code: "provider-credential" }); }
    finally { if (Buffer.isBuffer(result?.stdout)) result.stdout.fill(0); if (Buffer.isBuffer(result?.stderr)) result.stderr.fill(0); }
  };
  return async (args, timeout = 60000, allowFail = false, deleteProofExpiresAtMs) => {
    const now = args?.[0] === "account" ? accountClock(clock) : clock;
    const started = now(), deadline = started + timeout;
    assert.ok(Array.isArray(args) && args.at(-2) === "--context", "saved provider context required");
    if (args[2] === "create") assert.ok(host && args[7] === host.region, "provider create placement differs from authorized mode");
    if (deleteProofExpiresAtMs !== undefined) assert.ok(args[2] === "delete" && positive(deleteProofExpiresAtMs));
    const consumptionBudget = Math.ceil(deadline - now());
    if (!Number.isSafeInteger(consumptionBudget) || consumptionBudget <= 0 || consumptionBudget > timeout)
      throw stopped(true, { code: "provider-credential" });
    consume(args.at(-1), consumptionBudget);
    assert.ok(!interrupted(), "controller cancelled");
    const command = args.slice(0, -2);
    const reportUnsent = command[2] === "delete" && allowFail && deleteProofExpiresAtMs !== undefined && !unsafe && !mutationPending;
    let requestEntered = false, posted;
    let code = "provider-command";
    let listTime = deadline - timeout;
    const readRemaining = () => {
      const current = now();
      if (!Number.isFinite(current) || !Number.isFinite(deadline) || current < listTime || current >= deadline || interrupted()) throw stopped(true);
      listTime = current; return Math.ceil(deadline - current);
    };
    const call = async (phase, method, path, body, expected = 200) => {
      await controlCheckpoint(interrupted);
      const read = ["account", "list", "get", "catalog", "action"].includes(phase);
      const remaining = read ? readRemaining() : Math.ceil(deadline - now());
      if (interrupted() || remaining <= 0) throw stopped(true);
      code = `${phase}-request`;
      let response;
      if (deleteProofExpiresAtMs !== undefined) {
        const current = now();
        assert.ok(phase === "delete" && current < deleteProofExpiresAtMs && deleteProofExpiresAtMs - current <= 60000, "current retirement proof expired");
      }
      try { requestEntered = true; response = await request({ method, path, body, credential, timeout: remaining, interrupted,
        ...(phase === "account" ? { accountDeadline: deadline, now } : {}),
        ...(phase === "catalog" ? { catalog: true } : {}),
        ...(deleteProofExpiresAtMs === undefined ? {} : { deleteProofExpiresAtMs }) }); }
      catch (error) {
        if (reportUnsent && unsentDeletes.has(error)) throw error;
        const diagnostic = phase === "account" ? providerFailure(error) : undefined;
        const failure = stopped(true, diagnostic?.code === "account-request" ? diagnostic : undefined);
        if (phase === "account" && closedAccountRequests.has(error)) closedAccountRequests.set(failure, closedAccountRequests.get(error));
        throw failure;
      }
      try { await controlCheckpoint(interrupted); } catch { throw stopped(); }
      if (read && phase !== "account") readRemaining();
      if (response?.status !== expected) {
        const diagnostic = providerDiagnostic({ code: `${phase}-http`, httpStatus: response?.status }) ?? { code: `${phase}-http` };
        const failure = Object.assign(stopped(false, diagnostic), { httpFailure: true });
        if (phase === "account" && closedAccountRequests.has(response)) closedAccountRequests.set(failure, closedAccountRequests.get(response));
        throw failure;
      }
      if (phase === "account") {
        listTime = Math.max(listTime, closedAccountRequests.get(response)?.at ?? listTime);
        readRemaining();
      }
      return response.value;
    };
    const refuseCreate = (diagnostic, identity) => {
      // A known semantic refusal is recoverable on this worker, not success.
      // Deadline/cancellation must never be converted into that narrow result.
      const current = now();
      if (!Number.isFinite(current) || !Number.isFinite(deadline) || current < listTime || current >= deadline || interrupted()) throw stopped(true);
      throw Object.assign(stopped(false, diagnostic), { createSemanticFailure: true }, identity ? { createIdentity: identity } : {});
    };
    try {
      let value;
      if (command[0] === "account") {
        assert.deepEqual(command, ["account", "get", "--output", "json"]);
        value = (await call("account", "GET", "/v2/account"))?.account ?? null;
      } else if (command[1] === "placement") {
        assert.deepEqual(command, fleetCatalogCommand);
        try {
          value = await placementCatalog(async (...args) => {
            code = "catalog-request"; // Before the next page's checkpoint, not just its request.
            const result = await call(...args);
            code = "catalog-response";
            return result;
          });
        } catch (error) {
          if (!allowFail || code !== "catalog-response" || error?.controlUncertain) throw error;
          readRemaining();
          return refused({ code });
        }
      } else if (command[1] === "action") {
        // A later read of one known action. Only its identity and status leave the worker.
        assert.equal(command.length, 6);
        assert.deepEqual([...command.slice(0, 3), ...command.slice(4)], ["compute", "action", "get", "--output", "json"]);
        assert.ok(/^[1-9]\d*$/.test(command[3]) && positive(Number(command[3])), "positive exact action ID required");
        const action = (await call("action", "GET", `/v2/actions/${command[3]}`))?.action;
        code = "action-response";
        const word = (value) => typeof value === "string" && /^[a-z][a-z_-]{0,63}$/.test(value);
        if (!(action && typeof action === "object" && !Array.isArray(action) && action.id === Number(command[3]) && word(action.type)
          && word(action.resource_type) && word(action.status) && (action.resource_id === null || Number.isSafeInteger(action.resource_id) && action.resource_id >= 0)))
          throw stopped(false, { code });
        value = [{ id: action.id, type: action.type, resource_type: action.resource_type, resource_id: action.resource_id, status: action.status }];
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
        assert.equal(command[5], host.size); assert.equal(command[9], host.image);
        assert.ok(/^corten-bench-groups-r[1-9]\d{0,8}-[a-f0-9]{16}$/.test(command[3]) && /^[1-9]\d*$/.test(command[11]));
        assert.ok(/^corten-bench,corten-bench-groups,corten-bench-groups-run-[a-f0-9]{16}$/.test(command[13]));
        assert.equal(command[13], `corten-bench,corten-bench-groups,corten-bench-groups-run-${command[3].slice(-16)}`);
        const sshKey = Number(command[11]); assert.ok(positive(sshKey), "bounded numeric SSH key ID required");
        mutationPending = true;
        const result = await call("create", "POST", "/v2/droplets", { name: command[3], size: host.size, region: host.region, image: host.image,
          ssh_keys: [sshKey], tags: command[13].split(","), ...(createMode === "legacy" ? {} : { user_data: preloginUserData }) }, 202);
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
        // From here an unsettled outcome still identifies what the one POST created.
        posted = { dropletId: String(dropletId), actionId: String(actionId) };
        for (;;) {
          const response = await call("create-action", "GET", `/v2/actions/${actionId}`);
          code = "create-action-response";
          const action = response?.action;
          if (!(action?.id === actionId && action.resource_type === "droplet" && action.type === "create")) refuseCreate({ code });
          // The action model permits integer zero as well as null. Neither is
          // completion proof: only a completed action bound to this droplet is.
          if (!(action.resource_id === dropletId || action.status === "in-progress" && (action.resource_id === null || action.resource_id === 0))) refuseCreate({ code });
          if (action.status === "completed") { assert.equal(action.resource_id, dropletId); readRemaining(); break; }
          // A provider-terminal failure of this exact action and POST droplet. Only
          // their IDs leave the worker; absence is the controller's separate proof.
          if (action.status === "errored" && action.resource_id === dropletId)
            refuseCreate({ code: "create-action-errored" }, [{ id: dropletId, actionId }]);
          if (action.status !== "in-progress") refuseCreate({ code });
          code = "create-action-pending";
          await sleep(Math.min(1000, Math.max(0, deadline - now())));
        }
        value = [{ id: dropletId }];
      } else {
        assert.equal(command.length, 5); assert.deepEqual(command.slice(0, 3), ["compute", "droplet", "delete"]); assert.equal(command[4], "--force");
        assert.ok(/^[1-9]\d*$/.test(command[3]));
        mutationPending = true;
        await call("delete", "DELETE", `/v2/droplets/${command[3]}`, undefined, 204); value = null;
      }
      code = "provider-output";
      const stdout = value === null ? "" : JSON.stringify(value);
      assert.ok(!stdout.includes(credential), "private provider response refused");
      if (command[0] === "account" || command[1] === "placement" || command[2] === "list" || command[2] === "get") readRemaining();
      if (command[2] === "create" || command[2] === "delete") {
        const current = now();
        if (current >= started && current < deadline && !interrupted()) mutationPending = false;
      }
      return { status: 0, stdout, stderr: "" };
    } catch (error) {
      if (reportUnsent && mutationPending && (!requestEntered || unsentDeletes.has(error))) {
        mutationPending = false;
        return unsentDelete;
      }
      const diagnostic = providerFailure(error) ?? { code };
      const current = now();
      if (closedAccountRequests.has(error)) {
        if (!unsafe && !mutationPending && current >= closedAccountRequests.get(error).at
          && current >= started && current < deadline && !interrupted()) {
          const failure = stopped(false, diagnostic); settledAccountFailures.add(failure); throw failure;
        }
        unsafe = true; throw stopped(true, diagnostic);
      }
      if (error?.controlUncertain) unsafe = true;
      if (error?.controlUncertain) throw Object.assign(stopped(true, diagnostic), posted ? { pendingCreate: posted } : {});
      if (allowFail && !reportUnsent && (error?.createSemanticFailure === true || error?.httpFailure
        && (command[2] !== "get" || diagnostic.code === "get-http" && diagnostic.httpStatus === 404))) {
        const result = refused(diagnostic);
        if (diagnostic.code === "create-action-errored" && error.createIdentity) result.stdout = JSON.stringify(error.createIdentity);
        return result;
      }
      throw stopped(false, diagnostic);
    }
  };
}
