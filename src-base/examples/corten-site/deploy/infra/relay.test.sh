#!/bin/bash
# What relay.sh decides from what two machines and the site answer, run as root in a container
# by the Site machine workflow's check and never on a machine: it installs sshd, makes a user
# and starts an sshd for the machine that serves and one for the new machine.
#   docker run --rm -v "$PWD/examples/corten-site/deploy:/deploy:ro" ubuntu:24.04 bash /deploy/infra/relay.test.sh
# ssh and sshd are the real ones. The command the key runs on a machine is a stand-in
# (handover.test.sh runs the real one), and so is curl. The relay's waits do not pass here:
# its `sleep` moves its clock on instead, so its ten and twenty-five minutes run out at once.
set -euo pipefail

[ -e /.dockerenv ] || { echo "run this in a container: it installs sshd, makes a user and starts two sshds" >&2; exit 1; }
here=$(cd "$(dirname "$0")" && pwd)
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq > /dev/null
apt-get install -y -qq --no-install-recommends openssh-server openssh-client > /dev/null

t=/test
install -d "$t" "$t/bin" "$t/tmp" /run/sshd
# A machine's state, which its side of the handover writes as the user the key signs in as.
install -d -m 777 "$t/old" "$t/new"
useradd --create-home --shell /bin/sh handover
usermod -p '*' handover
for each in host other-host key other-key; do
    ssh-keygen -q -t ed25519 -N '' -f "$t/$each"
done
# The machine that serves is the one at the site's name; the new one is known by its address.
echo "127.0.0.2 site.test" >> /etc/hosts
new=127.0.0.3

# handover.sh's part: machine <old|new> <the word the key asked with>. As many asks as the
# machine's file `ask-after` says end as a connection that drops does, and its file
# `ask-says` is what it answers in place of the word.
cat > "$t/machine" << 'EOF'
#!/bin/sh
at=/test/$1
case $2 in
ask)
    after=$(cat "$at/ask-after" 2> /dev/null || echo 0)
    if [ "$after" -gt 0 ]; then
        echo $((after - 1)) > "$at/ask-after"
        exit 255
    fi
    cat "$at/ask-says" 2> /dev/null || echo corten-site-handover
    ;;
give)
    cat "$at/gives"
    exit "$(cat "$at/give-ends")"
    ;;
take)
    [ ! -e "$at/set-up" ] || { echo "this machine is set up already" >&2; exit 1; }
    cat > "$at/taking"
    grep -q 'the end' "$at/taking" || { rm -f "$at/taking"; echo "what was sent is cut short" >&2; exit 2; }
    mv "$at/taking" "$at/taken"
    [ ! -e "$at/serves-once-taken" ] || touch "$at/serves"
    ;;
*) exit 2 ;;
esac
EOF
# The site as the relay asks it: at the new machine where --resolve names it, and at the old
# one otherwise. It answers where the machine has a file `serves`, after as many asks as its
# file `serves-after` says go unanswered first, with the site's page or the machine's file
# `page`.
cat > "$t/bin/curl" << 'EOF'
#!/bin/sh
at=old
for each in "$@"; do
    case $each in *:443:127.0.0.3) at=new ;; esac
done
after=$(cat "/test/$at/serves-after" 2> /dev/null || echo 0)
if [ "$after" -gt 0 ]; then
    echo $((after - 1)) > "/test/$at/serves-after"
    exit 7
fi
[ -e "/test/$at/serves" ] || exit 7
cat "/test/$at/page" 2> /dev/null || echo "<p>built from abc123def456</p>"
EOF
chmod 755 "$t/machine" "$t/bin/curl"

