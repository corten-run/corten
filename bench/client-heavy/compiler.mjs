import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, resolve, sep, isAbsolute, posix, win32 } from "node:path";

export const solidCompilerVersion = "2.0.2";
const compilerPackage = "@solidjs/compiler";
const entry = `${compilerPackage}/index.js`;
const entrySha256 = "5322fd7863ab1e4805583f912b7092d949f5a93ed66bdb974ec803bea9582c7d";
// SHA-256 of package.json extracted from the integrity-verified npm archives.
// esbuild doesn't include these resolution and tree-shaking inputs in its metafile.
const manifests = {
  "solid-js/package.json": "ee6f273347dc03c8c123466f95ebef5d2209de03cd37ec04a6c750dd7e257007",
  "@solidjs/web/package.json": "200868dcac3e780cea1217ab01d9021ce2770243e5fc00ac7b33f42814bb6314",
  "@solidjs/signals/package.json": "4afcd48f070580c22095c8eb03f3540e039e56aed71f1648afd6053483cf0bf9",
  [`${compilerPackage}/package.json`]: "6f8dff50c2941aed6a68191b3e2e5dd2ee345b5d51cd6e0c302851090f65f1e4",
  "@solidjs/compiler-darwin-arm64/package.json": "65312dd639df1ff03b168cb1e3058ebf88b50ca4a4744aae5ab74db4c0a87e64",
  "@solidjs/compiler-darwin-x64/package.json": "801baa283e897637c2c85ee5bd8307f36762dea7d1dcbb55030d1ef19a429307",
  "@solidjs/compiler-linux-arm64-gnu/package.json": "7949973e8e010a18edf548c4485311fc1612209566d348515ddb86d7ef959989",
  "@solidjs/compiler-linux-x64-gnu/package.json": "ee341240aa19c93f449859fcacb880724d1531b4f51652939b5739cabb462045",
  "@solidjs/compiler-win32-x64-msvc/package.json": "33a45798d96500b10c44de8ccdbbfc54cc03bbae8f1727e0da5b430b70197926",
};
// Archive SRI (base64 SHA-512) and unpacked addon SHA-256.
const bindings = {
  "darwin-arm64": ["ctgEtzj0R5JDUiyo1wNcSgAyjO2XqNXvyPx6UolK1WK6qStR5KIHz3uIIG68aKrFhnOLTUiwS3hjd4yZWolBpA==", "4ff25630c753554a1f300d3d9ae04f607d15711e9c66e130939aaabe670e3b28"],
  "darwin-x64": ["iTcLdvzEFF3jfDwnmdpax4q1eVd6Jth0u59BzA++p345feNXFSJvzS/bGE5UrGMe9NsLFFV1IEHkZyEpbSOovw==", "70906741f3cf7d389a92ea411bdbd30ee9faa9a3e72e7d4f3fdc6508d1e0cdfe"],
  "linux-arm64-gnu": ["DBdg24ud/Eu/+Ns9jgwy0AmyyExhoXn5R14VBkGX9w5lxiI3k/eG21im+hsUkqdwt/Ej0CazauifTdGaEceUzw==", "b2f1907a1fc4fd190b6649c4914b3638a8a52227ff95f22e2aa199fb9019b95e"],
  "linux-x64-gnu": ["tRbkqVgJH7rOghIFe9j3MRvosx8ueNsGIDAd+XIUQbexhbM7KMCOJnWLmL7J/9PMPmbk34zJYz0fwwFSBp8ULQ==", "4903e9e0f6701cfed6c3fc371fd57ee1c21bd1c2764d7dc81c9d060fe10eaf35"],
  "win32-x64-msvc": ["5q6RRWRI9y685wzBcteezVifcVz/di9hCEKqruZrBo60qbne13Orl6FOwP8LK4Exls+Ws98UNvznFuz0NhLQTg==", "63136c12a13f2af80e49295d2b72d174b63e8478ae51a2849466710496a46c84"],
};
export const solidCompilerArchives = Object.freeze(Object.fromEntries(Object.entries(bindings)
  .map(([target, [integrity]]) => {
    // Confirmed against the unpacked manifests: only the GNU bindings have libc.
    const [os, cpu, abi] = target.split("-");
    return [`${compilerPackage}-${target}`, { integrity: `sha512-${integrity}`,
      os: [os], cpu: [cpu], ...(abi === "gnu" ? { libc: ["glibc"] } : {}) }];
  })));
