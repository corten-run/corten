#!/bin/sh
# What a machine made by main.tf runs as it first starts (corten-site-boot.service): it sets
# itself up with ../provision.sh, and then takes on the names that redirect to the site's. A
# machine that replaces another is handed that one's certificate and the release it serves
# (handover.sh), and serves with them before the address moves to it. One that is handed
# nothing waits until the site's name reaches it and asks for a certificate of its own; a
# name may not reach it for a while, its DNS still on its way.
set -eu

# Written by main.tf: the four it sets.
domain='' email='' machine='' redirects=''
. /root/deploy/site.conf

# First, so the workflow that made this machine can reach it while it installs: the handover
# key runs handover.sh as root and nothing else, on this machine as on the one before it. Its
# private half is the workflow's alone, and is not among what a machine is handed.
handed=/var/lib/corten-site-handover
if grep -q . /root/deploy/handover.pub 2>/dev/null; then
    install -m 755 /root/deploy/handover.sh /usr/local/sbin/corten-site-handover
    install -d -m 700 /root/.ssh
    touch /root/.ssh/authorized_keys
    chmod 600 /root/.ssh/authorized_keys
    sed -i '/corten-site-handover/d' /root/.ssh/authorized_keys
    sed 's|^|restrict,command="/usr/local/sbin/corten-site-handover" |' /root/deploy/handover.pub >> /root/.ssh/authorized_keys
fi

export DEBIAN_FRONTEND=noninteractive
# A machine's first minutes hold the package locks for its own updates. An install waits for its
# lock with this setting, here and in provision.sh; fetching the lists does not wait for theirs,
# so it is asked again.
echo 'DPkg::Lock::Timeout "600";' > /etc/apt/apt.conf.d/90corten-site-lock
tries=0
until apt-get update; do
    tries=$((tries + 1))
    [ "$tries" -lt 20 ] || exit 1
    sleep 15
done
apt-get install -y --no-install-recommends nginx curl openssl

# Two ways to know a name reaches this machine; either will do. A certificate asked for then
# is asked for by the machine the name reaches.
#
# One: a word only this machine knows, served where certbot's challenge will be (nginx as
# installed serves /var/www/html, and so does the site's own configuration under this path),
# comes back when it is asked for at the name.
word=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
install -d /var/www/html/.well-known/acme-challenge
printf '%s' "$word" > /var/www/html/.well-known/acme-challenge/corten-site-boot
systemctl start nginx
answers() {
    [ "$(curl -fsS --max-time 5 "http://$1/.well-known/acme-challenge/corten-site-boot" 2>/dev/null || true)" = "$word" ]
}

# Two: the name resolves to the reserved address that DigitalOcean's metadata says is on this
# machine now. A machine may not reach its own reserved address from inside, and then the first
# way alone would wait for ever. This way does not show that port 80 answers from outside, or
# that the name has no other address: where the certificate is then refused, the unit fails and
# is started again a quarter of an hour later.
metadata=http://169.254.169.254/metadata/v1/reserved_ip/ipv4
assigned() {
    [ "$(curl -fsS --max-time 5 "$metadata/active" 2>/dev/null || true)" = true ] || return 1
    address=$(curl -fsS --max-time 5 "$metadata/ip_address" 2>/dev/null || true)
    [ -n "$address" ] || return 1
    getent ahostsv4 "$1" | awk -v address="$address" '$1 == address { found = 1 } END { exit !found }'
}
wait_for() {
    until answers "$1" || assigned "$1"; do
        echo "waiting for $1 to reach this machine"
        sleep 30
    done
}

# What the machine before this one handed over: certbot's directory goes where certbot keeps
# it, and the release where a deploy would have put it, served as that machine served it. The
# names set up are the ones the certificate holds: asked for any other, provision.sh would ask
# Let's Encrypt for a certificate, and Let's Encrypt cannot reach this machine until the
# address is here. Each step leaves what an earlier try finished.
take_over() {
    if [ -d "$handed/etc/letsencrypt" ]; then
        rm -rf /etc/letsencrypt
        mv "$handed/etc/letsencrypt" /etc/letsencrypt
    fi
    held=$(openssl x509 -in "/etc/letsencrypt/live/$domain/fullchain.pem" -noout -ext subjectAltName |
        tr ',' '\n' | sed -n 's/^ *DNS://p' | grep -vxF "$domain" | tr '\n' ' ')
    sh /root/deploy/provision.sh "$domain" "$email" /root/deploy/deploy.pub "$machine" "$held"
    for release in "$handed"/*/; do
        release=${release%/}
        [ -x "$release/corten-site" ] || continue
        to=/opt/corten-site/releases/${release##*/}
        rm -rf "$to"
        cp -a "$release" "$to"
        chown -R deploy:deploy "$to"
        # As release.sh points `current` at a release: made beside it and moved over it.
        ln -sfn "$to" /opt/corten-site/next
        mv -T /opt/corten-site/next /opt/corten-site/current
        chown -h deploy:deploy /opt/corten-site/current
        systemctl restart corten-site.service
    done
}

# The site first. A machine that was handed a certificate and a release serves with them, and
# the workflow moves the address here once it answers. One that was handed nothing sets itself
# up once the name reaches it, under the site's name alone: a name that redirects to it and is
# late, or is refused a certificate, then holds back only itself, and this unit's journal says
# which name is waited for. A run after one that failed further on leaves this step out, by
# the file that says it finished: asked for the site's name alone, a certificate that holds
# the others already would be replaced by one without them, and again below by one with them,
# at each new try.
if [ ! -e /var/lib/corten-site-boot.site ]; then
    until [ -d "$handed" ] || answers "$domain" || assigned "$domain"; do
        echo "waiting for what the machine before this one hands over, or for $domain to reach this machine"
        sleep 5
    done
    if [ -d "$handed" ]; then
        take_over
        touch /var/lib/corten-site-boot.handed
    else
        sh /root/deploy/provision.sh "$domain" "$email" /root/deploy/deploy.pub "$machine"
    fi
    touch /var/lib/corten-site-boot.site
    rm -rf "$handed"
fi
# After a handover the address is still the old machine's: what follows asks Let's Encrypt
# only where the names have changed, and so waits until it is here.
wait_for "$domain"

# Then the names that redirect, once each reaches this machine: one certificate that holds
# them and the site's name takes the place of the site's (provision.sh). The word is still
# served meanwhile: the site's configuration answers that path on port 80 for any name. After
# a handover this is where the names become the ones given, should they differ from the ones
# the old machine's certificate holds; where they are the same, no certificate is asked for.
for name in $redirects; do
    wait_for "$name"
done
if [ -n "$redirects" ] || [ -e /var/lib/corten-site-boot.handed ]; then
    sh /root/deploy/provision.sh "$domain" "$email" /root/deploy/deploy.pub "$machine" "$redirects"
fi
rm -f /var/www/html/.well-known/acme-challenge/corten-site-boot
touch /var/lib/corten-site-boot.done
