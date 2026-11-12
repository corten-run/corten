#!/bin/sh
# What a machine made by main.tf runs as it first starts (corten-site-boot.service): it waits
# until the site's name reaches this machine, then sets it up with ../provision.sh. The name may
# not reach it for a while: its DNS may still be on its way, and the address belongs to the
# machine before this one until OpenTofu moves it.
set -eu

# Written by main.tf: the three it sets.
domain='' email='' machine=''
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

# Two ways to know the name reaches this machine; either will do. A certificate asked for then
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
    [ "$(curl -fsS --max-time 5 "http://$domain/.well-known/acme-challenge/corten-site-boot" 2>/dev/null || true)" = "$word" ]
}

# Two: the name resolves to the reserved address that DigitalOcean's metadata says is on this
# machine now. A machine may not reach its own reserved address from inside, and then the first
# way alone would wait for ever.
metadata=http://169.254.169.254/metadata/v1/reserved_ip/ipv4
assigned() {
    [ "$(curl -fsS --max-time 5 "$metadata/active" 2>/dev/null || true)" = true ] || return 1
    address=$(curl -fsS --max-time 5 "$metadata/ip_address" 2>/dev/null || true)
    [ -n "$address" ] || return 1
    getent ahostsv4 "$domain" | awk -v address="$address" '$1 == address { found = 1 } END { exit !found }'
}

until answers || assigned; do
    sleep 30
done
rm -f /var/www/html/.well-known/acme-challenge/corten-site-boot

sh /root/deploy/provision.sh "$domain" "$email" /root/deploy/deploy.pub "$machine"
touch /var/lib/corten-site-boot.done
