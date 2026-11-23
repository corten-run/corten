import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { reservation } from "./cloud-contract.mjs";
import { remoteFiles } from "./cloud-remote.mjs";

const state = reservation({ round: "r21", commit: "a".repeat(40), token: "0123456789abcdef" });
const stage = (script) => {
  const start = script.indexOf("bootstrap_stage=git-install\n"), end = script.indexOf("bootstrap_stage=docker-install\n", start);
  assert.ok(start >= 0 && end > start);
  return script.slice(start, end);
};

test("only the new reservation uses the byte-identical CI Git verifier before checkout", () => {
  const marked = remoteFiles({ ...state, gitSource: true }), legacy = remoteFiles(state);
  const next = marked["job.sh"], original = legacy["job.sh"];
  const verifier = /<<'CORTEN_GIT_VERIFY'\n([\s\S]+?)\nCORTEN_GIT_VERIFY\n/.exec(stage(next));
  assert.ok(verifier, "marked job did not embed the Git release verifier");
  const canonical = readFileSync(new URL("../../scripts/benchmark-evidence-git.sh", import.meta.url), "utf8").replaceAll("\r\n", "\n");
  assert.equal(verifier[1] + "\n", canonical);
  assert.doesNotMatch(next, /launchpad|git-ppa|apt-get[^\n]+install[^\n]+\bgit\s*$/m);
  assert.match(original, /ppa\.launchpadcontent\.net/);
  for (const file of ["pack.sh", state.unit]) assert.equal(marked[file], legacy[file]);
  const afterInstall = (script) => script.slice(script.indexOf("bootstrap_stage=docker-install\n"));
  assert.equal(afterInstall(next), afterInstall(original), "post-Git workload setup must not change");
  assert.ok(next.indexOf("bootstrap_stage=git-install") < next.indexOf("bootstrap_stage=source-checkout"));
  for (const gitSource of [false, null, "true", 1]) assert.throws(() => remoteFiles({ ...state, gitSource }), /Git source marker/);
});

const fingerprint = "E1F036B1FEE7221FC778ECEFB0B5E88696AFE6CB 96E07AF25771955980DAD10020D04E5A713660A7";
const digest = "f0b0bf89264b9bd2e1c640363e7529643989da76281600473c50745cd34a607f";
const binaries = {
  "apt-get": 'printf "apt %s\n" "$*" >> "$ROOT/calls"; test "$SCENARIO" != apt',
  curl: String.raw`url=
while test "$1" != -o; do
  case "$1" in https://*) url=$1 ;; esac
  shift
done
printf 'download %s\n' "$url" >> "$ROOT/calls"
test "$SCENARIO" != download
printf substitute > "$2"`,
  gpg: 'test "$*" = "--batch --dearmor -o release-key.gpg release-key.asc"; touch release-key.gpg',
  xz: 'test "$*" = "-dc git.tar.xz"; cat git.tar.xz',
  gpgv: String.raw`test "$*" = "--status-fd 1 --keyring $PWD/release-key.gpg git.tar.sign git.tar"
printf 'signature\n' >> "$ROOT/calls"
printf '[GNUPG:] VALIDSIG %s ... %s\n' "$SIGNING" "$PRIMARY"
test "$SCENARIO" != signature`,
  tar: String.raw`if test "$1" = --format=gnu; then exec /usr/bin/tar "$@"; fi
test "$*" = "-xf git.tar"
test -s signer
printf 'extract\n' >> "$ROOT/calls"
mkdir git-2.56.1`,
  make: String.raw`test "$*" = "-C git-2.56.1 -j2 prefix=$ROOT/usr/local INSTALL_STRIP=-s INSTALL_SYMLINKS=1 NO_RUST=1 NO_GETTEXT=1 NO_TCLTK=1 NO_GITWEB=1 USE_LIBPCRE2=1 install"
printf 'build\n' >> "$ROOT/calls"
if test "$SCENARIO" = SIGKILL; then
  trap '' TERM
  printf 'ignoring TERM\n' >> "$ROOT/calls"
  exec /bin/sleep 6
fi
test "$SCENARIO" != build
mkdir -p "$ROOT/usr/local/bin" "$ROOT/git-core"
install -m 755 "$ROOT/git-fixture" "$ROOT/usr/local/bin/git"
install -m 755 /dev/null "$ROOT/git-core/git-remote-https"`,
  "git-fixture": String.raw`printf 'git %s\n' "$*" >> "$ROOT/calls"
case "$*" in
  --exec-path) printf '%s\n' "$ROOT/git-core" ;;
  '--no-replace-objects --no-lazy-fetch --version')
    if test "$SCENARIO" = version; then echo 'git version distro'; else echo 'git version 2.56.1'; fi ;;
  'init -q source') mkdir source ;;
  '-C source rev-parse HEAD:blob') echo original ;;
  '--no-replace-objects --no-lazy-fetch -C replay cat-file blob original')
    if test "$SCENARIO" = lazy || test -f fetched; then echo evidence; else exit 1; fi ;;
  '--no-replace-objects -C replay cat-file blob original') touch fetched; echo evidence ;;
  '-C source hash-object -w --stdin') cat >/dev/null; echo replacement ;;
  '-C source cat-file blob original') echo replaced ;;
  '--no-replace-objects -C source cat-file blob original')
    if test "$SCENARIO" = replace; then echo replaced; else echo evidence; fi ;;
esac`,
};

