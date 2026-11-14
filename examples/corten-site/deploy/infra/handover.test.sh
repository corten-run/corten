#!/bin/sh
# What handover.sh gives, takes and refuses, run as root in a container by the Site machine
# workflow's check and never on a machine: it writes under /etc, /opt, /root and /var/lib.
#   docker run --rm -v "$PWD/examples/corten-site/deploy:/deploy:ro" ubuntu:24.04 sh /deploy/infra/handover.test.sh
# The name of a release is the deploy user's to choose and root's tar reads it, so most of
# what is here is a name that must not be carried.
set -eu

[ -e /.dockerenv ] || { echo "run this in a container: it writes under /etc, /opt, /root and /var/lib" >&2; exit 1; }
handover() { sh "$(dirname "$0")/handover.sh" "$@"; }
handed=/var/lib/corten-site-handover
releases=/opt/corten-site/releases
certificate=/etc/letsencrypt/live/site.test/fullchain.pem

install -d /root/deploy "$releases" "${certificate%/*}"
printf "domain='site.test'\n" > /root/deploy/site.conf
echo certificate > "$certificate"
echo "the package's" > /etc/letsencrypt/cli.ini
release() {
    install -d -- "$releases/$1"
    printf '#!/bin/sh\n' > "$releases/$1/corten-site"
    chmod 755 "$releases/$1/corten-site"
}
serve() { ln -sfn "$1" /opt/corten-site/current; }

failed=0
# is <what is expected> <a command that succeeds when it is so>
is() {
    what=$1
    shift
    if "$@" > /dev/null 2>&1; then echo "ok    $what"; else echo "FAILS $what"; failed=1; fi
}
status() {
    expected=$1
    shift
    "$@" > /tmp/out 2> /tmp/said && got=0 || got=$?
    [ "$got" = "$expected" ]
}
nothing_sent() { [ ! -s /tmp/out ] && [ -e "$certificate" ] && [ ! -e "$releases/tmp-ran" ]; }
nothing_kept() { [ ! -e "$handed" ] && [ ! -e "$handed.new" ]; }
sent() { tar -tzf /tmp/given | grep -qx "$1"; }

is "ask says that this machine hands over" [ "$(handover ask)" = corten-site-handover ]
is "no word is refused" status 2 handover
is "another word is refused" status 2 handover "give; id"

# A release as a deploy names it, with what a deploy could leave in one.
good=abc123def456-7-1
release "$good"
install -d "$releases/$good/etc/letsencrypt"
echo "the release's own" > "$releases/$good/etc/letsencrypt/cli.ini"
cp /bin/true "$releases/$good/runs-as-owner"
chmod 4755 "$releases/$good/runs-as-owner"
ln -s /etc/shadow "$releases/$good/link"
serve "$releases/$good"
is "give sends the release that is served" status 0 handover give
cp /tmp/out /tmp/given
is "  with the certificate" sent etc/letsencrypt/live/site.test/fullchain.pem
is "  and the release" sent "$good/corten-site"
is "  without the certbot package's cli.ini" [ "$(tar -tzf /tmp/given | grep -cx etc/letsencrypt/cli.ini)" = 0 ]
is "  but with a file of that name in the release" sent "$good/etc/letsencrypt/cli.ini"
is "  and a link as a link, not what it points at" [ "$(tar -tvzf /tmp/given | grep -c "^l.* $good/link -> /etc/shadow")" = 1 ]

for name in etc --remove-files --checkpoint=1 '--checkpoint-action=exec=touch${IFS}tmp-ran' -x .hidden 'a b' 'a;b'; do
    release "$name"
    serve "$releases/$name"
    is "give refuses a release named [$name]" status 1 handover give
    is "  sending nothing, running nothing, the certificate still there" nothing_sent
done
release outer/inner
serve "$releases/outer/inner"
is "give refuses a release inside another" status 1 handover give
serve /etc/letsencrypt
is "give refuses what is not a release" status 1 handover give
is "  sending nothing" nothing_sent
serve "$releases/gone-1-1"
is "give fails for a release that is not there" status 2 handover give
cp /tmp/out /tmp/no-release
mv "$certificate" /tmp/certificate
serve "$releases/$good"
is "give refuses where there is no certificate" status 1 handover give
mv /tmp/certificate "$certificate"

is "take keeps what give sent" status 0 handover take < /tmp/given
is "  the certificate" [ -e "$handed/etc/letsencrypt/live/site.test/fullchain.pem" ]
is "  and the release" [ -x "$handed/$good/corten-site" ]
is "  with no file that runs as its owner" [ "$(find "$handed" -perm /6000 | wc -l)" = 0 ]
is "  and nothing half written" [ ! -e "$handed.new" ]
rm -rf "$handed"
head -c "$(($(wc -c < /tmp/given) / 2))" /tmp/given > /tmp/half
is "take refuses half of it" status 2 handover take < /tmp/half
is "  keeping nothing" nothing_kept
head -c "$(($(wc -c < /tmp/given) - 1))" /tmp/given > /tmp/short
is "take refuses all but its last byte" status 2 handover take < /tmp/short
is "  keeping nothing" nothing_kept
is "take refuses a certificate with no release" status 1 handover take < /tmp/no-release
is "  keeping nothing" nothing_kept
install -d /tmp/linked/etc/letsencrypt/live/site.test
echo certificate > /tmp/linked/etc/letsencrypt/live/site.test/fullchain.pem
ln -s /bin /tmp/linked/abc
ln -s true /bin/corten-site
tar -czf /tmp/linked.tgz -C /tmp/linked etc abc
is "take refuses a release that is a link" status 1 handover take < /tmp/linked.tgz
is "  keeping nothing" nothing_kept
touch /var/lib/corten-site-boot.site
is "take is refused on a machine that is set up" status 1 handover take < /tmp/given
is "  keeping nothing" nothing_kept

[ "$failed" = 0 ] || exit 1
echo "handover.sh gives, takes and refuses as it says"
