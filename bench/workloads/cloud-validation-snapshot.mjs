// Fixed read-only replay closure. No evidence/CLI value selects executable paths.
// Update deliberately when the native import graph changes; unknown imports fail closed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

export const validationPaths = Object.freeze([
  "bench/catalog/apparatus.mjs",
  "bench/catalog/cgroup.mjs",
  "bench/catalog/check.mjs",
  "bench/catalog/contract.mjs",
  "bench/catalog/droplet-contract.mjs",
  "bench/catalog/fixtures.mjs",
  "bench/catalog/group.mjs",
  "bench/catalog/preflight.mjs",
  "bench/catalog/raw.mjs",
  "bench/catalog/record-attempt.mjs",
  "bench/catalog/report.mjs",
  "bench/catalog/stats.mjs",
  "bench/catalog/timed.mjs",
  "bench/catalog/verify.mjs",
  "bench/client-heavy/build-replay.mjs",
  "bench/client-heavy/compiler.mjs",
  "bench/client-heavy/contract.mjs",
  "bench/client-heavy/install-layout.mjs",
  "bench/client-heavy/launch.mjs",
  "bench/client-heavy/replay-v2.mjs",
  "bench/client-heavy/verify-v2.mjs",
  "bench/client-heavy/verify.mjs",
  "bench/fullstack-browser/binding-artifact.mjs",
  "bench/fullstack-browser/binding-effects.mjs",
  "bench/fullstack-browser/binding-intrinsics.mjs",
  "bench/fullstack-browser/binding-modules.mjs",
  "bench/fullstack-browser/binding-window.mjs",
  "bench/fullstack-browser/bindings.mjs",
  "bench/fullstack-browser/cancellations.mjs",
  "bench/fullstack-browser/capture.mjs",
  "bench/fullstack-browser/cell-records.mjs",
  "bench/fullstack-browser/contract.mjs",
  "bench/fullstack-browser/document-navigation.mjs",
  "bench/fullstack-browser/json-records.mjs",
  "bench/fullstack-browser/ledger.mjs",
  "bench/fullstack-browser/lifecycle.mjs",
  "bench/fullstack-browser/native-browser-dom.mjs",
  "bench/fullstack-browser/native-evidence.mjs",
  "bench/fullstack-browser/native-execution.mjs",
  "bench/fullstack-browser/native-lifetimes.mjs",
  "bench/fullstack-browser/native-responses.mjs",
  "bench/fullstack-browser/native-source.mjs",
  "bench/fullstack-browser/navigation.mjs",
  "bench/fullstack-browser/upstream.mjs",
  "bench/fullstack-browser/verify.mjs",
  "bench/fullstack/apps.mjs",
  "bench/fullstack/conformance.mjs",
  "bench/fullstack/edge.mjs",
  "bench/fullstack/inventory.mjs",
  "bench/fullstack/mixed.mjs",
  "bench/fullstack/passes.mjs",
  "bench/hardening/bounded-requests.mjs",
  "bench/hardening/clock.mjs",
  "bench/hardening/dependency-recovery-capture.mjs",
  "bench/hardening/dependency-recovery-contract.mjs",
  "bench/hardening/evidence.mjs",
  "bench/hardening/lifecycle.mjs",
  "bench/hardening/native.mjs",
  "bench/hardening/plan.mjs",
  "bench/hardening/qualification.mjs",
  "bench/hardening/request-capture.mjs",
  "bench/hardening/verify.mjs",
  "bench/json-api/artifacts.mjs",
  "bench/json-api/contract.mjs",
  "bench/json-api/evidence.mjs",
  "bench/json-api/fixed-identity.mjs",
  "bench/json-api/fixed-prototype.mjs",
  "bench/json-api/fixed-stream.mjs",
  "bench/json-api/load-resource-proof.mjs",
  "bench/json-api/placement.mjs",
  "bench/json-api/process.mjs",
  "bench/json-api/production.mjs",
  "bench/json-api/report.mjs",
  "bench/json-api/timed-outcomes.mjs",
  "bench/live/admission.mjs",
  "bench/live/apps/drogon/wire.mjs",
  "bench/live/apps/laravel/wire.mjs",
  "bench/live/apps/leptos/wire.mjs",
  "bench/live/apps/phoenix/wire.mjs",
  "bench/live/apps/rails/wire.mjs",
  "bench/live/apps/topcoat/wire.mjs",
  "bench/live/fanout.mjs",
  "bench/live/measurement.mjs",
  "bench/live/native-http.mjs",
  "bench/live/native.mjs",
  "bench/live/parity.mjs",
  "bench/live/resources.mjs",
  "bench/live/verify.mjs",
  "bench/live/wire.mjs",
  "bench/load-tool.mjs",
  "bench/marketplace/check.mjs",
  "bench/marketplace/contract.mjs",
  "bench/marketplace/droplet-contract.mjs",
  "bench/marketplace/feature-contract.mjs",
  "bench/marketplace/fixtures.mjs",
  "bench/marketplace/groups.mjs",
  "bench/marketplace/load-evidence.mjs",
  "bench/marketplace/raw-contract.mjs",
  "bench/marketplace/records.mjs",
  "bench/marketplace/reference.mjs",
  "bench/marketplace/report.mjs",
  "bench/marketplace/run-contract.mjs",
  "bench/marketplace/saved-files.mjs",
  "bench/marketplace/split.mjs",
  "bench/marketplace/validate.mjs",
  "bench/mixed-production/build-context.mjs",
  "bench/mixed-production/capture.mjs",
  "bench/mixed-production/execution-evidence.mjs",
  "bench/mixed-production/execution-inputs.mjs",
  "bench/mixed-production/immutable-git.mjs",
  "bench/mixed-production/load-capture.mjs",
  "bench/mixed-production/measure.mjs",
  "bench/mixed-production/metrics.mjs",
  "bench/mixed-production/producer-evidence.mjs",
  "bench/mixed-production/qualification-evidence.mjs",
  "bench/mixed-production/resources.mjs",
  "bench/mixed-production/response-evidence.mjs",
  "bench/mixed-production/run.mjs",
  "bench/mixed-production/snapshot.mjs",
  "bench/mixed-production/source-audit.mjs",
  "bench/mixed-production/stats.mjs",
  "bench/mixed-production/upstream-ledger.mjs",
  "bench/mixed-production/verify.mjs",
  "bench/typescript.mjs",
  "bench/workloads/browser.mjs",
  "bench/workloads/client.mjs",
  "bench/workloads/cloud-audit.mjs",
  "bench/workloads/cloud-contract.mjs",
  "bench/workloads/cloud-control-runtime.mjs",
  "bench/workloads/cloud-control-session.mjs",
  "bench/workloads/cloud-control-stream.mjs",
  "bench/workloads/cloud-local.mjs",
  "bench/workloads/cloud-options.mjs",
  "bench/workloads/cloud-transport.mjs",
  "bench/workloads/cloud-validation-worker.mjs",
  "bench/workloads/deployments.mjs",
  "bench/workloads/evidence.mjs",
  "bench/workloads/hardening.mjs",
  "bench/workloads/isolated/adapters/client-heavy.mjs",
  "bench/workloads/isolated/adapters/fullstack-browser.mjs",
  "bench/workloads/isolated/adapters/hardening.mjs",
  "bench/workloads/isolated/adapters/live-delivery.mjs",
  "bench/workloads/isolated/adapters/mixed-production.mjs",
  "bench/workloads/isolated/adapters/recoverable-live.mjs",
  "bench/workloads/isolated/campaign-contract.mjs",
  "bench/workloads/isolated/campaign-journal.mjs",
  "bench/workloads/isolated/campaign-verify.mjs",
  "bench/workloads/isolated/composition.mjs",
  "bench/workloads/isolated/contract.mjs",
  "bench/workloads/isolated/control-admission.mjs",
  "bench/workloads/isolated/control-session-source.mjs",
  "bench/workloads/isolated/control-stream-source.mjs",
  "bench/workloads/isolated/control-stream.mjs",
  "bench/workloads/isolated/evidence.mjs",
  "bench/workloads/isolated/host-durable-writer.mjs",
  "bench/workloads/isolated/host-lifetime.mjs",
  "bench/workloads/isolated/host-observation.mjs",
  "bench/workloads/isolated/json-staging.mjs",
  "bench/workloads/isolated/mixed-staging.mjs",
  "bench/workloads/isolated/native-replay.mjs",
  "bench/workloads/isolated/native-roles.mjs",
  "bench/workloads/isolated/participant-executables.mjs",
  "bench/workloads/isolated/process.mjs",
  "bench/workloads/isolated/raw-support.mjs",
  "bench/workloads/isolated/worker.mjs",
  "bench/workloads/json-check.mjs",
  "bench/workloads/latest-stable.mjs",
  "bench/workloads/live.mjs",
  "bench/workloads/mixed.mjs",
  "bench/workloads/registry.mjs",
  "bench/workloads/run.mjs",
  "scripts/steady.mjs"
]);
// The bench package's classic compiler (bench/package.json), not the root's TypeScript.
export const typescriptPath = "bench/node_modules/typescript/lib/typescript.js";
// typescript@6.0.3, verified against bench/package-lock.json's SHA-512 npm archive.
export const typescriptSha256 = "569177652966bd528c319171c7dd22860dbf72bde116cbc4f644f1d02bb12e39";
// The measured commit's bench manifest and lock must pin exactly that archive.
export const typescriptIntegrity = "sha512-y2TvuxSZPDyQakkFRPZHKFm+KKVqIisdg9/CZwm9ftvKXLP8NRWj38/ODjNbr43SsoXqNuAisEf1GdCxqWcdBw==";
// semver@7.8.6 library closure, checked against the integrity-pinned npm archive.
// The CLI and preload entry are not validator dependencies.
export const semverIntegrity = "sha512-9lpSSU4Mly3mrtruwLs1eLK6+gzbzqeBFwRNjIjE+9LuDpWdYctrQlQ3ej1Ilgi7gknpsTRnPoLP8DpCHqHIJw==";
export const semverSources = Object.freeze({
  "node_modules/semver/classes/comparator.js": "054202956430d63d5ff4599fae09760ce465b489e4f0b5ef5ce7cc7ac21157ac",
  "node_modules/semver/classes/index.js": "3bb69280c2a788d0eb16f915bb9df4dbe812075182024c753dca2283bcea1b17",
  "node_modules/semver/classes/range.js": "301811a48b055bb62a0c49240c64cc0b701cb926b67c425758df45920ff985dc",
  "node_modules/semver/classes/semver.js": "813b2c185512d30c9b931c2fed8140889d9d7490ceeeedc370da30337dc8ca57",
  "node_modules/semver/functions/clean.js": "4eadb0892844cf3ae295121a86163a66c73f89acd1b7f0b114ec115b4539512f",
  "node_modules/semver/functions/cmp.js": "a63d74e87b73788e78e9ce0a4892b5333d6b809c0de88b31e4ed76cbf17f94b3",
  "node_modules/semver/functions/coerce.js": "28a251c5ab210ddf9e97551b9f37a53329fcce91f0c3943dcbc02de1a1de915a",
  "node_modules/semver/functions/compare-build.js": "5ab651d5b40af289bd85c645a92b6d8cfe1a986dc413c797cfcc8d623d7c844c",
  "node_modules/semver/functions/compare-loose.js": "07b6a3a1db0a5210ceb784c1708bd4679f3a94fc73a9c9eb349349e7070a6f78",
  "node_modules/semver/functions/compare.js": "d404b5aa48aaddc8a654c5da8fb7d4443404b7948589b21ac4b045d1cee4e34c",
  "node_modules/semver/functions/diff.js": "7a11fd39b987cdf06c65e928cb1aca49bec583feb86fb5c8fe47a6fd61d7de31",
  "node_modules/semver/functions/eq.js": "b6e30a7168e52723216fc163d300e2bbabf92ec0251f9ac5438bb6ccf57c8936",
  "node_modules/semver/functions/gt.js": "135523704aa48cd98834dd170ee9f74f0e68043b379f32d021db11e6304c5c93",
  "node_modules/semver/functions/gte.js": "991c5bbe48ecb210a562646872f05862ad9fc0d42186d85aa60bdc6fa323eb9d",
  "node_modules/semver/functions/inc.js": "952069fc8690b7d3af0fe9d55f7c54fe2ac067b48c5e74f6a54f9ce19a334493",
  "node_modules/semver/functions/lt.js": "1c897a9bc849320e2e9dc0f6c09555c01ee3ddf30734515d717b88ad7740ea25",
  "node_modules/semver/functions/lte.js": "3a8d0b1d00423f60cc7cb810b36ab77b61330831ad237dbe73eb5cecfa412800",
  "node_modules/semver/functions/major.js": "5c678480d882f511200fed2c16ec3847dfedb08a1d70328dc2f031d35d825276",
  "node_modules/semver/functions/minor.js": "1b051794f1713adec2a236517196691687c35f82e0b596ff3316a78b3cc10ae6",
  "node_modules/semver/functions/neq.js": "a662883751918822c162183b46b9e20d09489132f82686c92ab78bee67f3a127",
  "node_modules/semver/functions/parse.js": "29a69e15b6d02fe381d573f861881a89590e9d0f0f0ca740c5f85eaf0234c4ad",
  "node_modules/semver/functions/patch.js": "f02d3c1b059fe3d96ce124886f7eef321d381a95638fd3c4a8d5ccd8e76ffadd",
  "node_modules/semver/functions/prerelease.js": "baedbf503d5610ad041bfb56071efa48feb331ca278295c399537d35d3ffb593",
  "node_modules/semver/functions/rcompare.js": "84fa5e88adf08d15c993cac8cdec6d1a65045b7e95a9c55184230a7f807f4dc0",
  "node_modules/semver/functions/rsort.js": "6ec659ce3b6c2b173c719286caab04409adba046c0917874ec3b5e36ddfbc7e3",
  "node_modules/semver/functions/satisfies.js": "8cf5e122b757251671ed6c9d9680904b71cd375845853f05312e608cf2cc2946",
  "node_modules/semver/functions/sort.js": "c2fe2d3ed0be8a4e9de8f02abdfd5d9c0d3bcc510d88e87af84185592882c4b8",
  "node_modules/semver/functions/truncate.js": "e145833a250311927c92f424f56498c52f1b7bb1271ce6afbf006db87773ff43",
  "node_modules/semver/functions/valid.js": "0de7ea736cb7807179d46dfac09c830a9338e02b6a07db12d7040cde2def6025",
  "node_modules/semver/index.js": "4b3e57d3d40e29e0706002eba113d09f35aea593578376bbeec83b777b9912ab",
  "node_modules/semver/internal/constants.js": "8274b2f7ce15171895c43ef98c0da88aeeda1cf937bffe3c23893f159f3cddaa",
  "node_modules/semver/internal/debug.js": "8a9f420572260f3cf944463b5090d62a60f0730589dc23a7ec4ca25e2ee41bb3",
  "node_modules/semver/internal/identifiers.js": "b4916b09dc7869ae0eb05e71c855c942a3a7365f7e6e89185d59a9e45a2451d7",
  "node_modules/semver/internal/lrucache.js": "14d087c87da87b6f5c36fc4cdd7d2d14077874b14a68e20fce5b6138fa2ca34f",
  "node_modules/semver/internal/parse-options.js": "fdf51d0de8d5442c35a997ef58cd530d239ce206f961d14c5121354451b01d01",
  "node_modules/semver/internal/re.js": "5833262888e2b5d843a69193f83c05e374818dbe55379b497819b5bf58e48cd8",
  "node_modules/semver/internal/trim-comparator-whitespace.js": "828e567bc845d9d26a04f66fc442b48be3b2d8e27161733fae15325cd7ea428b",
  "node_modules/semver/ranges/gtr.js": "8fadad28e36d28e93d498ac7ac20badba2a407312845eabc18e82e90a0732b19",
  "node_modules/semver/ranges/intersects.js": "fe87ac5d3020010ad3ec00636dadbf0c669ff07d0f57e0a8165a8264f79a676f",
  "node_modules/semver/ranges/ltr.js": "e5186fcc03018acf9be6d968755d4c49727aeb0d981d179eb568ae5fbe983038",
  "node_modules/semver/ranges/max-satisfying.js": "e1a2c0d6144cc772cd20bbc8ecb9e8a3a4074e9172a3d8e794838b591cdeb416",
  "node_modules/semver/ranges/min-satisfying.js": "2681abf54098aa670f12826b76a6ec77a2441186ae4243afde3be8ae4908f7ca",
  "node_modules/semver/ranges/min-version.js": "fefba0a88c2bf74d5cede504b5ae50a8dc3edfd69cf0174a491e2cf3e442614b",
  "node_modules/semver/ranges/outside.js": "3a2b0b23593d2f49419c06af2af75450cab103b0c25d665d48fe5bca495a21ca",
  "node_modules/semver/ranges/simplify.js": "7b78581c13322bc68ece2088685386b2a9b51c15b94d0a2063bdf2546bd41934",
  "node_modules/semver/ranges/subset.js": "ceb9eb6ed5bfc6c7ac7af7f47e5c3535444a4e66a0e2b58cdad4bd02a35d454d",
  "node_modules/semver/ranges/to-comparators.js": "6c5e966210cff270fa2850668aaf8460fac7759f8d99f282521ef7a78f4564e9",
  "node_modules/semver/ranges/valid.js": "5ef6f995af801868925940cf8df5735d565ebabb090b068695cae65218bcd3ac",
});
const checkout = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), "../.."));
const entryPath = "bench/workloads/cloud-validation-worker.mjs";
const hash = (source) => createHash("sha256").update(source).digest("hex");
export const validationFailure = () => new Error("native campaign validation unavailable or invalid; evidence/host preserved");
const text = (bytes) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
const gitEnvironment = () => ({ ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0" });
const headFailure = (reason) => new Error(`Git HEAD validation failed: ${reason}`);
function head(root, readGit = spawnSync) {
  let result;
  try {
    result = readGit("git", ["--no-replace-objects", "-C", root, "rev-parse", "--verify", "HEAD^{commit}"], {
      encoding: "utf8", timeout: 5000, maxBuffer: 1024, windowsHide: true, shell: false,
      env: gitEnvironment(),
    });
  } catch { throw headFailure("process error"); }
  if (result.error) throw headFailure(result.error.code === "ETIMEDOUT" ? "timed out" : "process error");
  if (result.status !== 0) throw headFailure("unsuccessful exit");
  if (!/^[a-f0-9]{40}\s*$/.test(result.stdout ?? "")) throw headFailure("malformed output");
  return result.stdout.trim();
}
// Evidence may name a source identity, never select executable code. Default
// replay accepts only this installed controller's commit, captured on import.
// Only this import exposes the fixed HEAD diagnostic; captureValidation masks it.
const installedCommit = head(checkout);

// Root metadata pins semver; the bench package's pins the classic compiler.
const packageMetadata = ["package.json", "package-lock.json", "bench/package.json", "bench/package-lock.json"];
function pinnedPackage(manifest, lock, name, version, integrity) {
  assert.equal(manifest.devDependencies[name], version);
  assert.equal(lock.packages[""].devDependencies[name], version);
  const pinned = lock.packages[`node_modules/${name}`];
  assert.equal(pinned.version, version); assert.equal(pinned.integrity, integrity);
  assert.equal(pinned.resolved, `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`);
  assert.equal(Object.keys(pinned.dependencies ?? {}).length, 0);
}

function dependency(root, path, sha256, limit) {
  const fd = openSync(realpathSync(join(root, path)), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  let bytes;
  try {
    const stat = fstatSync(fd);
    assert.ok(stat.isFile() && stat.nlink === 1 && stat.size <= limit);
    bytes = readFileSync(fd); assert.equal(bytes.length, stat.size);
  } finally { closeSync(fd); }
  assert.equal(hash(bytes), sha256);
  return { path, source: text(bytes), sha256 };
}

// Collection and fleet verification replay with this checkout's own bench compiler,
// which only `npm --prefix bench ci` installs here; a host's install is not the
// operator's. Preflights report this fixed hint, never an evidence-derived detail.
export const localCompilerMissing = "local bench install missing or differs: run npm --prefix bench ci";
export function localCompiler(root = checkout) {
  try { dependency(realpathSync(root), typescriptPath, typescriptSha256, 16 * 1024 * 1024); return true; }
  catch { return false; }
}

// Reading immutable Git objects, not checkout files, binds the entire executable
// closure to the already-approved measured commit, including nested worker entry.
// One process, bounded time/output, no fetch, filters, hooks or working-tree writes.
// root/readGit are trusted local test seams, never options read from evidence.
export function captureValidation(commit, { root = checkout, readGit = spawnSync } = {}) {
  try {
    assert.match(commit, /^[a-f0-9]{40}$/);
    root = realpathSync(root);
    assert.equal(commit, root === checkout ? installedCommit : head(root, readGit));
    const paths = [...validationPaths, ...packageMetadata];
    const result = readGit("git", ["--no-replace-objects", "-C", root, "cat-file", "--batch"], {
      input: paths.map((path) => `${commit}:${path}\n`).join(""),
      encoding: null, timeout: 5000, maxBuffer: 32 * 1024 * 1024,
      windowsHide: true, shell: false,
      env: gitEnvironment(),
    });
    assert.equal(result.status, 0); assert.ok(!result.error);
    let offset = 0;
    const objects = paths.map((path) => {
      const end = result.stdout.indexOf(10, offset);
      assert.ok(end >= offset);
      const header = result.stdout.subarray(offset, end).toString("ascii");
      assert.match(header, /^[a-f0-9]{40} blob [0-9]+$/);
      const size = Number(header.split(" ")[2]);
      assert.ok(Number.isSafeInteger(size) && size > 0 && size <= 1024 * 1024);
      const bytes = result.stdout.subarray(end + 1, end + 1 + size);
      assert.equal(bytes.length, size); assert.equal(result.stdout[end + 1 + size], 10);
      assert.equal(createHash("sha1").update(`blob ${size}\0`).update(bytes).digest("hex"), header.split(" ")[0]);
      offset = end + size + 2;
      return { path, source: text(bytes), sha256: hash(bytes) };
    });
    assert.equal(offset, result.stdout.length);
    const [manifest, lock, benchManifest, benchLock] = objects.slice(-packageMetadata.length).map((row) => JSON.parse(row.source));
    pinnedPackage(manifest, lock, "semver", "7.8.6", semverIntegrity);
    pinnedPackage(benchManifest, benchLock, "typescript", "6.0.3", typescriptIntegrity);
    // Metadata comes from the measured commit; executable dependencies come
    // from pinned same-read bytes, never a package resolver or mutable manifest.
    const sources = objects.slice(0, -packageMetadata.length);
    sources.push(dependency(root, typescriptPath, typescriptSha256, 16 * 1024 * 1024));
    for (const [path, sha256] of Object.entries(semverSources)) sources.push(dependency(root, path, sha256, 64 * 1024));
    return { root: pathToFileURL(root + "/").href, sources };
  } catch { throw validationFailure(); }
}

// Caller-only seam for synthetic controls. Neither JSON input nor CLI arguments
// can supply a snapshot, worker implementation, module, command or package.
export function validationTask(input, { snapshot = captureValidation(input.commit), WorkerClass = Worker } = {}) {
  try {
    assert.deepEqual(Object.keys(input).sort(), input.action === "actor-role-preflight"
      ? ["action", "commit", "group", "mode", "round"] : ["commit", "folder", "round"]);
    assert.match(input.commit, /^[a-f0-9]{40}$/);
    const { sources, root } = snapshot;
    assert.deepEqual(sources.map((row) => row.path), [...validationPaths, typescriptPath, ...Object.keys(semverSources)]);
    const base = new URL(root);
    assert.equal(base.protocol, "file:"); assert.ok(base.href.endsWith("/"));
    for (const row of sources) {
      assert.deepEqual(Object.keys(row).sort(), ["path", "sha256", "source"]);
      assert.equal(hash(row.source), row.sha256);
    }
    assert.equal(sources.find((row) => row.path === typescriptPath).sha256, typescriptSha256);
    for (const [path, sha256] of Object.entries(semverSources)) assert.equal(sources.find((row) => row.path === path).sha256, sha256);
    const entry = sources.find((row) => row.path === entryPath);
    const worker = new WorkerClass(new URL("data:text/javascript;base64," + Buffer.from(entry.source).toString("base64")), {
      workerData: { input, root, sources }, stdout: true, stderr: true, execArgv: [],
      env: { ...gitEnvironment(), NODE_OPTIONS: "", NODE_PATH: "" },
    });
    worker.stdout.resume(); worker.stderr.resume();
    const stop = () => { try { void worker.terminate().catch(() => {}); } catch {} };
    const result = new Promise((resolve, reject) => {
      let message, failed = false;
      worker.once("message", (value) => { message = value; stop(); });
      worker.once("error", () => { failed = true; });
      worker.once("exit", () => {
        if (!failed && message?.ok === true) resolve(message.report);
        else reject(validationFailure());
      });
    });
    return { result, stop, unref: () => worker.unref() };
  } catch { throw validationFailure(); }
}
