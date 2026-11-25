#!/bin/sh
# go.sh: how sized-run.sh was started on the host, which another run's work had prepared and which
# was only borrowed: everything of this run under one directory, and nothing installed. The host
# had every tool the kit asks for but git, so Debian 13's own git package (git 2.47.3) was
# unpacked under that directory, not installed, and put first on PATH; cargo keeps its files
# under that directory too (CARGO_HOME), so the host's own registry cache is not written to. The
# checkout holds the kit's commit and the one commit every plan names, and no other. It leaves
# its process id in PID while it runs and its exit status in ENDED when it is over, so that
# whether it is still running can be asked without reading anything it wrote.
#   (nohup sh go.sh >sized-run.out 2>&1 </dev/null &)
P=$(cd "$(dirname "$0")/.." && pwd)
echo $$ >"$P/PID"
export PATH="$P/git/usr/bin:$PATH" GIT_EXEC_PATH="$P/git/usr/lib/git-core" CARGO_HOME="$P/cargo"
echo "kit: $(git -C "$P/corten" rev-parse HEAD); commits in the checkout: $(git -C "$P/corten" cat-file --batch-all-objects --batch-check | grep ' commit ' | cut -d' ' -f1 | paste -sd' ' -); changed files in it: $(git -C "$P/corten" status --short | wc -l)"
echo "started $(date -u +%FT%TZ); load $(cut -d' ' -f1-3 /proc/loadavg); logins: $(who | wc -l)"
sh "$P/ev/sized-run.sh" "$P/corten/bench/placement" "$P/w"; rc=$?
echo "ended $(date -u +%FT%TZ); sized-run.sh exit $rc"
echo "$rc" >"$P/ENDED"
