#!/bin/sh
# train.sh <all|no-item|no-br>: what a profiled build's copy of card-market is sent, at
# 127.0.0.1 on the port `corten build --profile-from` names in PORT. 300 requests a line below,
# five on each connection, each answered with a success or the script (and the build) fails.
#   all      the home page and the item page, each accepting no coding, a coding list the app
#            answers in zstd and one it answers in brotli, and the item's JSON
#   no-item  the same without the item page: one route left out
#   no-br    the same as all without the brotli lines: one response coding left out
set -e
profile=$1
case "$profile" in all | no-item | no-br) ;; *) echo "train.sh: all, no-item or no-br" >&2; exit 2 ;; esac
home=/ item=/items/item_5 json=/api/items/item_5
# Chromium's and Firefox's Accept-Encoding, and WebKit's over HTTPS.
zstd='gzip, deflate, br, zstd' br='gzip, deflate, br'

ask() { # <path> [<Accept-Encoding>]
    url="http://127.0.0.1:$PORT$1"
    n=0
    while [ "$n" -lt 60 ]; do
        if [ -n "${2:-}" ]; then
            curl -fsS --fail-early -H "Accept-Encoding: $2" \
                -o /dev/null "$url" -o /dev/null "$url" -o /dev/null "$url" -o /dev/null "$url" -o /dev/null "$url"
        else
            curl -fsS --fail-early \
                -o /dev/null "$url" -o /dev/null "$url" -o /dev/null "$url" -o /dev/null "$url" -o /dev/null "$url"
        fi
        n=$((n + 1))
    done
    # One more, to say what the copy answered with.
    if [ -n "${2:-}" ]; then
        coding=$(curl -fsS -o /dev/null -w '%header{content-encoding}' -H "Accept-Encoding: $2" "$url")
    else
        coding=$(curl -fsS -o /dev/null -w '%header{content-encoding}' "$url")
    fi
    echo "train $profile: 300 x GET $1, Accept-Encoding: ${2:-(none)}, answered in ${coding:-no coding}"
}

ask "$home"
ask "$home" "$zstd"
[ "$profile" = no-br ] || ask "$home" "$br"
if [ "$profile" != no-item ]; then
    ask "$item"
    ask "$item" "$zstd"
    [ "$profile" = no-br ] || ask "$item" "$br"
fi
ask "$json"
