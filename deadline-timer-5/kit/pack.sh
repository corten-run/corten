#!/bin/sh
# pack.sh <corten repository> <tar> [<plan.env>]: packs this kit as a measuring host gets it, a
# tar that unpacks as dl/. Nothing on a host runs this. In the tar:
#   - every file of this kit but plan.md (the plan as published is put beside the kit on the
#     host; it names this tar's sha256, so it cannot be in it);
#   - plan.env: the kit's own, the pilot's, or the third argument (the gated part's, from
#     gated-env.mjs); its pad lists must be pads.mjs's for each workload's K (padlists.mjs);
#   - src-base/ and src-base.commit: git archive of crates, examples, Cargo.toml, Cargo.lock and
#     .cargo at commits.env's BASE; in the gated part src-head/ and src-head.commit too, at HEAD;
#   - kit-trees.sha256: for each tree, the sha256 of its files' sha256sum lines, sorted;
#   - kit-files.sha256: the sha256 of every other file in the tar but itself.
# build.sh and run.sh check the last two on the host before anything is built or run (plan.sh's
# kit_check). The tar's members are sorted, owned by 0, dated 2026-11-25 and given one mode (0644
# a file, 0755 a directory; every script is run by name through sh or node, and build.sh makes
# wrap/cc executable), in GNU tar's own format, so the same bytes packed again by GNU tar give
# the same tar whatever system holds them. Prints the plan's sha256 (plan.env and
# commits.env), the sha256 of kit-files.sha256, and the tar's sha256 and size, and leaves copies
# of the two lists beside the tar (<tar>.files.sha256, <tar>.trees.sha256).
set -eu
[ $# -ge 2 ] || { sed -n '2,19p' "$0"; exit 2; }
here=$(cd "$(dirname "$0")" && pwd); repo=$1; out=$2; planenv=${3:-$here/plan.env}
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
# sha256sum's lines as "<sha256>  <path>" on every system (some print " *" before the path).
two='s/^\([0-9a-f]\{64\}\) [ *]/\1  /'
mkdir "$T/dl"
(cd "$here" && tar -cf - --exclude=./plan.md --exclude=./kit-files.sha256 --exclude=./kit-trees.sha256 .) | (cd "$T/dl" && tar -xf -)
cp "$planenv" "$T/dl/plan.env"
node "$T/dl/padlists.mjs" --check "$T/dl/plan.env" >"$T/padlists.out" 2>&1 || { cat "$T/padlists.out"; echo "pack.sh: plan.env's K's or pad lists are not usable: nothing packed"; exit 1; }
. "$T/dl/commits.env"
part=$(sed -n 's/^PART=//p' "$T/dl/plan.env")
sides=base; [ "$part" != gated ] || sides="base head"
: >"$T/dl/kit-trees.sha256"
for side in $sides; do
    c=$BASE; [ "$side" != head ] || c=$HEAD
    mkdir "$T/dl/src-$side"
    git -C "$repo" -c core.autocrlf=false archive "$c" crates examples Cargo.toml Cargo.lock .cargo | (cd "$T/dl/src-$side" && tar -xf -)
    echo "$c" >"$T/dl/src-$side.commit"
    echo "$(cd "$T/dl" && find src-$side -type f | LC_ALL=C sort | xargs sha256sum | sed "$two" | sha256sum | cut -d' ' -f1)  src-$side/" >>"$T/dl/kit-trees.sha256"
done
(cd "$T/dl" && find . -type f ! -path './src-base/*' ! -path './src-head/*' ! -name kit-files.sha256 | LC_ALL=C sort | xargs sha256sum | sed "$two") >"$T/dl/kit-files.sha256"
(cd "$T" && tar --format=gnu --sort=name --mtime='2026-11-25 00:00:00Z' --owner=0 --group=0 --numeric-owner --mode='a-x,a+rX,u+w,go-w' -cf dl.tar dl)
cp "$T/dl.tar" "$out"; cp "$T/dl/kit-files.sha256" "$out.files.sha256"; cp "$T/dl/kit-trees.sha256" "$out.trees.sha256"
echo "part $part; sides $sides; $(wc -l <"$T/dl/kit-files.sha256") files listed"
cat "$T/dl/kit-trees.sha256"
echo "plan sha256 (plan.env and commits.env): $(cat "$T/dl/plan.env" "$T/dl/commits.env" | sha256sum | cut -d' ' -f1)"
echo "kit-files.sha256: $(sha256sum <"$T/dl/kit-files.sha256" | cut -d' ' -f1)"
echo "tar: $(sha256sum <"$out" | cut -d' ' -f1) $(wc -c <"$out") bytes"
