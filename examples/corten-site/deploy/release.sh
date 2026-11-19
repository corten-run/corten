#!/bin/sh
# Runs on the machine as `deploy`. The workflow sends it over SSH on every deploy
# (.github/workflows/site.yml), so the machine always runs the copy of the commit it is given:
#   sh -s install <release directory> <sha256>   put an uploaded binary in place, if it is whole
#   sh -s serve <release directory> <expected>   restart with a backup; expected is 'none' on first ship
#   sh -s restore <release directory> <failed>   put back a failed release even without a backup
#   sh -s prune                                  remove all but the newest three releases, never the one served,
#                                                and what a deploy that stopped at its upload left
set -eu
root=/opt/corten-site

ready() {
    curl --noproxy '*' -fs --max-time 1 -o /dev/null "http://127.0.0.1:$1/health/ready"
}

wait_ready() {
    tries=0
    until ready "$1"; do
        tries=$((tries + 1))
        if [ "$tries" = 10 ]; then
            echo "the instance on port $1 did not become ready" >&2
            return 1
        fi
        sleep 0.2
    done
}

point() {
    ln -s "$release" "$stage/link" && mv -T "$stage/link" "$root/$1"
}

bounded() {
    timeout --kill-after=2s 30s "$@" && return 0
    status=$?
    case "$status" in
        124|137) echo "timed out waiting for $*" >&2 ;;
        *) echo "$* failed (status $status)" >&2 ;;
    esac
    return "$status"
}

# Keep the lock on the bounded client's stdin too: it can outlive this shell, and sudo
# closes extra descriptors. A systemd job can still outlive the client; settle checks that.
unit() { bounded sudo -n /usr/bin/systemctl "$@" <&9; }

start_bridge() {
    if ! ready 3001; then
        rm -f "$root/bridge-ready" && point bridge &&
            unit restart corten-site-bridge.service && wait_ready 3001 || return
    fi
    touch "$root/bridge-ready"
}

stop_bridge() {
    rm -f "$root/bridge-ready" || return 1
    if [ -L "$root/bridge" ]; then
        unit stop corten-site-bridge.service && rm -f "$root/bridge"
    fi
}

settle() {
    for service in corten-site.service corten-site-bridge.service; do
        tries=0
        while :; do
            job=$(bounded systemctl show --property=Job --value "$service") || return 1
            case "$job" in ''|0) break ;; esac
            tries=$((tries + 1))
            if [ "$tries" = 150 ]; then
                echo "a systemd job for $service is still pending" >&2
                return 1
            fi
            sleep 0.2
        done
    done
}

case ${1:-} in
install|serve|restore|prune)
    exec 9<> "$root/.release.lock"
    flock -w 60 9 || { echo "could not acquire the release lock within 60 seconds" >&2; exit 1; }
    ;;
esac

case ${1:-} in
install)
    release=${2:?a release directory}
    sum=${3:?the sha256 of the binary that was built}
    # An upload lands beside the binary and is renamed over it: writing onto the file a running
    # service was started from is refused. One that was cut off is not the binary that was built,
    # and is removed rather than renamed.
    upload="$release/corten-site.new"
    [ -f "$upload" ] || { echo "nothing was uploaded to $release" >&2; exit 1; }
    if [ "$(sha256sum "$upload" | cut -d' ' -f1)" != "$sum" ]; then
        rm -f "$upload"
        echo "the upload to $release is not the binary that was built" >&2
        exit 1
    fi
    chmod 755 "$upload"
    mv "$upload" "$release/corten-site"
    ;;
serve|restore)
    release=${2:?a release directory}
    expected=${3:?an expected current release (none for a first deploy)}
    [ -x "$release/corten-site" ] || { echo "no binary in $release" >&2; exit 1; }
    settle
    current=$(readlink "$root/current" || echo none)
    # A put-back may already have moved the link on a previous try. It still needs to
    # restart: neither the link nor readiness says which binary is answering.
    if [ "$current" != "$expected" ] && { [ "$1" != restore ] || [ "$current" != "$release" ]; }; then
        echo "current changed to $current; not switching to $release" >&2
        exit 1
    fi
    stage=$(mktemp -d "$root/.release.XXXXXX")
    trap 'rm -f "$stage/link"; rmdir "$stage"' EXIT
    trap 'exit 1' HUP INT TERM
    # There is nothing to bridge on a first deploy. Keep an answering backup from a prior
    # failed or interrupted restart until the primary is ready, including during put-back.
    if [ "$current" != none ]; then
        start_bridge || {
            case "$?" in 124|137) exit 1 ;; esac
            settle
            stop_bridge || case "$?" in 124|137) exit 1 ;; esac
            if [ "$1" = serve ] && ready 3000; then exit 1; fi
            echo "restarting the primary without a ready backup" >&2
        }
    fi
    # The newest release is the one served last, whatever commit it holds.
    touch "$release"
    point current
    unit restart corten-site.service
    wait_ready 3000
    stop_bridge
    ;;
prune)
    served=$(readlink "$root/current")
    backup=$(readlink "$root/bridge" || true)
    cd "$root/releases"
    # Uploads land outside this lock. Give them the ship job's 45 minutes before treating
    # a directory without an installed binary as abandoned.
    kept=0
    ls -1t | while read -r old; do
        [ -n "$old" ] || continue
        dir="$root/releases/$old"
        if [ -x "$dir/corten-site" ]; then
            kept=$((kept + 1))
            [ "$kept" -gt 3 ] || continue
            [ "$dir" = "$backup" ] || [ "$dir" = "$served" ] || rm -rf -- "$dir"
        elif [ "$dir" != "$backup" ] && [ "$dir" != "$served" ]; then
            find "$dir" -maxdepth 0 -type d -mmin +45 -exec rm -rf -- {} \;
        fi
    done
    ;;
*)
    echo "usage: install <release directory> <sha256> | serve <release directory> <expected or none> | restore <release directory> <failed> | prune" >&2
    exit 2
    ;;
esac