for (const scenario of ["accepted", "apt", "download", "digest", "signature", "signing key", "build", "SIGKILL", "version", "lazy", "replace"])
  test("generated guest Git install: " + scenario, { skip: process.platform !== "linux" }, (t) => {
    const root = mkdtempSync(join(tmpdir(), "corten-guest-git-")), shims = join(root, "bin");
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(shims);
    const probe = join(shims, "fixture-probe");
    writeFileSync(probe, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const executable = spawnSync(probe, [], { timeout: 5000 });
    assert.equal(executable.error, undefined, "fixture shims must execute; never fall back to system provisioning commands");
    assert.equal(executable.status, 0);
    for (const [name, body] of Object.entries(binaries)) writeFileSync(join(name === "git-fixture" ? root : shims, name),
      `#!/bin/sh\nset -eu\n${body}\n`, { mode: 0o700 });
    // Use the real hash checker for the substituted archive; for later
    // boundaries drive the pinned verifier's fixed checksum/signature inputs.
    if (scenario !== "digest") writeFileSync(join(shims, "sha256sum"),
      `#!/bin/sh\nset -eu\nif test "$*" = "-c -"; then\n  IFS= read -r pin; test "$pin" = '${digest}  git.tar.xz'\nelse\n  test "$*" = git.tar.xz; echo '${digest}  git.tar.xz'\nfi\n`, { mode: 0o700 });
    const { "job.sh": script, "pack.sh": pack } = remoteFiles({ ...state, gitSource: true });
    if (scenario === "accepted") {
      const syntax = spawnSync("/bin/bash", ["-n"], { input: script, encoding: "utf8", timeout: 5000 });
      assert.ifError(syntax.error); assert.equal(syntax.status, 0, syntax.stderr);
    }
    const prefix = script.slice(script.indexOf("finish()"), script.indexOf("IFS= read -r scope"));
    assert.match(prefix, /^finish\(\).*pack\.sh/m);
    assert.match(prefix, /trap .* ERR/);
    writeFileSync(join(root, "pack.sh"), pack.replaceAll("/bench", root));
    let body = stage(script).replaceAll("/bench", root).replaceAll("/usr/local", root + "/usr/local")
      .replace("export PATH=", "export PATH=" + shims + ":").replace("/tmp/corten-git-build.", root + "/corten-git-build.");
    if (scenario === "SIGKILL") {
      // Shorten only the two deadlines; GNU timeout still signals the fake make.
      assert.ok(body.includes("timeout -k 10 900 make "));
      body = body.replace("timeout -k 10 900 make ", "timeout -k 0.2 1 make ");
    }
    const result = spawnSync("/bin/bash", ["-c", 'set -Eeuo pipefail\numask 077\n: > "$ROOT/host.txt"\nexec > "$ROOT/run.log" 2>&1\n'
      + prefix.replaceAll("/bench", root) + body + 'trap - EXIT\ntouch "$ROOT/checkout-ready"\n'], {
      cwd: root, env: { PATH: shims + ":/usr/bin:/bin", HOME: root, ROOT: root, SCENARIO: scenario,
        SIGNING: scenario === "signing key" ? "OTHER" : fingerprint.split(" ")[0], PRIMARY: fingerprint.split(" ")[1] },
      timeout: 15000, maxBuffer: 65536,
    });
    assert.ifError(result.error); assert.equal(result.signal, null);
    assert.equal(readdirSync(root).some((name) => name.startsWith("corten-git-build.")), false, "private build tree was not removed");
    const log = readFileSync(join(root, "run.log"), "utf8"), calls = readFileSync(join(root, "calls"), "utf8");
    if (scenario === "accepted") {
      assert.equal(result.status, 0, log);
      assert.ok(existsSync(join(root, "checkout-ready")));
      assert.match(calls, /signature\nextract\nbuild\ngit --exec-path/);
      assert.equal(readFileSync(join(root, "host.txt"), "utf8"),
        `git version 2.56.1\ngit-source-url=https://www.kernel.org/pub/software/scm/git/git-2.56.1.tar.xz\ngit-source-sha256=${digest}\ngit-source-signer=${fingerprint}\n`);
    } else {
      if (scenario === "SIGKILL") {
        assert.equal(result.status, 137, log);
        assert.match(calls, /build\nignoring TERM\n/);
        assert.match(log, /benchmark job failed: stage=git-install line=\d+ exit=137\b/);
        assert.doesNotMatch(calls, /^git /m);
      }
      assert.notEqual(result.status, 0, log);
      assert.match(log, /benchmark job failed: stage=git-install line=\d+ exit=\d+/);
      assert.equal(existsSync(join(root, "checkout-ready")), false);
      assert.equal(existsSync(join(root, "bootstrap-ready.json")), false);
      const saved = spawnSync("/usr/bin/tar", ["-xOzf", join(root, "results.tgz"), "exit-code"], { encoding: "utf8", timeout: 5000 });
      assert.ifError(saved.error); assert.equal(saved.status, 0, saved.stderr); assert.equal(saved.stdout, `${result.status}\n`);
      if (["apt", "download", "digest", "signature", "signing key"].includes(scenario)) assert.doesNotMatch(calls, /^extract$|^build$|^git /m);
      if (["download", "digest"].includes(scenario))
        assert.deepEqual(calls.match(/^download .+$/gm), ["download https://www.kernel.org/pub/software/scm/git/git-2.56.1.tar.xz"]);
    }
  });
