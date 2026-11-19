#!/bin/sh
# Runs on the machine as `deploy`. The workflow sends it over SSH on every deploy
# (.github/workflows/site.yml), so the machine always runs the copy of the commit it is given:
#   sh -s install <release directory> <sha256>   put an uploaded binary in place, if it is whole
#   sh -s serve <release directory>              restart the service with an answering backup
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
    ln -sfn "$release" "$root/next" &&
        mv -T "$root/next" "$root/$1"
}

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
serve)
    release=${2:?a release directory}
    [ -x "$release/corten-site" ] || { echo "no binary in $release" >&2; exit 1; }
    # There is nothing to bridge on a first deploy. Keep an answering backup from a prior
    # failed or interrupted restart until the primary is ready, including during put-back.
    if [ -L "$root/current" ] && ! ready 3001; then
        point bridge
        if ! sudo -n /usr/bin/systemctl restart corten-site-bridge.service || ! wait_ready 3001; then
            sudo -n /usr/bin/systemctl stop corten-site-bridge.service || true
            exit 1
        fi
    fi
    # The newest release is the one served last, whatever commit it holds.
    touch "$release"
    point current
    sudo -n /usr/bin/systemctl restart corten-site.service
    wait_ready 3000
    if [ -L "$root/bridge" ]; then
        sudo -n /usr/bin/systemctl stop corten-site-bridge.service
        rm -f "$root/bridge"
    fi
    ;;
prune)
    served=$(readlink "$root/current")
    backup=$(readlink "$root/bridge" || true)
    cd "$root/releases"
    # A directory with no binary in it is what a deploy that stopped at its upload left behind.
    for each in *; do
        [ -d "$each" ] || continue
        [ -x "$each/corten-site" ] || rm -rf -- "$root/releases/$each"
    done
    ls -1t | tail -n +4 | while read -r old; do
        [ -n "$old" ] || continue
        [ "$root/releases/$old" = "$backup" ] && continue
        [ "$root/releases/$old" = "$served" ] || rm -rf -- "$root/releases/$old"
    done
    ;;
*)
    echo "usage: install <release directory> <sha256> | serve <release directory> | prune" >&2
    exit 2
    ;;
esac
