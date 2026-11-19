#!/bin/sh
# Exercise release ordering with stand-ins for systemctl and the instance readiness probes.
set -eu

root=/opt/corten-site
[ -e /.dockerenv ] && [ ! -e "$root" ] || { echo "run in a fresh container" >&2; exit 1; }
here=$(cd "$(dirname "$0")" && pwd)
state=$(mktemp -d)
real_flock=$(command -v flock)
export real_flock
export state PATH="$state:$PATH"

cat > "$state/flock" <<'EOF'
#!/bin/sh
if ! "$real_flock" -n "$@"; then
    touch "$state/lock-busy-${ship:-single}"
    exec "$real_flock" "$@"
fi
EOF
cat > "$state/systemctl" <<'EOF'
#!/bin/sh
set -eu
[ "$1 $2 $3" = 'show --property=Job --value' ]
case "$4" in
    corten-site.service) ;;
    corten-site-bridge.service)
        if [ -f "$state/stop-job" ]; then
            echo 42
            echo wait-for-stop >> "$state/steps"
            rm "$state/stop-job" "$state/backup"
        fi
        ;;
    *) exit 1 ;;
esac
EOF
cat > "$state/sudo" <<'EOF'
#!/bin/sh
set -eu
[ "$1 $2" = "-n /usr/bin/systemctl" ]
case "$3 $4" in
    'restart corten-site-bridge.service')
        echo start-backup >> "$state/steps"
        [ ! -f "$state/denied-backup" ] || exit 1
        [ ! -f "$state/bad-backup" ] || exit 0
        touch "$state/backup"
        ;;
    'restart corten-site.service')
        echo restart-primary >> "$state/steps"
        if [ "${ship:-}" = B ]; then
            [ -f "$state/backup" ] || touch "$state/b-restarted-without-backup"
        fi
        rm -f "$state/primary"
        [ ! -f "$state/bad-primary" ] || exit 0
        touch "$state/primary"
        ;;
    'stop corten-site-bridge.service')
        echo stop-backup >> "$state/steps"
        if [ "${ship:-}" = A ]; then
            touch "$state/a-stopping"
            read -r _ < "$state/stop-gate"
        fi
        rm -f "$state/backup"
        ;;
    *) exit 1 ;;
esac
EOF
cat > "$state/curl" <<'EOF'
#!/bin/sh
for arg; do last=$arg; done
case "$last" in
    http://127.0.0.1:3000/health/ready)
        [ -f "$state/primary" ] && echo ready-primary >> "$state/steps" ;;
    http://127.0.0.1:3001/health/ready)
        [ "${ship:-}" != B ] || touch "$state/b-probed"
        [ -f "$state/backup" ] && echo ready-backup >> "$state/steps" ;;
    *) exit 1 ;;
esac
EOF
cat > "$state/sleep" <<'EOF'
#!/bin/sh
if [ "$1" = 3 ]; then
    echo wait-for-nginx >> "$state/steps"
    if [ -f "$state/fail-after-ready" ]; then rm -f "$state/primary"; fi
fi
EOF
chmod +x "$state/flock" "$state/systemctl" "$state/sudo" "$state/curl" "$state/sleep"

a=$root/releases/a b=$root/releases/b
mkdir -p "$a" "$b"
touch "$a/corten-site" "$b/corten-site"
chmod +x "$a/corten-site" "$b/corten-site"
serve() { : > "$state/steps"; sh "$here/release.sh" serve "$1"; }
steps() { printf '%s\n' "$@" | diff - "$state/steps"; }
current() { [ "$(readlink "$root/current")" = "$1" ]; }
not_served() { if serve "$1"; then echo "unexpectedly served $1" >&2; exit 1; fi; }

serve "$a"
steps restart-primary ready-primary
current "$a"
echo "ok: first deploy needs no backup"

