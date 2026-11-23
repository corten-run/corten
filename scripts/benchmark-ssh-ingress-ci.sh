#!/bin/bash
# Local SSH clients, listener and nftables, all inside disposable namespaces.
set -euo pipefail
test "$#" = 1
test -x /usr/sbin/nft
test -x /usr/sbin/sshd
test -x /usr/lib/openssh/sftp-server
timeout -k 5 60 unshare --mount --net --pid --fork --kill-child --mount-proc /bin/bash -s -- "$1" <<'FIXTURE'
set -euo pipefail
export LC_ALL=C
umask 077
mount -t tmpfs -o mode=0755 tmpfs /run
mkdir -m 0755 /run/sshd
work=$(mktemp -d /run/corten-ingress-test.XXXXXXXX)
ip link set lo up

# Use only ephemeral keys and a test-only, unlocked account record. Never
# change the runner's root account, read its keys, or start its SSH service.
printf 'root:x:20000:0:99999:7:::\n' > "$work/shadow"
mount --bind "$work/shadow" /etc/shadow
ssh-keygen -q -t ed25519 -N '' -f "$work/host"
ssh-keygen -q -t ed25519 -N '' -f "$work/client"
printf '127.0.0.1,::1 %s\n' "$(cut -d ' ' -f 1,2 "$work/host.pub")" > "$work/known_hosts"
cat > "$work/sshd_config" <<EOF
Port 22
ListenAddress 127.0.0.1
ListenAddress ::1
HostKey $work/host
AuthorizedKeysFile $work/client.pub
PidFile $work/sshd.pid
PermitRootLogin prohibit-password
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM no
LogLevel DEBUG1
Subsystem sftp /usr/lib/openssh/sftp-server
EOF
/usr/sbin/sshd -D -E "$work/sshd.log" -f "$work/sshd_config" </dev/null &
listener=$!
for attempt in {1..50}; do
  kill -0 "$listener"
  if grep -Fq 'Server listening on 127.0.0.1 port 22.' "$work/sshd.log" &&
     grep -Fq 'Server listening on ::1 port 22.' "$work/sshd.log"; then break; fi
  sleep .1
done

opts=(-F none -i "$work/client" -oIdentityAgent=none -oIdentitiesOnly=yes -oBatchMode=yes
      -oGlobalKnownHostsFile=none -oStrictHostKeyChecking=yes -oUserKnownHostsFile="$work/known_hosts" -oConnectTimeout=2)
owner() { ssh "${opts[@]}" -b 127.0.0.2 root@127.0.0.1 "$@"; }
foreign4() { ssh "${opts[@]}" -n -b 127.0.0.3 root@127.0.0.1 true; }
foreign6() { ssh "${opts[@]}" -n -6 root@::1 true; }
forks() { grep -Fc 'Forked child ' "$work/sshd.log"; }

# First show each non-owner reaches this same listener without the policy.
foreign4
foreign6
test "$(forks)" -eq 2
"$1" --input-type=module -e 'import {captureSshOwner} from "./bench/workloads/cloud-contract.mjs"; console.log("set -euo pipefail\n" + captureSshOwner)' > "$work/capture"
"$1" --input-type=module -e 'import {installSshIngress} from "./bench/workloads/cloud-contract.mjs"; console.log("set -euo pipefail\n" + installSshIngress)' > "$work/install"
"$1" --input-type=module -e 'import {verifySshIngress} from "./bench/workloads/cloud-contract.mjs"; console.log("set -euo pipefail\n" + verifySshIngress)' > "$work/verify"
if env -u SSH_CONNECTION /bin/bash "$work/capture" 2>/dev/null; then exit 1; fi
if env -u SSH_CONNECTION /bin/bash "$work/install" 2>/dev/null; then exit 1; fi
test -z "$(/usr/sbin/nft list tables)"
owner /bin/bash -s < "$work/capture"
env -u SSH_CONNECTION /bin/bash "$work/install"
env -u SSH_CONNECTION /bin/bash "$work/verify"
test "$(forks)" -eq 3
for peer in foreign4 foreign6; do
  if "$peer" 2> "$work/refused"; then exit 1; fi
  grep -Fq 'Connection timed out' "$work/refused"
  test "$(forks)" -eq 3
done

# A new owner connection still runs a command, transfers terminal output over
# SFTP, and reconnects for cleanup without removing or widening the rule.
owner "printf '%s\n' terminal > '$work/result'" </dev/null
printf 'get %s %s\n' "$work/result" "$work/download" |
  sftp "${opts[@]}" -oBindAddress=127.0.0.2 -b - -s /usr/lib/openssh/sftp-server root@127.0.0.1
cmp "$work/result" "$work/download"
owner "rm -- '$work/result'" </dev/null
test ! -e "$work/result"
test "$(forks)" -eq 6
/bin/bash "$work/verify"

# Exercise the production offline phase rules against the real kernel ABI.
# A refused connection must not fork the listener or invalidate otherwise
# unchanged isolation; a modified policy is not the same observation.
"$1" --input-type=module -e 'import {offlineFenceRules} from "./bench/workloads/isolated/control-admission.mjs"; process.stdout.write(offlineFenceRules)' |
  /usr/sbin/nft -f -
sample() { /usr/sbin/nft -j -a list table inet corten_bench_native; }
window() {
  "$node" --input-type=module -e '
    import {readFileSync} from "node:fs";
    import {verifyOfflineWindow} from "./bench/workloads/isolated/control-admission.mjs";
    const [before, after] = process.argv.slice(1).map(p => JSON.parse(readFileSync(p)));
    verifyOfflineWindow({before, after});
  ' "$1" "$2"
}
node=$1
sample > "$work/before"
if owner true </dev/null 2>"$work/refused"; then exit 1; fi
grep -Fq 'Connection timed out' "$work/refused"
test "$(forks)" -eq 6
sample > "$work/after"
# Rule handles must remain stable; make sure this is not just two idle samples.
if cmp -s "$work/before" "$work/after"; then echo 'owner did not exercise the native fence' >&2; exit 1; fi
window "$work/before" "$work/after"
/usr/sbin/nft insert rule inet corten_bench_native input tcp dport 22 drop
sample > "$work/changed"
if window "$work/after" "$work/changed"; then echo 'accepted modified native fence' >&2; exit 1; fi
/usr/sbin/nft delete table inet corten_bench_native
owner true </dev/null
test "$(forks)" -eq 7

# A stricter rule still changes the verified policy, even though the table exists.
/usr/sbin/nft insert rule inet corten_bench_ssh input tcp dport 22 ip saddr 127.0.0.2 drop
/usr/sbin/nft list table inet corten_bench_ssh >/dev/null
if /bin/bash "$work/verify"; then echo 'accepted a modified SSH ingress table' >&2; exit 1; fi
/usr/sbin/nft delete table inet corten_bench_ssh
if /bin/bash "$work/verify" 2>/dev/null; then exit 1; fi
kill "$listener"
wait "$listener" || true
printf '%s\n' 'SSH ingress: IPv4 and IPv6 blocked before fork; owner reconnect, transfer and cleanup passed'
FIXTURE