# lets_in <old|new> <a public key>: the one key that machine lets run its command.
lets_in() {
    printf 'restrict,command="/test/machine %s \\"$SSH_ORIGINAL_COMMAND\\"" %s\n' "$1" "$(cat "$2")" > "$t/keys-$1"
}
# starts <old|new> <its address> [<its host key>]
starts() {
    cat > "$t/sshd-$1" << EOF
ListenAddress $2
HostKey ${3:-$t/host}
PidFile $t/$1.pid
AuthorizedKeysFile $t/keys-$1
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM no
EOF
    /usr/sbin/sshd -f "$t/sshd-$1" -E "$t/$1.log"
    waits "the $1 machine's sshd to start" test -s "$t/$1.pid"
}
# sshd removes the file that holds its number as it ends; the number itself stays in use
# here, where nothing takes an ended sshd away.
stops() {
    kill "$(cat "$t/$1.pid")"
    waits "the $1 machine's sshd to stop" test ! -e "$t/$1.pid"
}
# waits <for what> <a command that succeeds when it is so>: ten seconds, and then the test
# ends with what the sshds wrote, since one that cannot start says so only there.
waits() {
    local what=$1 tries
    shift
    for ((tries = 0; tries < 100; tries++)); do
        if "$@"; then return 0; fi
        sleep 0.1
    done
    echo "FAILS waiting ten seconds for $what"
    cat "$t"/*.log
    exit 1
}
# drops <old|new> <how often>: that machine's next asks end as a dropped connection does.
drops() {
    echo "$2" > "$t/$1/ask-after"
    chmod 666 "$t/$1/ask-after"
}

# Two machines as a replacement finds them when all is well: the old one serves and gives,
# the new one takes and then serves, and each lets the handover key in.
fresh() {
    rm -rf "$t/old" "$t/new"
    install -d -m 777 "$t/old" "$t/new"
    printf 'a certificate and a release\nthe end\n' > "$t/old/gives"
    echo 0 > "$t/old/give-ends"
    touch "$t/old/serves" "$t/new/serves-once-taken"
    lets_in old "$t/key.pub"
    lets_in new "$t/key.pub"
    key=$(cat "$t/key")
}
# The relay as the apply runs it, with a clock that `sleep` moves on. Five minutes for a run
# that takes a second, or half a minute where it signs in sixty times: one that waits for
# ever is a case that fails, not a job that hangs.
relay() {
    : > "$t/said"
    (
        sleep() { SECONDS=$((SECONDS + $1)); }
        export -f sleep
        PATH="$t/bin:$PATH" TMPDIR="$t/tmp" RELAY_SAID="$t/said" DOMAIN=site.test NEW=$new \
            HOST_KEY_PUBLIC="$(cat "$t/host.pub")" HANDOVER_KEY="$key" timeout 300 bash "$here/relay.sh"
    ) > "$t/out" 2>&1 && ended=0 || ended=$?
}

failed=0
# is <what is expected> <a command that succeeds when it is so>
is() {
    local what=$1
    shift
    if "$@" > /dev/null 2>&1; then
        echo "ok    $what"
    else
        echo "FAILS $what"
        sed 's/^/        /' "$t/out" "$t/said"
        failed=1
    fi
}
ended_with() { [ "$ended" = "$1" ]; }
# What the relay wrote for GitHub to show: said <notice|warning|error> <words of it>
said() { grep -q "^::$1::.*$2" "$t/said"; }
said_nothing() { [ ! -s "$t/said" ]; }
handed() { cmp -s "$t/old/gives" "$t/new/taken"; }
nothing_handed() { [ ! -e "$t/new/taken" ] && [ ! -e "$t/new/taking" ]; }
no_key_left() { [ -z "$(ls -A "$t/tmp")" ]; }

lets_in old "$t/key.pub"
lets_in new "$t/key.pub"
starts old 127.0.0.2
starts new "$new"

fresh
relay
is "a machine that serves hands over to a new one, which then serves: the relay ends well" ended_with 0
is "  the new one has what the old one gave" handed
is "  nothing is said as a notice, a warning or an error" said_nothing
is "  and no key is left on the runner" no_key_left

fresh
key=''
relay
is "with no key the address moves first: ends well" ended_with 0
is "  said as a notice" said notice "no handover key"
is "  nothing handed" nothing_handed

fresh
rm "$t/old/serves"
relay
is "with a site that does not answer the address moves first: ends well" ended_with 0
is "  said as a notice" said notice "does not answer as the site"
is "  nothing handed" nothing_handed

fresh
drops new 3
echo 3 > "$t/new/serves-after"
relay
is "a new machine that answers the key at the fourth ask, and as the site at the fourth: ends well" ended_with 0
is "  the new one has what the old one gave" handed
is "  nothing is said as a notice, a warning or an error" said_nothing

fresh
echo 11 > "$t/old/serves-after"
relay
is "a site that misses eleven asks and then answers is not taken for one that is down" ended_with 0
is "  and hands over" handed

fresh
echo 12 > "$t/old/serves-after"
relay
is "with a site that misses twelve asks the address moves first: ends well" ended_with 0
is "  said as a notice" said notice "does not answer as the site"
is "  nothing handed" nothing_handed

fresh
echo "<p>another page</p>" > "$t/old/page"
relay
is "with a name that answers with another page the address moves first: ends well" ended_with 0
is "  said as a notice" said notice "does not answer as the site"
is "  nothing handed" nothing_handed

fresh
drops old 2
relay
is "a serving machine that answers the key at the third ask hands over: ends well" ended_with 0
is "  the new one has what the old one gave" handed

fresh
echo another-word > "$t/old/ask-says"
relay
is "a serving machine that answers the key with another word keeps the address: the relay fails" ended_with 1
is "  said as an error, ssh having said nothing" said error "could not be asked over SSH.*: ssh said nothing\."
is "  nothing handed" nothing_handed

fresh
lets_in old "$t/other-key.pub"
relay
is "with a serving machine that refuses the key the address moves first: ends well" ended_with 0
is "  said as a warning" said warning "does not hand over"
is "  nothing handed" nothing_handed

fresh
key='not a key'
relay
is "a key ssh cannot read is not taken for a machine's refusal: the relay fails" ended_with 1
is "  said as an error" said error "not a private key ssh can read"
is "  nothing handed" nothing_handed
is "  and no key is left on the runner" no_key_left

fresh
stops old
relay
starts old 127.0.0.2
is "a serving machine whose sshd is not there keeps the address: the relay fails" ended_with 1
is "  said as an error, with what ssh said" said error "could not be asked over SSH.*Connection refused"
is "  nothing handed" nothing_handed
is "  and no key is left on the runner" no_key_left

fresh
stops old
starts old 127.0.0.2 "$t/other-host"
relay
stops old
starts old 127.0.0.2
is "a serving machine with another host key keeps the address: the relay fails" ended_with 1
is "  said as an error, with what ssh said" said error "could not be asked over SSH.*Host key verification failed"
is "  nothing handed" nothing_handed

fresh
stops new
relay
starts new "$new"
is "a new machine whose sshd is not there: the relay fails" ended_with 1
is "  said as an error, with what ssh said" said error "did not take the handover key within ten minutes.*Connection refused"
is "  nothing handed" nothing_handed

fresh
lets_in new "$t/other-key.pub"
relay
is "a new machine that refuses the key: the relay fails" ended_with 1
is "  said as an error, with what ssh said" said error "did not take the handover key within ten minutes.*Permission denied"
is "  nothing handed" nothing_handed

fresh
echo 1 > "$t/old/give-ends"
relay
is "a give that ends badly having sent all of it: the relay goes on and ends well" ended_with 0
is "  the new one has what the old one gave" handed

fresh
echo "cut short" > "$t/old/gives"
relay
is "a give the new machine does not keep: the relay fails" ended_with 1
is "  said as an error" said error "did not reach the new machine"
is "  nothing handed" nothing_handed

fresh
touch "$t/new/set-up" "$t/new/serves"
relay
is "a new machine that serves already, as after a run that failed: ends well" ended_with 0
is "  nothing handed a second time" nothing_handed
is "  nothing is said as a notice, a warning or an error" said_nothing

fresh
touch "$t/new/set-up" "$t/new/serves"
echo 2 > "$t/new/serves-after"
relay
is "a new machine that is set up and misses two asks: ends well" ended_with 0
is "  nothing handed a second time" nothing_handed

fresh
touch "$t/new/set-up"
relay
is "a new machine that is set up and does not serve: the relay fails" ended_with 1
is "  said as an error that names the way out" said error "did not reach the new machine.*replace=true"

fresh
rm "$t/new/serves-once-taken"
relay
is "a new machine that takes everything and never serves: the relay fails" ended_with 1
is "  said as an error" said error "within twenty-five minutes"
is "  having been handed everything" handed
is "  and no key is left on the runner" no_key_left

stops old
stops new
[ "$failed" = 0 ] || exit 1
echo "relay.sh hands over, moves the address first and fails as it says"