// The dedicated adapter's esbuild production input inventory, hashed from the
// verified npm archives of solid-js, @solidjs/web and @solidjs/signals (2.0.3).
export const solidRuntimeFiles = Object.freeze({
  "@solidjs/signals/dist/prod/affects-marks.js": "4ee8c0b65924fc6dd763604cb9a3d605cd29209a44872c18254251975802cf77",
  "@solidjs/signals/dist/prod/affects.js": "f09b02cebab84af0639bc0dc9764b1e1a9a488f7aeae5feb81c70e0a40324808",
  "@solidjs/signals/dist/prod/boundaries.js": "666db709edf8c965a3e94ea89279ed3184a93d2296a624c5a8fcc5cac7a33758",
  "@solidjs/signals/dist/prod/core/action.js": "5fc17e6365cf6df9ded4182bed89c4b657190a6233c4cb676eb941542b8ba208",
  "@solidjs/signals/dist/prod/core/async.js": "4098ab800e3b13429e28f12077558d9591ff26c793a5972c84019752d42cd1b7",
  "@solidjs/signals/dist/prod/core/attribution-hooks.js": "4cd5ff261587479501967d9e51edfb3fb975973a581a5905b46ab3d9f0dd1149",
  "@solidjs/signals/dist/prod/core/constants.js": "28424557e81e46511fb5896808bafdc84ff5d7ffa6cd99a37b1082f78fa6af91",
  "@solidjs/signals/dist/prod/core/context.js": "966b4f6f56b294d0f22ed9893f935934600ebd749122e9696b8b01de0279b988",
  "@solidjs/signals/dist/prod/core/copies.js": "4d661dc0a656d3a716f16517187ef920806381dd6fb4644af5835ead8e7a8829",
  "@solidjs/signals/dist/prod/core/core.js": "9fb276d3f4c31fd72aea9540c37f3c2ba35393a7b721349cc581aea802c348ba",
  "@solidjs/signals/dist/prod/core/dev.js": "0bb6aaaafa1575988b9d35772ba5fd9c21bf19fb86f3c52d4d2b8f533a4d3dc3",
  "@solidjs/signals/dist/prod/core/effect.js": "10c0e9f19da94ad10ec9cc1f21a60150a3b56e8e92969f7561776a8d3e409456",
  "@solidjs/signals/dist/prod/core/error-hooks.js": "a75d38035570fc4f6e95dcb936f65aae5611e99b8c6b4cb5ae508af850e7b238",
  "@solidjs/signals/dist/prod/core/error.js": "ca7862a93512664562cc5995f3a52b221e66067c7d8b720fac8ff4405b266f44",
  "@solidjs/signals/dist/prod/core/external.js": "9a319ccc828ed81d0b8a85292abeaa6f561297c050612a673d9fb9e958ca985a",
  "@solidjs/signals/dist/prod/core/graph.js": "f9dd770967c7cc76c57a71dc7e9c6dc52e2d4b1d64c75d39b9189147d1c7c890",
  "@solidjs/signals/dist/prod/core/guesses.js": "d6c019dca163825c9f40921996a1ced17f59290132c4eeaab72b9a40dd4ba2b3",
  "@solidjs/signals/dist/prod/core/heap.js": "bd58398eafa5ec737bbf0abe46ade55c8aec7b0af8c34e44999bb6411070d628",
  "@solidjs/signals/dist/prod/core/identities.js": "9aa009af39ebcb038203bf37b55235a84f3160eb1312c04501c45ec161eae7b6",
  "@solidjs/signals/dist/prod/core/invariants.js": "7bdaa332c1eee52cd5c8a7f3f7f9e19bfcb99673af176ed38923adc6c85c53dd",
  "@solidjs/signals/dist/prod/core/lanes.js": "872d4e794e6f5de448d451a3d4941ec621b9202786013bbe6d22c776b8b681d7",
  "@solidjs/signals/dist/prod/core/owner.js": "472ee9da117fa936a62d644ad11c447b83c3a1d815522f7351db46ff095bbdf1",
  "@solidjs/signals/dist/prod/core/scheduler.js": "7d527697d2f24c517c0b1d170a764b38b9ab8b2e748946f91287d6d69fe30552",
  "@solidjs/signals/dist/prod/core/truth.js": "639c466d6145a39c0563f6a89a7ba8bab43046642e3e483ded89e017717572f4",
  "@solidjs/signals/dist/prod/core/verdict.js": "4b6d5d0fcf9dd2b3bf0589b10f6c22c12594fd530ea684e904de1e6c73078d83",
  "@solidjs/signals/dist/prod/deferred.js": "7b1ea9a70e232121b48576697a44d3559d0160f118347ce5a64f1c36d303f363",
  "@solidjs/signals/dist/prod/flatten.js": "906a0a68ebb9fe3dac2275fe150e65d24bf6f8b8a08442652a1589626cf7b5fc",
  "@solidjs/signals/dist/prod/from.js": "0f2cd7d9ee2ba779d09c6f0447e0378cbb5ba8dc85d9d677bdb5a2d90cdb3e4e",
  "@solidjs/signals/dist/prod/index.js": "71fabd6fde4b6d0cbdbb270f8404d02275c78eb84ee1f25e847d10255526eaa3",
  "@solidjs/signals/dist/prod/map.js": "61ea410f7ca02361dc16a84e7213cfe79ce3e72b4afeb38daa50e3c453bb7692",
  "@solidjs/signals/dist/prod/reveal.js": "25877cb8397de93c3ce3302db7cd44bc572970529c8eb2549e6f1ba9144786f1",
  "@solidjs/signals/dist/prod/signals.js": "6d295a888c52041163af9807ee4259984aff1cecc0dd5dc18cb5bb98a319645b",
  "@solidjs/signals/dist/prod/store/affects.js": "59d3b03ebc0a27eaf92c2895a37e233d93e36f18695ddc07aa62f79e859f2e24",
  "@solidjs/signals/dist/prod/store/edges.js": "2e7631292bc1202b228d59eeab72b6dd70db8b5e5ad87cc4f6027df0a2251abe",
  "@solidjs/signals/dist/prod/store/hooks.js": "f3785a1bb572aaa574a5b2d5da3af693a4ad2c7fde311e62d8f723861c2fd029",
  "@solidjs/signals/dist/prod/store/index.js": "105a8f1fb83853560f5f5d171f437faa49c7f671fcaea37715ea15d2a5bb8754",
  "@solidjs/signals/dist/prod/store/optimistic.js": "e208486b526965d903f0557e95814753467447a4162e22088a40845542fc4c0e",
  "@solidjs/signals/dist/prod/store/projection.js": "2666d3fddc9c6f546e5126aee8b9b6c7000d9701ce8127c88a19d7bdfe49dc1f",
  "@solidjs/signals/dist/prod/store/reconcile.js": "e284cb32385a6381a2736fc7286a8460c895f61fd7ab7851b422f3737f6272b6",
  "@solidjs/signals/dist/prod/store/store.js": "15c7ced616ace579e7d07e87a5d1ffa42faecbaf5511ef4b1c33698f55297dd6",
  "@solidjs/signals/dist/prod/store/storePath.js": "f192c128b981602139ebfc8c0ec6bdd1e82ba52edfa0fbfb82f38dcafc56e597",
  "@solidjs/signals/dist/prod/store/target.js": "a23d05e3864bb954044abc343293e981b984c6fe8f5e19e1f97314a196737c3f",
  "@solidjs/signals/dist/prod/store/types.js": "5dd4904e3768ecb88ec38e0be19fc1fddaa3cee10c2f26b7f1f96d05e2c00cf2",
  "@solidjs/signals/dist/prod/store/utils.js": "555ff19a2909c3f36b14d1d3e13eb9564c572db0a825571ed3ab688d115fb477",
  "@solidjs/web/dist/web.js": "27af0627f915a0e0e1bed7aca90a0ab6d750ba78824419e34509021f7eb98dca",
  "solid-js/dist/internal.js": "8814561b49fc1d19207a74b0a04059da0aea02a731b3dbd5c6dcf9b810cfab2a",
  "solid-js/dist/solid.js": "fcd146daf705027d03924cdd55cb9039d57a1c1f83d1609b655f4d2cd03f5ddb",
});
export const solidRuntimePrefix = "bench/browser/node_modules/";
export function matchesSolidRuntime(inputs) {
  const runtime = [...inputs].filter(([path]) => path !== "bench/client-heavy/apps/solid.jsx"
    && path !== "bench/client-heavy/apps/input.js");
  return runtime.length === Object.keys(solidRuntimeFiles).length && runtime.every(([path, ref]) =>
    path.startsWith(solidRuntimePrefix) && Object.hasOwn(solidRuntimeFiles, path.slice(solidRuntimePrefix.length))
    && solidRuntimeFiles[path.slice(solidRuntimePrefix.length)] === ref.sha256);
}
export function solidCompilerFiles(target, platform) {
  assert.ok(Object.hasOwn(bindings, target) && target.startsWith(platform + "-"), "unreviewed-solid-compiler-target");
  return { [entry]: entrySha256, [`${compilerPackage}-${target}/compiler.${target}.node`]: bindings[target][1] };
}
export function solidManifestFiles(target) {
  const roots = ["solid-js", "@solidjs/web", "@solidjs/signals", compilerPackage, `${compilerPackage}-${target}`];
  const files = Object.fromEntries(roots.map((name) => {
    const path = `${name}/package.json`;
    assert.ok(Object.hasOwn(manifests, path), "unreviewed-solid-package-manifest");
    return [path, manifests[path]];
  }));
  // The archives have no nested manifests along these module paths. A nearer
  // package.json can override sideEffects without changing any metafile input.
  for (const file of Object.keys(solidRuntimeFiles)) {
    for (let dir = posix.dirname(file); !Object.hasOwn(manifests, `${dir}/package.json`); dir = posix.dirname(dir)) {
      assert.notEqual(dir, ".", "unreviewed-solid-runtime-package");
      files[`${dir}/package.json`] = null;
    }
  }
  return files;
}

