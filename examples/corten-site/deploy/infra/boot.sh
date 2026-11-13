#!/bin/sh
# What a machine made by main.tf runs as it first starts (corten-site-boot.service): it waits
# until the site's name reaches this machine, then sets it up with ../provision.sh, and then
# does the same for the names that redirect to the site's. A name may not reach it for a
# while: its DNS may still be on its way, and the address belongs to the machine before this
# one until OpenTofu moves it.
set -eu

# Written by main.tf: the four it sets.
domain='' email='' machine='' redirects=''
. /root/deploy/site.conf

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
apt-get install -y --no-install-recommends nginx curl

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

# The site first, under its own name alone. A name that redirects to it and is late, or is
# refused a certificate, then holds back only itself: the site is served meanwhile, and this
# unit's journal says which name is waited for. A run after one that failed further on leaves
# this step out, by the file that says it finished: asked for the site's name alone, a
# certificate that holds the others already would be replaced by one without them, and again
# below by one with them, at each new try.
wait_for "$domain"
if [ ! -e /var/lib/corten-site-boot.site ]; then
    sh /root/deploy/provision.sh "$domain" "$email" /root/deploy/deploy.pub "$machine"
    touch /var/lib/corten-site-boot.site
fi

# Then the names that redirect, once each reaches this machine: one certificate that holds
# them and the site's name takes the place of the site's (provision.sh). The word is still
# served meanwhile: the site's configuration answers that path on port 80 for any name.
if [ -n "$redirects" ]; then
    for name in $redirects; do
        wait_for "$name"
    done
    sh /root/deploy/provision.sh "$domain" "$email" /root/deploy/deploy.pub "$machine" "$redirects"
fi
rm -f /var/www/html/.well-known/acme-challenge/corten-site-boot
touch /var/lib/corten-site-boot.done
