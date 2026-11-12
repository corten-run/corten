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
# A machine's first minutes hold the package lock for its own updates: wait for it, here and in
# provision.sh, instead of failing.
echo 'DPkg::Lock::Timeout "600";' > /etc/apt/apt.conf.d/90corten-site-lock
apt-get update
apt-get install -y --no-install-recommends nginx curl

# A word only this machine knows, served where certbot's challenge will be: nginx as installed
# serves /var/www/html, and so does the site's own configuration under this path. When the name
# answers with it, a certificate asked for now is asked for by the machine the name reaches.
word=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
install -d /var/www/html/.well-known/acme-challenge
printf '%s' "$word" > /var/www/html/.well-known/acme-challenge/corten-site-boot
systemctl start nginx
until [ "$(curl -fsS --max-time 5 "http://$domain/.well-known/acme-challenge/corten-site-boot" 2>/dev/null || true)" = "$word" ]; do
    sleep 30
done
rm -f /var/www/html/.well-known/acme-challenge/corten-site-boot

sh /root/deploy/provision.sh "$domain" "$email" /root/deploy/deploy.pub "$machine"
touch /var/lib/corten-site-boot.done