export function verifySolidFiles(files, hashFor) {
  for (const [path, expected] of Object.entries(files)) {
    const problem = expected === null ? "unpublished Solid 2 manifest" : "missing or modified Solid 2 input";
    assert.equal(hashFor(path), expected, `${problem} ${path}; run npm --prefix bench/browser ci`);
  }
}

export function solidCompiler(browserPackage) {
  const { platform, arch, env } = process;
  assert.ok(!env.SOLID_COMPILER_NATIVE && !env.NAPI_RS_FORCE_WASI, "Solid compiler overrides are not supported");
  const target = platform + "-" + arch + (platform === "linux" ? "-gnu" : platform === "win32" ? "-msvc" : "");
  const files = solidCompilerFiles(target, platform);
  const modules = join(dirname(browserPackage), "node_modules");
  const fullEntry = join(modules, entry), binding = Object.keys(files)[1], fullBinding = join(modules, binding);
  verifySolidFiles({ ...solidManifestFiles(target), ...files }, (path) => {
    const absolute = join(modules, path);
    return existsSync(absolute) ? createHash("sha256").update(readFileSync(absolute)).digest("hex") : null;
  });
  const require = createRequire(browserPackage), fromCompiler = createRequire(fullEntry);
  assert.equal(require.resolve("@solidjs/compiler"), fullEntry, "Solid compiler escaped bench/browser install");
  assert.equal(fromCompiler.resolve(`@solidjs/compiler-${target}`), fullBinding, "Solid compiler binding escaped bench/browser install");
  for (const local of ["compiler.node", `compiler.${target}.node`])
    assert.ok(!existsSync(join(dirname(fullEntry), local)), "unreviewed local Solid compiler binding");
  // Preload the verified native addon: the public wrapper must not fall back to WASI.
  fromCompiler(fullBinding);
  const { transform } = require(fullEntry);
  return { target, files, transform(source, filename) {
    return transform(source, { filename, generate: "dom", moduleName: "@solidjs/web" }).code;
  } };
}

