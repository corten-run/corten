#!/bin/sh
# Runs as root on a machine made by main.tf, and is the one command the handover key may run
# there: boot.sh installs it as /usr/local/sbin/corten-site-handover, makes the user
# `handover` that the key signs in as, and lets that user run this with one of three words
# through sudo. The workflow that makes a machine holds that key, and carries what the machine
# before it serves with to the new one (relay.sh), so the new one serves before the address
# moves to it. The word says which end this machine is:
#   ask    says that this machine hands over
#   give   writes the certificates and the release being served to its output, as a gzipped tar
#   take   reads that tar and keeps it for boot.sh, on a machine that is not set up yet
set -eu

domain=''
. /root/deploy/site.conf
# Where boot.sh looks for what was handed over.
handed=/var/lib/corten-site-handover

case ${1:-} in
ask)
    echo corten-site-handover
    ;;
give)
    served=$(readlink -f /opt/corten-site/current || true)
    name=${served##*/}
    # A release's name is the deploy user's to choose, and it is root's tar that reads it
    # here: one that tar would take for an option, or that would lie beside certbot's
    # directory in what is sent (`etc`), is not carried. boot.sh refuses the same names.
    case $name in
    '' | etc | *[!A-Za-z0-9._-]* | [!A-Za-z0-9]*)
        echo "the release served here has a name the handover does not carry" >&2
        exit 1
        ;;
    esac
    [ "$served" = "/opt/corten-site/releases/$name" ] || { echo "no release is served here" >&2; exit 1; }
    [ -e "/etc/letsencrypt/live/$domain/fullchain.pem" ] || { echo "no certificate for $domain here" >&2; exit 1; }
    # From inside the releases' directory, which is the deploy user's to rename: what is
    # read is the directory this is in, whatever its path leads to afterwards.
    cd /opt/corten-site/releases
    [ "$(pwd -P)" = /opt/corten-site/releases ] || { echo "no release is served here" >&2; exit 1; }
    # The release under its own directory's name, and certbot's whole directory: the
    # certificate and its key, and the account and the settings it renews with. Not cli.ini,
    # which is the certbot package's own file: left for the package to write, since apt stops
    # to ask about one that is there already and differs. As gzip, which ends with a count of
    # what it held: a tar cut short between two files reads as a whole one.
    tar -czf - --anchored --exclude=etc/letsencrypt/cli.ini "$name" -C / etc/letsencrypt
    ;;
take)
    # A machine that serves already has a certificate of its own, and a deploy's releases.
    [ ! -e /var/lib/corten-site-boot.site ] || { echo "this machine is set up already" >&2; exit 1; }
    rm -rf "$handed.new"
    # What a try that fails got as far as writing holds part of the certificate's key.
    trap 'rm -rf "$handed.new"' EXIT
    install -d -m 700 "$handed.new"
    # Owned by root here whoever owned it there: the deploy user is not made yet. One that
    # was cut short on the way fails here, and nothing is kept.
    tar -xzf - -C "$handed.new" --no-same-owner
    [ -e "$handed.new/etc/letsencrypt/live/$domain/fullchain.pem" ] || { echo "no certificate for $domain in what was sent" >&2; exit 1; }
    # In place whole or not at all: boot.sh goes on as soon as the directory is there.
    rm -rf "$handed"
    mv "$handed.new" "$handed"
    ;;
*)
    echo "usage: ask | give | take" >&2
    exit 2
    ;;
esac
