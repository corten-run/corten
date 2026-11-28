import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { remoteFiles, reservation } from "./cloud-contract.mjs";

const fingerprint = "F911AB184317630C59970973E363C90F8F1B6217";
const job = remoteFiles(reservation({ round: "r21", commit: "a".repeat(40), token: "0123456789abcdef" }))["job.sh"];
const start = job.indexOf("install -d -m 0755 /etc/apt/keyrings");
const end = job.indexOf("timeout 30 git --no-replace-objects", start);
assert.ok(start >= 0 && end > start);
const original = job.slice(start, end);

for (const [scenario, options] of Object.entries({
  accepted: {},
  "accepted with subkey": { keys: `pub:::::::::\nfpr:::::::::${fingerprint}:\nsub:::::::::\nfpr:::::::::SUBKEY:\n` },
  "wrong primary": { keys: "pub:::::::::\nfpr:::::::::BAD:\n" },
  "extra primary": { keys: `pub:::::::::\nfpr:::::::::${fingerprint}:\npub:::::::::\nfpr:::::::::BAD:\n` },
  "missing primary": { keys: `fpr:::::::::${fingerprint}:\n` },
  "key parser failure": { gpgExit: 38 },
  "key download failure": { curlExit: 37 },
  "extractor failure after fingerprint": { awkExit: 39 },
})) test(`cloud Git PPA setup ${scenario}`, { skip: process.platform !== "linux" }, t => {
  const root = mkdtempSync(join(tmpdir(), "corten-git-ppa-"));
  chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const shims = {
    curl: '#!/bin/sh\nset -eu\nif test "$CURL_EXIT" != 0; then exit "$CURL_EXIT"; fi\nwhile test "$1" != -o; do shift; done\nprintf "public-key-fixture\\n" > "$2"\n',
    gpg: '#!/bin/sh\nprintf "%s" "$KEYS"\nexit "$GPG_EXIT"\n',
    "apt-get": '#!/bin/sh\nprintf "%s\\n" "$*" >> "$ROOT/apt-calls"\n',
    git: '#!/bin/sh\nprintf "git version fixture\\n"\n',
    timeout: '#!/bin/sh\nshift\nexec "$@"\n',
  };
  if (options.awkExit) shims.awk = `#!/bin/sh\nprintf '%s\\n' '${fingerprint}'\nexit ${options.awkExit}\n`;
  for (const [command, bytes] of Object.entries(shims)) writeFileSync(join(root, command), bytes, { mode: 0o700 });
  const probe = join(root, "fixture-probe");
  writeFileSync(probe, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const executable = spawnSync(probe, [], { encoding: "utf8", timeout: 5000 });
  assert.equal(executable.error, undefined, "fixture directory must permit execution; never fall back to host commands");
  assert.equal(executable.status, 0);
  const script = original.replaceAll("/etc/apt", `${root}/apt`).replaceAll("/tmp/corten-git-ppa.keys", `${root}/keys`)
    .replaceAll("/tmp/corten-git-ppa.asc", `${root}/public-key`);
  const result = spawnSync("/bin/bash", ["-c", `set -Eeuo pipefail\numask 077\nmkdir -p '${root}/apt/sources.list.d' || exit 1\n${script}`], {
    env: { PATH: `${root}:/usr/bin:/bin`, HOME: root, ROOT: root,
      KEYS: options.keys ?? `pub:::::::::\nfpr:::::::::${fingerprint}:\n`,
      GPG_EXIT: String(options.gpgExit ?? 0), CURL_EXIT: String(options.curlExit ?? 0) },
    cwd: root, encoding: "utf8", timeout: 5000, maxBuffer: 65536,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  const list = join(root, "apt/sources.list.d/corten-git-ppa.list");
  if (scenario.startsWith("accepted")) {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(statSync(list).mode & 0o777, 0o644);
    assert.equal(statSync(join(root, "apt/keyrings/corten-git-ppa.asc")).mode & 0o777, 0o644);
    assert.equal(readFileSync(list, "utf8"), `deb [signed-by=${root}/apt/keyrings/corten-git-ppa.asc] https://ppa.launchpadcontent.net/git-core/ppa/ubuntu noble main\n`);
    const calls = readFileSync(join(root, "apt-calls"), "utf8");
    assert.match(calls, /update -qq\ninstall -y -qq(?: --no-install-recommends)? git\n$/);
  } else {
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(list), false, "unverified key must not authorize a source");
    const calls = existsSync(join(root, "apt-calls")) ? readFileSync(join(root, "apt-calls"), "utf8") : "";
    assert.ok(!calls.includes(" git"), "unverified source must not install Git");
  }
});
