import { remoteFiles as contractFiles, savedLoadLayout, savedPlacement, validateRemoteFileState } from "./cloud-contract.mjs";
import { quote } from "./cloud-transport.mjs";
import { archiveLimit, expandedLimit } from "./cloud-local.mjs";
import { custodyCommand, guardianSha256 } from "./cloud-control-runtime.mjs";

export const sourceUrl = "https://github.com/corten-run/corten.git";
export function bootstrapMarker(state) {
  validateRemoteFileState(state);
  return { schema: state.control ? "benchmark-common-bootstrap/v2" : "benchmark-common-bootstrap/v1", round: state.round, commit: state.commit,
    token: state.token, group: state.group ?? "all", ...(state.control ? { controlHelperSha256: guardianSha256 } : {}),
    ...(state.control?.monitor ? { monitorId: state.control.monitor.id } : {}),
    ...(state.fleet?.single?.offlineHandoff ? { offlineHandoff: true } : {}) };
}
export const bootstrapReadScript = `if test ! -e /bench/bootstrap-ready.json; then exit 3; fi
test -f /bench/bootstrap-ready.json && test ! -L /bench/bootstrap-ready.json
test "$(stat -c '%s' -- /bench/bootstrap-ready.json)" -le 1024
cat -- /bench/bootstrap-ready.json`;
export function remoteFiles(state) {
  const files = contractFiles(state), commit = quote(state.commit), round = quote(state.round);
  // Preserve the fixed packages, paths, unit and all-nine invocation from the contract.
  // Add source provenance before any native entry, rather than importing a sibling tree.
  // Only public Git source is shared with nonroot bind-mount readers. Keep the
  // job's private umask for tooling, control files, provenance and campaign data.
  const provenance = `(
umask 022
timeout 600 git -c core.autocrlf=false clone --quiet --no-checkout ${quote(sourceUrl)} '/bench/repo'
cd '/bench/repo'
test "$(git config --get remote.origin.url)" = ${quote(sourceUrl)}
timeout 600 git fetch --quiet --no-tags origin '+refs/heads/main:refs/remotes/origin/main'
git merge-base --is-ancestor ${commit} 'origin/main'
git -c core.autocrlf=false checkout --detach ${commit}
test "$(git rev-parse HEAD)" = ${commit}
test -z "$(git status --porcelain --untracked-files=all)"
)
cd '/bench/repo'
{ printf 'source-url=%s\\n' ${quote(sourceUrl)}; printf 'source-commit=%s\\n' ${commit}; git rev-parse 'HEAD^{tree}'; } >> '/bench/host.txt'`;
  const original = `timeout 600 git clone --quiet ${sourceUrl} /bench/repo
cd /bench/repo
git checkout --detach ${state.commit}
test "$(git rev-parse HEAD)" = ${state.commit}
test -z "$(git status --porcelain --untracked-files=all)"`;
  const group = state.group === undefined ? "" : ` --group ${quote(state.group)}`;
  const loadLayout = savedLoadLayout(state);
  const placement = savedPlacement(state);
  const entry = `node bench/workloads/isolated/campaign-entry.mjs ${state.round} --commit ${state.commit} --state-dir /bench/campaign${state.group === undefined ? "" : ` --group ${state.group}`}${loadLayout ? ` --load-layout ${loadLayout}` : ""}${placement ? ` --placement ${placement}` : ""}`;
  if (!files["job.sh"].includes(original) || files["job.sh"].split(entry).length !== 2)
    throw new Error("fixed provisioning contract changed; review adapter");
  files["job.sh"] = files["job.sh"].replace("set -Eeuo pipefail", "set -Eeuo pipefail\numask 077")
    .replace(original, provenance)
    .replace(entry,
      `bootstrap_stage=campaign-directory\nmkdir -m 700 -- '/bench/campaign'\nbootstrap_stage=source-cleanliness\ntest -z "$(git status --porcelain --untracked-files=all)"\nbootstrap_stage=bootstrap-marker\nnode --input-type=module -e ${quote(`import { writeFileSync } from "node:fs"; writeFileSync("/bench/bootstrap-ready.json", ${JSON.stringify(`${JSON.stringify(bootstrapMarker(state))}\n`)}, { flag: "wx", mode: 0o600 });`)}\nbootstrap_stage=native-entry\nnode 'bench/workloads/isolated/campaign-entry.mjs' ${round} --commit ${commit} --state-dir '/bench/campaign'${group}${loadLayout ? ` --load-layout ${quote(loadLayout)}` : ""}${placement ? ` --placement ${quote(placement)}` : ""}`);
  files["pack.sh"] = `#!/bin/bash
set -euo pipefail
umask 077
cd '/bench'
${state.control ? `if test -d '/run/corten-bench-control-${state.token}'; then
  ${custodyCommand(state.token)}
fi
` : ""}for file in 'run.log' 'host.txt' 'exit-code'; do test -f "$file" && test ! -L "$file"; done
if test -e 'results.tgz' || test -L 'results.tgz'; then
  test -f 'results.tgz' && test ! -L 'results.tgz'
  test "$(stat -c '%s' -- 'results.tgz')" -le ${archiveLimit}
  exit 0
fi
if { test ! -e 'campaign' && test ! -L 'campaign'; } || { test -d 'campaign' && test ! -L 'campaign' && test -z "$(ls -A -- 'campaign')"; }; then
  /usr/bin/timeout 25 /usr/bin/python3 - <<'CORTEN_SETUP_PACKAGE'
import os, pathlib, re, stat
root = pathlib.Path('/bench')
assert root.is_dir() and not root.is_symlink() and root.resolve() == root
marker = root / 'bootstrap-ready.json'
if os.path.lexists(marker):
    info = marker.lstat()
    assert stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= 1024
    assert marker.read_bytes() == ${JSON.stringify(`${JSON.stringify(bootstrapMarker(state))}\n`)}.encode('ascii')
campaign = root / 'campaign'
if os.path.lexists(campaign):
    assert campaign.is_dir() and not campaign.is_symlink() and next(campaign.iterdir(), None) is None
size = 0
for name in ['run.log', 'host.txt', 'exit-code']:
    info = (root / name).lstat()
    assert stat.S_ISREG(info.st_mode) and info.st_nlink == 1
    size += info.st_size
    assert size <= ${expandedLimit}
marker = root / 'exit-code'
assert marker.stat().st_size <= 16
value = marker.read_bytes()
assert re.fullmatch(rb'[1-9][0-9]{0,2}\\n', value) and int(value) <= 255
CORTEN_SETUP_PACKAGE
else
  node --input-type=module -e 'import { checkPackage } from "/bench/repo/bench/workloads/cloud-local.mjs"; checkPackage("/bench");'
fi
stage=$(mktemp '/bench/cloud-pack.XXXXXXXX')
trap 'rm -f -- "$stage"' EXIT
files=('run.log' 'host.txt' 'exit-code')
test ! -e 'campaign' || files+=('campaign')
${state.control ? "test ! -e 'control' || files+=('control')\n" : ""}tar --format=gnu -czf "$stage" -- "\${files[@]}"
test "$(stat -c '%s' -- "$stage")" -le ${archiveLimit}
ln -- "$stage" 'results.tgz'
rm -- "$stage"
trap - EXIT
`;
  return files;
}