const compilerTargetId = "CORTEN_ISOLATED_COMPILER_TARGET_ID";
function directoryId(stat) {
  assert.ok(stat.isDirectory(), "compiler target is not a physical directory");
  return `${stat.dev}:${stat.ino}`;
}

/** Exclusive scratch ownership; a held descriptor prevents inode reuse. */
export function reserveCompilerTarget(target) {
  const parent = realpathSync(dirname(target));
  const staging = mkdtempSync(join(parent, ".compiler-owner-")), staged = join(staging, basename(target));
  const currentId = (path = target) => directoryId(lstatSync(path, { bigint: true }));
  const exists = (path) => !!lstatSync(path, { throwIfNoEntry: false });
  let identity, fd;
  try {
    mkdirSync(staged, { mode: 0o700 });
    fd = openSync(staged, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
    identity = directoryId(fstatSync(fd, { bigint: true }));
    // Pin before publication. POSIX rename can replace an existing empty
    // directory; mv -n into its fixed parent leaves that name untouched.
    if (process.platform === "win32") {
      assert.ok(!exists(target), "compiler target already exists");
      renameSync(staged, target); // Windows refuses to replace a directory.
    } else {
      try { execFileSync("/bin/mv", ["-n", staged, parent], { stdio: "ignore", timeout: 5000 }); }
      catch (error) {
        // Some mv -n versions exit 1 rather than 0 on a skipped destination.
        if (error.status === 1 && !error.code && !error.signal && exists(staged) && exists(target))
          throw new Error("compiler target already exists", { cause: error });
        throw error;
      }
      assert.ok(!exists(staged), "compiler target already exists");
    }
    assert.equal(currentId(), identity, "compiler target replaced during reservation");
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (exists(staged)) rmdirSync(staged);
    rmdirSync(staging); throw error;
  }
  return {
    env: { [compilerTargetId]: identity },
    async close(remove) {
      try {
        if (remove) {
          assert.equal(realpathSync(dirname(target)), parent, "compiler target parent changed");
          assert.equal(currentId(), identity, "compiler target replaced before cleanup");
          // Never recursively remove a directory at the public build path. Move
          // it into a private sibling and recheck the pinned inode there first.
          renameSync(target, staged);
          assert.equal(currentId(staged), identity, "compiler target replaced during cleanup");
          await rm(staged, { recursive: true });
        }
      } finally {
        closeSync(fd);
        if (!exists(staged)) rmdirSync(staging);
      }
    },
  };
}

export async function withCompilerTarget(target, build) {
  const delegated = process.env[compilerTargetId];
  if (delegated !== undefined) {
    assert.equal(directoryId(lstatSync(target, { bigint: true })), delegated, "compiler target differs from campaign reservation");
    assert.equal(readdirSync(target).length, 0, "campaign compiler target is not fresh");
    return build();
  }
  const owned = reserveCompilerTarget(target);
  try { return await build(); } finally { await owned.close(true); }
}

export function compilerSourcePath(root, input, workingDirectory = root) {
  const api = /^[A-Za-z]:\//.test(root) ? win32 : posix;
  const rel = api.relative(root, api.resolve(workingDirectory, input)).replaceAll("\\", "/");
  assert.ok(rel && rel !== ".." && !rel.startsWith("../") && !api.isAbsolute(rel), "escaped-rust-compiler-input");
  return rel;
}

export function compilerWorkingDirectory(metadata) {
  const manifest = metadata.packages.find((p) => p.id === metadata.resolve?.root)?.manifest_path?.replaceAll("\\", "/");
  assert.ok(manifest?.endsWith("/Cargo.toml"), "missing-rust-generator-package");
  return manifest.slice(0, -"/Cargo.toml".length);
}

export function cargoMetadata(stdout) {
  // Cargo writes one JSON object. A Cargo-compatible launcher may surround it
  // with non-JSON queue/status lines; keep all raw bytes in the tool receipt.
  const objects = stdout.toString().split(/\r?\n/).filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
  assert.ok(objects.length === 1 && objects[0].version === 1 && Array.isArray(objects[0].packages), "invalid-cargo-metadata-output");
  return objects[0];
}

// Rust's textual dep-info uses Make escaping, including continuations and spaces.
// Retain the original bytes too; env-dep comments are observations, not commands.
export function depInputs(text) {
  const inputs = new Set();
  for (const line of text.replace(/\\\r?\n/g, "").split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const colon = line.search(/:\s/);
    assert.ok(colon >= 0 || line.endsWith(":"), "invalid-rust-dep-info");
    if (colon < 0) continue;
    const rhs = line.slice(colon + 1), words = [];
    let word = "", escaped = false;
    for (const char of rhs) {
      if (escaped) { word += char; escaped = false; }
      else if (char === "\\") escaped = true;
      else if (/\s/.test(char)) { if (word) words.push(word); word = ""; }
      else word += char;
    }
    assert.ok(!escaped, "invalid-rust-dep-info");
    if (word) words.push(word);
    words.forEach((word) => inputs.add(word.replaceAll("$$", "$")));
  }
  return [...inputs].sort();
}

export async function collectCompiler(evidence, target, metadata, stdout) {
  const value = { schema: "client-heavy-compiler-inputs/v1", metadata, toolchain: null, artifacts: [], depfiles: [], inputs: [], unavailable: [] };
  try {
    value.toolchain = await evidence.blob(await readFile(join(target, ".rustc_info.json")));
    const meta = cargoMetadata(metadata.stdout), messages = stdout.toString().split(/\r?\n/).filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line));
    value.artifacts = messages.filter((m) => m.reason === "compiler-artifact");
    assert.ok(value.artifacts.length > 0, "missing-rust-compiler-artifacts");
    const manifest = meta.packages.find((p) => p.name === "corten-run")?.manifest_path.replaceAll("\\", "/");
    assert.ok(manifest?.endsWith("/crates/corten/Cargo.toml"), "missing-rust-source-root");
    const compilerRoot = manifest.slice(0, -"/crates/corten/Cargo.toml".length);
    value.compilerRoot = compilerRoot;
    const paths = new Set();
    let count = 0;
    const walk = async (directory) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        assert.ok(++count <= 40000 && !entry.isSymbolicLink(), "compiler-tree-limit-or-link");
        const file = join(directory, entry.name);
        if (entry.isDirectory()) await walk(file);
        else if (entry.name.endsWith(".d")) {
          const bytes = await readFile(file), inputs = depInputs(bytes.toString());
          value.depfiles.push({ path: relative(target, file).replaceAll("\\", "/"), ...await evidence.blob(bytes), inputs });
          inputs.forEach((path) => paths.add(path));
        }
      }
    };
    await walk(target);
    assert.ok(value.depfiles.length > 0, "missing-rust-dep-info");
    for (const path of [...paths].sort()) {
      const normalized = path.replaceAll("\\", "/");
      const sourcePath = compilerSourcePath(compilerRoot, normalized, compilerWorkingDirectory(meta));
      const local = resolve(evidence.root, sourcePath), rel = relative(evidence.root, local);
      assert.ok(!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`), "escaped-rust-compiler-input");
      value.inputs.push({ path, sourcePath, ...await evidence.file(evidence.root, rel) });
    }
  } catch (error) { value.unavailable.push({ name: error.name }); evidence.blockers.push("compiler-input-closure-incomplete"); }
  // stdout is retained in cargo-run.json, metadata's actual bytes in cargo-metadata.json.
  value.metadata = "evidence/cargo-metadata.json";
  await evidence.save("evidence/compiler-inputs.json", value);
  return value;
}
