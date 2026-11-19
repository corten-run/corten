#!/bin/sh
# Runs on the machine as `deploy`. The workflow sends it over SSH on every deploy
# (.github/workflows/site.yml), so the machine always runs the copy of the commit it is given:
#   sh -s install <release directory> <sha256>   put an uploaded binary in place, if it is whole
#   sh -s serve <release directory> [<expected>] restart with a backup if the primary is ready
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

# Keep the lock on systemctl's stdin too: sudo closes extra descriptors, and the client
# can outlive this shell. If the client also dies, systemd can still have its job queued.
unit() { sudo -n /usr/bin/systemctl "$@" <&9; }

stop_bridge() {
    if [ -L "$root/bridge" ]; then
        unit stop corten-site-bridge.service && rm -f "$root/bridge"
    fi
}

retire_bridge() {
    if [ -L "$root/bridge" ]; then
        # nginx can still skip the primary after readiness. Allow for an in-flight page's
        # one-second timeout and the one-second fail_timeout, rounded to whole seconds.
        sleep 3
        wait_ready 3000
        stop_bridge
    fi
}

settle() {
    for service in corten-site.service corten-site-bridge.service; do
        tries=0
        while :; do
            job=$(systemctl show --property=Job --value "$service") || return 1
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
    flock 9
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
    if [ "$1" = restore ]; then : "${3:?the failed release directory}"; fi
    [ -x "$release/corten-site" ] || { echo "no binary in $release" >&2; exit 1; }
    settle
    current=$(readlink "$root/current" || true)
    if [ "$1" = restore ] && [ "$current" = "$release" ]; then
        # A failure before switching the link needs no put-back if it is still answering.
        if ready 3000; then retire_bridge; exit 0; fi
    elif [ "$#" -ge 3 ] && [ "$current" != "$3" ]; then
        echo "current changed to ${current:-no release}; not switching to $release" >&2
        exit 1
    fi
    stage=$(mktemp -d "$root/.release.XXXXXX")
    trap 'rm -f "$stage/link"; rmdir "$stage"' EXIT
    trap 'exit 1' HUP INT TERM
    # There is nothing to bridge on a first deploy. Keep an answering backup from a prior
    # failed or interrupted restart until the primary is ready, including during put-back.
    if [ -n "$current" ] && ! ready 3001; then
        point bridge
        if ! unit restart corten-site-bridge.service || ! wait_ready 3001; then
            stop_bridge || true
            if [ "$1" = serve ] && ready 3000; then exit 1; fi
            echo "restoring the primary without a ready backup" >&2
        fi
    fi
    # The newest release is the one served last, whatever commit it holds.
    touch "$release"
    point current
    unit restart corten-site.service
    wait_ready 3000
    retire_bridge
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
    echo "usage: install <release directory> <sha256> | serve <release directory> [<expected>] | restore <release directory> <failed> | prune" >&2
    exit 2
    ;;
esac
