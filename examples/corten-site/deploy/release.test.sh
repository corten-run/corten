#!/bin/sh
# Exercise release ordering with stand-ins for systemctl and the instance readiness probes.
set -eu

root=/opt/corten-site
[ -e /.dockerenv ] && [ ! -e "$root" ] || { echo "run in a fresh container" >&2; exit 1; }
here=$(cd "$(dirname "$0")" && pwd)
state=$(mktemp -d)
export state PATH="$state:$PATH"

cat > "$state/sudo" <<'EOF'
#!/bin/sh
set -eu
[ "$1 $2" = "-n /usr/bin/systemctl" ]
case "$3 $4" in
    'restart corten-site-bridge.service')
        echo start-backup >> "$state/steps"
        [ ! -f "$state/bad-backup" ] || exit 0
        touch "$state/backup"
        ;;
    'restart corten-site.service')
        echo restart-primary >> "$state/steps"
        rm -f "$state/primary"
        [ ! -f "$state/bad-primary" ] || exit 0
        touch "$state/primary"
        ;;
    'stop corten-site-bridge.service')
        echo stop-backup >> "$state/steps"
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
        [ -f "$state/backup" ] && echo ready-backup >> "$state/steps" ;;
    *) exit 1 ;;
esac
EOF
printf '#!/bin/sh\nexit 0\n' > "$state/sleep"
chmod +x "$state/sudo" "$state/curl" "$state/sleep"

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
steps start-backup stop-backup
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

serve "$a"
steps ready-backup restart-primary ready-primary stop-backup
current "$a"
[ ! -L "$root/bridge" ]
echo "ok: put-back uses the answering backup until the primary is ready"

serve "$b"
steps start-backup ready-backup restart-primary ready-primary stop-backup
current "$b"
[ ! -L "$root/bridge" ]
echo "ok: ordinary deploy readies the backup first and stops it last"