touch "$state/bad-backup"
not_served "$b"
steps start-backup stop-backup ready-primary
current "$a"
rm "$state/bad-backup"
echo "ok: a backup that never becomes ready leaves the primary alone"

touch "$state/bad-primary"
not_served "$b"
steps start-backup ready-backup restart-primary
current "$b"
[ "$(readlink "$root/bridge")" = "$b" ]
rm "$state/bad-primary"
echo "ok: an unready primary leaves the backup up"

: > "$state/steps"
sh "$here/release.sh" restore "$a" "$b"
steps ready-backup restart-primary ready-primary wait-for-nginx ready-primary stop-backup
current "$a"
[ ! -L "$root/bridge" ]
echo "ok: put-back uses the answering backup until the primary is ready"

serve "$b"
steps start-backup ready-backup restart-primary ready-primary wait-for-nginx ready-primary stop-backup
current "$b"
[ ! -L "$root/bridge" ]
echo "ok: ordinary deploy readies the backup first and stops it last"

# Even if sudo will not start the bridge, the previous binary can still recover port 3000.
rm "$state/primary"
touch "$state/denied-backup"
: > "$state/steps"
sh "$here/release.sh" restore "$a" "$b"
steps start-backup stop-backup restart-primary ready-primary
current "$a"
[ ! -L "$root/bridge" ]
rm "$state/denied-backup"
echo "ok: a down primary recovers even if the backup cannot start"

: > "$state/steps"
if sh "$here/release.sh" restore "$b" "$root/releases/superseded"; then
    echo "a stale put-back switched the primary" >&2
    exit 1
fi
[ ! -s "$state/steps" ]
current "$a"
echo "ok: a stale put-back leaves a different release alone"

# An interrupted systemctl client can leave a stop job running while the bridge still answers.
ln -s "$a" "$root/bridge"
touch "$state/backup" "$state/stop-job"
serve "$b"
steps wait-for-stop start-backup ready-backup restart-primary ready-primary wait-for-nginx ready-primary stop-backup
current "$b"
[ ! -L "$root/bridge" ]
echo "ok: a queued stop settles before the next ship checks the backup"

wait_for() {
    for _ in $(seq 1 200); do
        [ ! -f "$1" ] || return 0
        /bin/sleep 0.01
    done
    echo "did not see $1" >&2
    return 1
}

# Hold A just before it stops the live bridge, then start B. B must not probe that bridge.
mkfifo "$state/stop-gate"
exec 8<> "$state/stop-gate"
: > "$state/steps"
ship=A sh "$here/release.sh" serve "$a" &
first=$!
wait_for "$state/a-stopping"
ship=B sh "$here/release.sh" serve "$b" &
second=$!
blocked=0
if wait_for "$state/lock-busy-B"; then
    [ ! -f "$state/b-probed" ] && blocked=1
fi
echo go >&8
wait "$first"
wait "$second"
[ "$blocked" = 1 ]
[ ! -f "$state/b-restarted-without-backup" ]
steps start-backup ready-backup restart-primary ready-primary wait-for-nginx ready-primary stop-backup \
    start-backup ready-backup restart-primary ready-primary wait-for-nginx ready-primary stop-backup
current "$b"
[ ! -L "$root/bridge" ]
echo "ok: an overlapping ship waits, then starts its own backup"

mkdir "$root/releases/uploading" "$root/releases/abandoned"
touch -d '1 hour ago' "$root/releases/abandoned"
sh "$here/release.sh" prune
[ -d "$root/releases/uploading" ]
[ ! -e "$root/releases/abandoned" ]
echo "ok: pruning leaves an ongoing upload and removes an abandoned one"

touch "$state/fail-after-ready"
not_served "$a"
steps start-backup ready-backup restart-primary ready-primary wait-for-nginx
[ -f "$state/backup" ]
[ "$(readlink "$root/bridge")" = "$a" ]
echo "ok: the backup stays if the primary fails while nginx can still be skipping it"
