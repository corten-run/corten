#!/bin/sh
# build.sh <work dir>: builds what the part in <work dir>/plan/ (plan.mjs) reads, and makes every
# check of the placement plan's first and fifth points that needs no running server
# (CONTRIBUTING.md, Pull requests, item 2). Each side is compiled once, and every placement of it
# is that compile's final link run again with a pad first in .text:
#   base   the plan's base   bin/base (unpadded), bin/base-p<n> for every n of both pad lists
#   head   the plan's head   bin/head (unpadded), bin/head-p<n> for every n of the first list
#          (a gated part only: a pilot reads the base alone)
# For each side the plan's paths of that commit are put at <work dir>/work (git archive), its
# Cargo.lock beside a copy of the probe (<work dir>/probe), and the plan's build command run there
# with a copy of wrap/ first on PATH, so the `cc` rustc runs records the probe's final link
# (link-capture.mjs) and then runs it. The probe's copy, the request script and the expected
# answer must be, file for file, what plan.mjs listed (plan/inputs.sha256), with no file or
# symbolic link more, or nothing is built. Cargo's own config files outside the probe
# ($CARGO_HOME/config.toml, a .cargo/config.toml above the probe's copy) are not among them:
# run.sh records which exist.
# The build's environment is none of the caller's: PATH, HOME, where rustup and cargo keep their
# files when the caller says, the toolchain, the kit's own three variables and the plan's
# probe.env, kept as build-<side>.env. A pad of n bytes is one function nothing calls,
# corten_layout_pad, of n bytes of int3 in a section of its own aligned to 16 and kept through
# --gc-sections; pads/order.txt is a symbol ordering file naming that function alone. Then, each
# stopping the build:
#   1. no version outside the commit's Cargo.lock was resolved, and LLD made the link;
#   2. the captured link run again without a pad, with LLD's map (maps/<side>.map), is
#      byte-identical to the build's own binary;
#   3. the side's record is read from that map (bin/record-<side>.json: each input section of
#      .text aligned beyond 16 bytes and every symbol from the first on), and the side is refused
#      when the map shows it has no reading across placements (map.mjs refuse);
#   4. where neither side has a section aligned beyond 16 bytes, each placement holds exactly its
#      side's functions and the pad, the pad first, every function moved by exactly the pad and
#      every pair of neighbours still next to each other in order (layout.mjs);
#   5. where either side has one, each placement is linked with a second pad (corten_layout_pad2,
#      last on the link line and not in the ordering file) of 16, 32, 48 and 64 bytes, each with
#      its map; the smallest whose map shows .data where the rule says is kept (a line a placement
#      in bin/second-pads.txt), or the side is refused when none does; the kept link's map is
#      checked against the unpadded link's (map.mjs check) and its functions as in 4 but for the
#      shift (layout.mjs --second);
#   6. no two binaries of one side have the same SHA-256.
# For a workload the plan shuffles (README.md, workloads[].shuffle), each side's functions in .text
# are listed from its unpadded binary (bin/functions-<side>.txt, order.mjs), and placement i of
# every binary (p_i and q_i alike) is linked with orders/<side>-p<n>.txt in place of
# pads/order.txt: the pad's function and then those functions in the order order.mjs draws from
# the workload's seed and i. Such a link fails when LLD warns that a name in the file is no symbol
# (relink.mjs --every-name), every placement is linked with its map (maps/<side>-p<n>.map, gzipped
# and its SHA-256 in maps/placements.sha256, as 5's kept links are), every map of the run, the
# unpadded ones too, is written with LLD's --no-demangle, so it names each symbol as the ELF symbol
# table does, which layout.mjs and order.mjs read functions from, and 4 and 5's checks of the
# functions are layout.mjs --order with the unpadded map and the placement's, which asks for the
# placement's map's input sections in the file's order (sections of one key in any order among
# themselves, as LLD promises no more), each function in its section, in place of
# each moved by the pad with its neighbours (5's map check takes --shuffled, its sections in any
# order). Each head placement is then checked against base's at its index (layout.mjs --alike,
# bin/layout/head-p<n>-alike.txt, from both sides' unpadded binaries, maps, placement maps and
# ordering files): the function definitions both have lie in one order in both, each place holding
# the same of them, a name defined more than once matched copy by copy by what a rebuild keeps of
# its object (less ordinals and hashes) and input section, or head is refused (7).
# A refusal (3, 5 or 7) ends with a line "REFUSED: ..." in bin/refused.txt and exit 3: that side
# does not pass and shows no win, and nothing is turned. 3 refuses before any placement is linked;
# 5 and 7 can only be seen as the placements are linked. Writes bin/, maps/, pads/, capture/,
# build-<side>.log and build-<side>.env under the work directory, and ends with BUILD-DONE.
set -eu
[ $# -eq 1 ] && [ -f "$1/plan/resolved.sh" ] || { echo "usage: build.sh <work dir>   (after plan.mjs wrote <work dir>/plan/)" >&2; exit 2; }
# Only the plan says whether the placements shuffle: a SHUFFLE the caller's environment holds is not read.
SHUFFLE=0
. "$1/plan/resolved.sh"
B=$WORK/bin; M=$WORK/maps
fail() { echo "build: $*" >&2; exit 1; }
refused() { mkdir -p "$B"; echo "REFUSED: $*" | tee "$B/refused.txt" >&2; exit 3; }
case "$WORK" in /*/*) ;; *) fail "the work directory $WORK is not a directory of its own" ;; esac
[ "$DRY" = 0 ] || echo "DRY RUN: K=$K; a test of the scripts, read for nothing"
# The plan's SHUFFLE stands whatever the cargo env file sets: it is put back, and not exported, after it.
[ ! -f "$HOME/.cargo/env" ] || { plan_shuffle=$SHUFFLE; . "$HOME/.cargo/env"; unset SHUFFLE; SHUFFLE=$plan_shuffle; }
export RUSTUP_TOOLCHAIN="$TOOLCHAIN"
rustc -V
for d in bin maps pads orders capture work probe wrap target-base target-head; do rm -rf "${WORK:?}/$d"; done
mkdir -p "$B/layout" "$M" "$WORK/pads" "$WORK/capture" "$WORK/wrap"
# A shuffled run's maps write each symbol as the ELF symbol table does (LLD's --no-demangle), so
# layout.mjs can match a map's symbols with the table's byte for byte; an unshuffled run's maps are
# as they were.
MANGLED=
[ "$SHUFFLE" = 0 ] || { echo "shuffled: every placement's functions in an order drawn from seed $SEED and its index"; mkdir -p "$WORK/orders"; MANGLED=--no-demangle; }
cp -R "$PROBE" "$WORK/probe"
# What the plan names by path is what plan.mjs listed when it resolved the plan, and nothing more:
# cp -R keeps a symbolic link a link, so everything under the copy that is not a directory (a file,
# a link, the copy itself when the probe's directory has become a link) must be a listed file.
[ "$(sha256sum "$WORK/plan/inputs.sha256" | cut -d' ' -f1)" = "$INPUTS_SHA" ] || fail "plan/inputs.sha256 is not the list plan.mjs wrote"
(cd "$WORK" && sha256sum --quiet -c plan/inputs.sha256) || fail "the probe, the request script or the expected answer is not what plan.mjs resolved (plan/inputs.sha256)"
[ "$(cd "$WORK" && find probe ! -type d | LC_ALL=C sort)" = "$(sed -n 's/^[0-9a-f]*  \(probe\/.*\)$/\1/p' "$WORK/plan/inputs.sha256")" ] || fail "the probe's directory holds a file or a symbolic link plan.mjs did not list (plan/inputs.sha256)"
# A listed file that has become a link to the same bytes passes both checks above, and what it
# points at lies outside what the plan names: plan.mjs refuses a link, and so does this.
[ -z "$(cd "$WORK" && find probe -type l)" ] || fail "the probe's directory holds a symbolic link where plan.mjs listed a file (plan/inputs.sha256 lists files by what they hold)"
cp "$KIT/wrap/cc" "$WORK/wrap/cc"; chmod +x "$WORK/wrap/cc"
: >"$B/sha256.txt"

pad() { # <file stem> <function> <bytes>
    printf '\t.section .text.%s,"axR",@progbits\n\t.p2align 4\n\t.type %s,@function\n%s:\n\t.skip %s, 0xcc\n\t.size %s, %s\n' "$2" "$2" "$2" "$3" "$2" "$3" >"$WORK/pads/$1.s"
    cc -c "$WORK/pads/$1.s" -o "$WORK/pads/$1.o"
    [ "$(readelf -sW "$WORK/pads/$1.o" | awk -v s="$2" '$8 == s { print $3 }')" = "$3" ] || fail "pads/$1.o: $2 is not $3 bytes"
}
echo corten_layout_pad >"$WORK/pads/order.txt"
for n in $PADS_P $PADS_Q; do pad "pad-$n" corten_layout_pad "$n"; done
for n in 16 32 48 64; do pad "pad2-$n" corten_layout_pad2 "$n"; done
sum() { echo "$1 $(sha256sum "$B/$1" | cut -d' ' -f1) $(stat -c %s "$B/$1") bytes" | tee -a "$B/sha256.txt"; }
versions() { awk '/^name = /{n=$3} /^version = /{print n, $3}' "$1" | tr -d '"' | sort -u; }

build() { # <side> <commit>
    side=$1; T=$WORK/target-$side; started=$(date +%s)
    echo "== $side: $2, $(date -u +%T)"
    rm -rf "${WORK:?}/work"; mkdir -p "$WORK/work" "$WORK/capture/$side"
    # shellcheck disable=SC2086
    git -C "$REPO" archive -o "$WORK/work.tar" "$2" -- $TREE || fail "$side: git archive of $2 failed"
    tar -x -f "$WORK/work.tar" -C "$WORK/work" || fail "$side: the archive of $2 did not unpack"
    rm "$WORK/work.tar"
    [ -f "$WORK/work/Cargo.lock" ] || fail "$side: the plan's tree has no Cargo.lock"
    cp "$WORK/work/Cargo.lock" "$WORK/probe/Cargo.lock"
    set -- PATH="$WORK/wrap:$PATH" HOME="$HOME" RUSTUP_TOOLCHAIN="$TOOLCHAIN" PLACEMENT_KIT="$KIT" LINK_CAPTURE="$WORK/capture/$side" CARGO_TARGET_DIR="$T"
    [ -z "${RUSTUP_HOME:-}" ] || set -- "$@" RUSTUP_HOME="$RUSTUP_HOME"
    [ -z "${CARGO_HOME:-}" ] || set -- "$@" CARGO_HOME="$CARGO_HOME"
    (cd "$WORK/probe" && env -i "$@" sh -c '. "$1" && env | LC_ALL=C sort >"$2" && exec sh -c "$3"' sh "$WORK/plan/build-env.sh" "$WORK/build-$side.env" "$BUILD" >"$WORK/build-$side.log" 2>&1) \
        || { tail -30 "$WORK/build-$side.log" >&2; fail "$side: the build failed"; }
    tail -2 "$WORK/build-$side.log"
    [ -f "$WORK/capture/$side/args.json" ] || fail "$side: no link was captured (the probe's binary is named probe)"
    versions "$WORK/work/Cargo.lock" >"$WORK/lock-$side.txt"
    own=$(sed -n 's/^name = "\(.*\)"$/\1/p' "$WORK/probe/Cargo.toml" | head -1)
    new=$(versions "$WORK/probe/Cargo.lock" | grep -v "^$own " | comm -23 - "$WORK/lock-$side.txt")
    [ -z "$new" ] || fail "$side resolved versions its commit's Cargo.lock does not have: $new"
    cp "$T/$BINARY" "$B/$side"
    readelf -p .comment "$B/$side" | grep -q 'Linker: LLD' || fail "$side was not linked by LLD"
    # shellcheck disable=SC2086
    node "$KIT/relink.mjs" "$WORK/capture/$side" "$B/$side-relink" --map "$M/$side.map" $MANGLED
    cmp -s "$B/$side" "$B/$side-relink" || fail "$side: the captured link run again without a pad differs from the build's own binary"
    rm "$B/$side-relink"
    echo "$side: the captured link run again without a pad, with its map, is byte-identical to the build's own binary"
    node "$KIT/map.mjs" record "$M/$side.map" >"$B/record-$side.json"
    node "$KIT/map.mjs" refuse "$M/$side.map" >"$B/refuse-$side.txt" 2>&1 || refused "$side has no reading across placements: $(sed 's/^map.mjs: //' "$B/refuse-$side.txt" | paste -sd';' -)"
    sum "$side"
    [ "$SHUFFLE" = 0 ] || node "$KIT/order.mjs" functions "$B/$side" >"$B/functions-$side.txt" || fail "$side: its functions in .text could not be listed for the ordering files"
    echo "$side built in $(( $(date +%s) - started )) s"
}
aligned() { node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).aligned.length)' "$B/record-$1.json"; }
place() { # <side> <pad> <index> (POSIX sh shares variables: this one names its own pl_*)
    pl=$1-p$2
    pl_order=$WORK/pads/order.txt
    if [ "$SHUFFLE" = 1 ]; then
        pl_order=$WORK/orders/$pl.txt
        node "$KIT/order.mjs" order "$B/functions-$1.txt" "$SEED" "$3" >"$pl_order" || fail "no ordering file for $pl"
    fi
    if [ "$SECOND" = 0 ]; then
        if [ "$SHUFFLE" = 0 ]; then
            node "$KIT/relink.mjs" "$WORK/capture/$1" "$B/$pl" --pad "$WORK/pads/pad-$2.o" --order "$WORK/pads/order.txt" || fail "relink failed: $pl"
            node "$KIT/layout.mjs" "$B/$1" "$B/$pl" "$2" >"$B/layout/$pl.txt" || fail "$pl is not its side's functions moved by its pad"
        else
            node "$KIT/relink.mjs" "$WORK/capture/$1" "$B/$pl" --map "$M/$pl.map" --no-demangle --pad "$WORK/pads/pad-$2.o" --order "$pl_order" --every-name || fail "relink failed: $pl"
            node "$KIT/layout.mjs" "$B/$1" "$B/$pl" "$2" --order "$pl_order" --map "$M/$1.map" --placed-map "$M/$pl.map" >"$B/layout/$pl.txt" || fail "$pl is not its side's functions and its pad in the order of orders/$pl.txt"
            echo "$(sha256sum "$M/$pl.map" | cut -d' ' -f1)  $pl.map" >>"$M/placements.sha256"
            gzip -9 "$M/$pl.map"
        fi
    else
        pl_kept=; pl_at=; pl_tried=
        for pl_n in 16 32 48 64; do
            if [ "$SHUFFLE" = 0 ]; then
                node "$KIT/relink.mjs" "$WORK/capture/$1" "$B/$pl-l$pl_n" --map "$M/$pl-l$pl_n.map" --pad "$WORK/pads/pad-$2.o" --order "$WORK/pads/order.txt" --second "$WORK/pads/pad2-$pl_n.o" || fail "relink failed: $pl with a second pad of $pl_n"
            else
                node "$KIT/relink.mjs" "$WORK/capture/$1" "$B/$pl-l$pl_n" --map "$M/$pl-l$pl_n.map" --no-demangle --pad "$WORK/pads/pad-$2.o" --order "$pl_order" --every-name --second "$WORK/pads/pad2-$pl_n.o" || fail "relink failed: $pl with a second pad of $pl_n"
            fi
            pl_d=$(node "$KIT/map.mjs" data "$M/$1.map" "$M/$pl-l$pl_n.map" "$2") && pl_fits=1 || pl_fits=0
            pl_tried="$pl_tried $pl_n:$(echo "$pl_d" | cut -d' ' -f4)"
            if [ -z "$pl_kept" ] && [ $pl_fits = 1 ]; then pl_kept=$pl_n; pl_at=$(echo "$pl_d" | cut -d' ' -f2); else rm -f "$B/$pl-l$pl_n" "$M/$pl-l$pl_n.map"; fi
        done
        [ -n "$pl_kept" ] || refused "$1 has no reading across placements: none of the four sizes of second pad puts $pl's .data $(( $2 % 64 )) bytes on from the unpadded link's, mod 64 (size:offset in a line$pl_tried)"
        mv "$B/$pl-l$pl_kept" "$B/$pl"; mv "$M/$pl-l$pl_kept.map" "$M/$pl.map"
        if [ "$SHUFFLE" = 0 ]; then
            node "$KIT/map.mjs" check "$M/$1.map" "$M/$pl.map" "$2" "$pl_kept" >"$B/layout/$pl-map.txt" || fail "$pl fails the map check"
            node "$KIT/layout.mjs" "$B/$1" "$B/$pl" "$2" --second >"$B/layout/$pl.txt" || fail "$pl is not its side's functions and the two pads"
        else
            node "$KIT/map.mjs" check "$M/$1.map" "$M/$pl.map" "$2" "$pl_kept" --shuffled >"$B/layout/$pl-map.txt" || fail "$pl fails the map check"
            node "$KIT/layout.mjs" "$B/$1" "$B/$pl" "$2" --second --order "$pl_order" --map "$M/$1.map" --placed-map "$M/$pl.map" >"$B/layout/$pl.txt" || fail "$pl is not its side's functions and the two pads in the order of orders/$pl.txt"
        fi
        echo "$pl: first pad $2 (mod 64: $(( $2 % 64 ))), second pad $pl_kept, .data at $pl_at; .data's offset in a 64-byte line with each size:$pl_tried" >>"$B/second-pads.txt"
        echo "$(sha256sum "$M/$pl.map" | cut -d' ' -f1)  $pl.map" >>"$M/placements.sha256"
        gzip -9 "$M/$pl.map"
    fi
    if [ "$SHUFFLE" = 1 ] && [ "$1" = head ]; then
        pl_second=; [ "$SECOND" = 0 ] || pl_second=--second
        # shellcheck disable=SC2086
        if ! node "$KIT/layout.mjs" --alike "$B/base" "$B/base-p$2" "$WORK/orders/base-p$2.txt" "$M/base.map" "$M/base-p$2.map.gz" "$B/head" "$B/$pl" "$pl_order" "$M/head.map" "$M/$pl.map.gz" "$2" $pl_second >"$B/layout/$pl-alike.txt" 2>"$B/alike-$pl.txt"; then
            grep -q '^JSON {"ok":false' "$B/layout/$pl-alike.txt" || fail "$pl could not be checked against base-p$2: $(cat "$B/alike-$pl.txt")"
            refused "head has no reading against base across shuffled placements: base-p$2 and $pl, linked in one index's order, lay the functions both have in different orders ($(sed 's/^layout.mjs: //' "$B/alike-$pl.txt" | paste -sd';' -))"
        fi
    fi
    sum "$pl" >/dev/null
}
for s in $SIDES; do if [ "$s" = base ]; then build base "$BASE"; else build head "$HEAD"; fi; done
SECOND=0
for s in $SIDES; do
    n=$(aligned "$s")
    echo "$s: $n input sections of .text aligned beyond 16 bytes"
    [ "$n" = 0 ] || SECOND=1
done
[ "$SECOND" = 0 ] || { echo "a second pad in every placement of every side (the fifth point)"; : >"$B/second-pads.txt"; }
started=$(date +%s)
# A pad's index is its place in its list, so p_i and q_i, the A/A's two sides at i, and the
# change's base and head at p_i, take one ordering file's order when the plan shuffles.
pi=0; for n in $PADS_P; do pi=$((pi + 1)); place base "$n" "$pi"; done
pi=0; for n in $PADS_Q; do pi=$((pi + 1)); place base "$n" "$pi"; done
case " $SIDES " in *" head "*) pi=0; for n in $PADS_P; do pi=$((pi + 1)); place head "$n" "$pi"; done ;; esac
for s in $SIDES; do
    dups=$(awk -v s="$s" '$1 == s || index($1, s "-p") == 1 { print $2 }' "$B/sha256.txt" | sort | uniq -d)
    [ -z "$dups" ] || fail "$s: binaries of one build with the same sha256: $dups"
    gzip -9 -k "$M/$s.map"
done
echo "$(( $(wc -l <"$B/sha256.txt") )) binaries, no two of one side with the same sha256; placements linked and checked in $(( $(date +%s) - started )) s"
[ "$SECOND" = 0 ] || cat "$B/second-pads.txt"
echo "plan $PLAN_SHA inputs $INPUTS_SHA part $PART workload $W K $K dry $DRY" >"$B/built-for.txt"
echo BUILD-DONE
