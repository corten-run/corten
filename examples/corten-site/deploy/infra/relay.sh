#!/bin/bash
# Run by `tofu apply`, where it is applied, once a new droplet exists and before the address
# moves to it (main.tf): carries the certificate and the release being served from the machine
# at the site's name to the new one, and waits until the new one answers as the site. The
# address then moves to a machine that already serves, and the old one is removed after that.
# Ending with a failure fails the apply before the address moves, and the old machine goes on
# serving; the next apply runs this again for the same new machine.
#
# Read from the environment: DOMAIN (the site's name), NEW (the new droplet's own address),
# HOST_KEY_PUBLIC (the host key both machines have) and HANDOVER_KEY (the private half of the
# key both let run handover.sh; with none, nothing is carried). What a run should not be
# missed for is also written to the file RELAY_SAID names, as a line GitHub reads as a
# warning or an error: under `tofu apply` each line printed here follows the resource's name,
# and GitHub reads such a line only from its start.
set -euo pipefail

: "${DOMAIN:?the site name}" "${NEW:?the new machine address}" "${HOST_KEY_PUBLIC:?the machines host key}"

# say <notice|warning|error|''> <text>
say() {
    echo "$2"
    if [ -n "$1" ] && [ -n "${RELAY_SAID:-}" ]; then echo "::$1::$2" >> "$RELAY_SAID"; fi
}
# The page names the commit it was built from; any other answer is not the site. Asked at the
# site's name, so the certificate is checked as a browser checks it. Read whole, then searched.
serves() {
    local got
    got=$(curl -fsS --max-time 10 "$@" "https://$DOMAIN/" 2>/dev/null) || return 1
    grep -q 'built from' <<< "$got"
}
# asks <how often> <command>: asked five seconds apart until it is so.
asks() {
    local often=$1 tries
    shift
    for ((tries = 0; tries < often; tries++)); do
        if "$@"; then return 0; fi
        sleep 5
    done
    return 1
}
# One refusal may be the network's, or a deploy's restart.
thrice() { asks 3 "$@"; }
moves_first() {
    say "$1" "$2 The address moves to the new machine first, and the site is away until that machine has a certificate and a release of its own."
    exit 0
}

if [ -z "${HANDOVER_KEY:-}" ]; then
    moves_first notice "There is no handover key (SITE_HANDOVER_KEY, deploy/README.md), or this run was told to go without it."
fi
# Nothing to keep serving: the first machine, or a site that is down already. Asked for a
# minute and more, since what is decided is whether the site goes away: a deploy that failed
# and is being put back, or a network that drops a few requests, is not a site that is down.
if ! asks 12 serves; then
    moves_first notice "https://$DOMAIN/ does not answer as the site now, asked twelve times."
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
(umask 077 && printf '%s\n' "$HANDOVER_KEY" > "$work/key")
# A key ssh cannot read is refused by every machine, as a key the machine does not know is,
# and that one would move the address first.
if ! ssh-keygen -y -P '' -f "$work/key" > /dev/null 2>&1; then
    say error "The handover key (SITE_HANDOVER_KEY) is not a private key ssh can read. The address has not moved, and the old machine serves. Make the key again (deploy/README.md)."
    exit 1
fi
host=$(cut -d' ' -f1-2 <<< "$HOST_KEY_PUBLIC")
printf '%s %s\n' "$DOMAIN" "$host" "$NEW" "$host" > "$work/known_hosts"
# A machine that stops answering ends the connection within the minute, as in the Site
# workflow's ship step.
machine() {
    local at=$1
    shift
    ssh -i "$work/key" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=10 \
        -o ServerAliveInterval=5 -o ServerAliveCountMax=3 \
        -o UserKnownHostsFile="$work/known_hosts" -o StrictHostKeyChecking=yes "handover@$at" "$@"
}
# What a machine says when it is asked whether it hands over: `yes`; `no` where it does not
# let the key in, as one made before there was a handover or with another key; and `away`
# where it could not be asked.
asked() {
    local said
    if said=$(machine "$1" ask < /dev/null 2> "$work/refusal") && [ "$said" = corten-site-handover ]; then
        echo yes
    elif grep -q 'Permission denied' "$work/refusal"; then
        echo no
    else
        echo away
    fi
}
hands_over() { [ "$(asked "$1")" = yes ]; }
# What ssh said last when a machine was asked, as one line: a host key that is not the one
# given, or a key the machine does not know, is told by it from a machine that did not answer.
ssh_said() {
    local last
    last=$(tail -n 1 "$work/refusal" | tr -d '\r' | cut -c1-200)
    last=${last%.}
    echo "${last:-ssh said nothing}"
}

