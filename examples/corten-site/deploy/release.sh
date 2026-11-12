#!/bin/sh
# Runs on the machine as `deploy`. The workflow sends it over SSH on every deploy
# (.github/workflows/site.yml), so the machine always runs the copy of the commit it is given:
#   sh -s serve <release directory>   point `current` at a release and restart the service
#   sh -s prune                       remove all but the newest three releases, never the one served
set -eu
root=/opt/corten-site

case ${1:-} in
serve)
    release=${2:?a release directory}
    # An upload lands beside the binary and is renamed over it: writing onto the file a running
    # service was started from is refused.
    if [ -e "$release/corten-site.new" ]; then
        chmod 755 "$release/corten-site.new"
        mv "$release/corten-site.new" "$release/corten-site"
    fi
    [ -x "$release/corten-site" ] || { echo "no binary in $release" >&2; exit 1; }
    # The newest release is the one served last, whatever commit it holds.
    touch "$release"
    ln -sfn "$release" "$root/next"
    mv -T "$root/next" "$root/current"
    sudo /usr/bin/systemctl restart corten-site.service
    ;;
prune)
    served=$(readlink "$root/current")
    cd "$root/releases"
    ls -1t | tail -n +4 | while read -r old; do
        [ -n "$old" ] || continue
        [ "$root/releases/$old" = "$served" ] || rm -rf -- "$root/releases/$old"
    done
    ;;
*)
    echo "usage: serve <release directory> | prune" >&2
    exit 2
    ;;
esac
