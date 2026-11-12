#!/bin/sh
# Sets up a fresh Ubuntu 24.04 machine to serve the site: nginx with a Let's Encrypt certificate
# in front, the site as a systemd service behind it, and a `deploy` user the workflow ships
# releases as. Run once, as root, from this directory on the machine (README.md here):
#   sh provision.sh <domain> <email for Let's Encrypt> <the deploy key's public half, a file> ['<what the machine is>']
# Safe to run again: each step leaves what is already in place.
set -eu

domain=${1:?the site's domain}
email=${2:?an email address for Let's Encrypt}
key=${3:?the file holding the public half of the deploy key}
machine=${4:-}
here=$(cd "$(dirname "$0")" && pwd)
# What the machine is, as the page states it: the argument, or what an earlier run was given.
[ -n "$machine" ] || machine=$(sed -n 's/^CORTEN_SITE_MACHINE=//p' /etc/corten-site.env 2>/dev/null || true)
# systemd reads quotes and backslashes in an environment file as its own, not as the text.
case $machine in
*[\"\'\\]*) echo "say what the machine is without quotes or backslashes" >&2; exit 1 ;;
esac

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends nginx certbot ufw

# Each deploy's release lands in a directory of its own under /opt/corten-site/releases, and
# `current` points at the one served.
id deploy >/dev/null 2>&1 || useradd --create-home --shell /bin/sh deploy
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
# The key runs commands and copies files, and nothing else: no forwarding, no terminal.
sed 's/^/restrict /' "$key" > /home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys
chmod 600 /home/deploy/.ssh/authorized_keys
install -d -o deploy -g deploy /opt/corten-site /opt/corten-site/releases

# The deploy restarts the service and nothing else.
cat > /etc/sudoers.d/corten-site <<'EOF'
deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart corten-site.service
EOF
chmod 440 /etc/sudoers.d/corten-site
visudo -cf /etc/sudoers.d/corten-site

cat > /etc/corten-site.env <<EOF
HOST=127.0.0.1
PORT=3000
HOSTS=$domain
PROXIES=127.0.0.1
PUBLIC_ORIGIN=https://$domain
HTTPS=1
CORTEN_SITE_MACHINE=$machine
EOF
install -m 644 "$here/corten-site.service" /etc/systemd/system/corten-site.service
systemctl daemon-reload
systemctl enable corten-site.service

# Every open page holds a live stream, which is two connections to nginx: the reader's and the
# one to the app. Ubuntu's 768 a worker would stop at about 380 readers.
sed -i 's/worker_connections [0-9]*;/worker_connections 8192;/' /etc/nginx/nginx.conf
grep -q '^worker_rlimit_nofile' /etc/nginx/nginx.conf || sed -i '1i worker_rlimit_nofile 16384;' /etc/nginx/nginx.conf

ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

# The certificate first, answered by nginx as it is installed, then the site's own configuration,
# which names it. certbot's timer renews it; nginx takes the new one on reload.
install -d /var/www/html
if [ ! -e "/etc/letsencrypt/live/$domain/fullchain.pem" ]; then
    systemctl start nginx
    certbot certonly --webroot -w /var/www/html -d "$domain" -m "$email" --agree-tos --non-interactive \
        --deploy-hook 'systemctl reload nginx'
fi
sed "s/SITE_DOMAIN/$domain/g" "$here/nginx.conf" > /etc/nginx/sites-available/corten-site
ln -sf /etc/nginx/sites-available/corten-site /etc/nginx/sites-enabled/corten-site
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable nginx
systemctl reload nginx

echo "Ready. The first deploy starts the service: run the Site workflow, or push to main."