# A machine that refuses the key hands nothing over, and the address moves first. One that
# could not be asked is another matter: it serves, so the address stays with it, and whoever
# keeps its sshd busy for these seconds does not take the site away.
old=away
for _ in 1 2 3; do
    old=$(asked "$DOMAIN")
    [ "$old" = away ] || break
    sleep 5
done
if [ "$old" = no ]; then
    moves_first warning "The machine serving $DOMAIN does not hand over what it serves with."
elif [ "$old" = away ]; then
    say error "The machine serving $DOMAIN could not be asked over SSH whether it hands over, in three tries: $(ssh_said). The address has not moved, and that machine goes on serving. Run the workflow again; where it never answers, or its host key is not the one given, a new machine that is handed nothing takes its place (deploy/README.md)."
    exit 1
fi

# The new machine takes the key as its first step, before it installs anything: ten minutes
# for it to start.
ends=$((SECONDS + 600))
until hands_over "$NEW"; do
    if [ "$SECONDS" -ge "$ends" ]; then
        say error "The new machine at $NEW did not take the handover key within ten minutes: $(ssh_said). The address has not moved, and the old machine serves. Run the workflow again; where it refuses the key or shows another host key again, the keys the machine was made with are not the ones this run holds (deploy/README.md)."
        exit 1
    fi
    sleep 10
done

# A run after one that failed further on finds the new machine set up already.
if ! serves --resolve "$DOMAIN:443:$NEW"; then
    # From one machine to the other through this one's memory: never a file here.
    # What counts is whether the new machine kept it, and it keeps only a whole one with a
    # certificate and a release in it: tar on the old machine may end badly having sent all
    # of it, as when a file changed while it was read.
    ended=(0 0)
    machine "$DOMAIN" give < /dev/null | machine "$NEW" take || ended=("${PIPESTATUS[@]}")
    if [ "${ended[1]}" = 0 ]; then
        echo "The new machine at $NEW has the certificate and the release $DOMAIN is served with."
    # A machine that is set up already takes nothing: one that an earlier run handed
    # everything, and that did not answer the one question above.
    elif ! thrice serves --resolve "$DOMAIN:443:$NEW"; then
        say error "What $DOMAIN is served with did not reach the new machine at $NEW: the lines above say which end refused. The address has not moved, and the old machine serves. Run the workflow again; a new machine that says it is set up already and does not serve is replaced by another that is handed the same (-f replace=true, deploy/README.md)."
        exit 1
    fi
    # Twenty-five minutes: a step that fails on the new machine (a package mirror out of
    # reach) is tried again a quarter of an hour later, and that try is waited for.
    ends=$((SECONDS + 1500))
    until serves --resolve "$DOMAIN:443:$NEW"; do
        if [ "$SECONDS" -ge "$ends" ]; then
            say error "The new machine at $NEW did not answer as https://$DOMAIN/ within twenty-five minutes of taking what the old one serves with. The address has not moved, and the old machine serves. Run the workflow again: it asks the same machine once more. A machine that cannot set itself up from what it was handed is replaced by one that is handed nothing (deploy/README.md)."
            exit 1
        fi
        sleep 10
    done
fi
echo "The new machine at $NEW answers as https://$DOMAIN/: the address moves to it now."
