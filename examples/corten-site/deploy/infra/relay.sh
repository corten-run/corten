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
# Three times, five seconds apart: one refusal may be the network's, or a deploy's restart.
thrice() {
    local _
    for _ in 1 2 3; do
        if "$@"; then return 0; fi
        sleep 5
    done
    return 1
}
moves_first() {
    say "$1" "$2 The address moves to the new machine first, and the site is away until that machine has a certificate and a release of its own."
    exit 0
}

if [ -z "${HANDOVER_KEY:-}" ]; then
    moves_first notice "There is no handover key (SITE_HANDOVER_KEY, deploy/README.md), or this run was told to go without it."
fi
# Nothing to keep serving: the first machine, or a site that is down already.
if ! thrice serves; then
    moves_first '' "https://$DOMAIN/ does not answer as the site now."
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
printf '%s\n' "$HANDOVER_KEY" > "$work/key"
chmod 600 "$work/key"
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
hands_over() { [ "$(machine "$1" ask < /dev/null 2>/dev/null || true)" = corten-site-handover ]; }

# The machine serving now may have been made before there was a handover, or with another key.
if ! thrice hands_over "$DOMAIN"; then
    moves_first warning "The machine serving $DOMAIN does not hand over what it serves with."
fi

# The new machine takes the key as its first step, before it installs anything: ten minutes
# for it to start.
ends=$((SECONDS + 600))
until hands_over "$NEW"; do
    if [ "$SECONDS" -ge "$ends" ]; then
        say error "The new machine at $NEW did not take the handover key within ten minutes. The address has not moved, and the old machine serves. Run the workflow again."
        exit 1
    fi
    sleep 10
done

# A run after one that failed further on finds the new machine set up already.
if ! serves --resolve "$DOMAIN:443:$NEW"; then
    # From one machine to the other through this one's memory: never a file here.
    machine "$DOMAIN" give < /dev/null | machine "$NEW" take
    echo "The new machine at $NEW has the certificate and the release $DOMAIN is served with."
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
