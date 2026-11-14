import { remoteFiles as contractFiles, validateState } from "./cloud-contract.mjs";
import { quote } from "./cloud-transport.mjs";

export const sourceUrl = "https://github.com/corten-run/corten.git";
export function remoteFiles(state) {
  validateState(state, state.round);
  const files = contractFiles(state), commit = quote(state.commit), round = quote(state.round);
  // Preserve the fixed packages, paths, unit and all-nine invocation from the contract.
  // Add source provenance before any native entry, rather than importing a sibling tree.
  const provenance = `timeout 600 git -c core.autocrlf=false clone --quiet --no-checkout ${quote(sourceUrl)} '/bench/repo'
cd '/bench/repo'
test "$(git config --get remote.origin.url)" = ${quote(sourceUrl)}
timeout 600 git fetch --quiet --no-tags origin '+refs/heads/main:refs/remotes/origin/main'
git merge-base --is-ancestor ${commit} 'origin/main'
git -c core.autocrlf=false checkout --detach ${commit}
test "$(git rev-parse HEAD)" = ${commit}
test -z "$(git status --porcelain --untracked-files=all)"
{ printf 'source-url=%s\\n' ${quote(sourceUrl)}; printf 'source-commit=%s\\n' ${commit}; git rev-parse 'HEAD^{tree}'; } >> '/bench/host.txt'`;
  const original = `timeout 600 git clone --quiet ${sourceUrl} /bench/repo
cd /bench/repo
git checkout --detach ${state.commit}
test "$(git rev-parse HEAD)" = ${state.commit}
test -z "$(git status --porcelain --untracked-files=all)"`;
  const entry = `node bench/workloads/isolated/campaign-entry.mjs ${state.round} --commit ${state.commit} --state-dir /bench/campaign`;
  if (!files["job.sh"].includes(original) || files["job.sh"].split(entry).length !== 2)
    throw new Error("fixed provisioning contract changed; review adapter");
  files["job.sh"] = files["job.sh"].replace("set -Eeuo pipefail", "set -Eeuo pipefail\numask 077")
    .replace(original, provenance)
    .replace(entry,
      `mkdir -m 700 -- '/bench/campaign'\ntest -z "$(git status --porcelain --untracked-files=all)"\nnode 'bench/workloads/isolated/campaign-entry.mjs' ${round} --commit ${commit} --state-dir '/bench/campaign'`);
  files["pack.sh"] = `#!/bin/bash
set -euo pipefail
umask 077
cd '/bench'
for file in 'run.log' 'host.txt' 'exit-code'; do test -f "$file" && test ! -L "$file"; done
if test -e 'results.tgz' || test -L 'results.tgz'; then
  test -f 'results.tgz' && test ! -L 'results.tgz'
  exit 0
fi
stage=$(mktemp '/bench/cloud-pack.XXXXXXXX')
trap 'rm -f -- "$stage"' EXIT
files=('run.log' 'host.txt' 'exit-code')
test ! -e 'campaign' || files+=('campaign')
tar --format=gnu -czf "$stage" -- "\${files[@]}"
ln -- "$stage" 'results.tgz'
rm -- "$stage"
trap - EXIT
`;
  return files;
}
