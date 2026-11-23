#!/bin/sh
# Sets up a fresh Ubuntu 24.04 machine to serve the site: nginx with a Let's Encrypt certificate
# in front, the site as a systemd service behind it, and a `deploy` user the workflow ships
# releases as. Run as root, from this directory on the machine (README.md here):
#   sh provision.sh <domain> <email for Let's Encrypt> <the deploy key's public half, a file> ['<what the machine is>' ['<names that redirect>']]
# The last argument is the other names that send their visitors to the site's, with spaces
# between them, such as 'www.example.com': each must reach this machine already.
# Safe to run again: each step leaves what is already in place.
set -eu

if [ $# -lt 3 ] || [ $# -gt 5 ] || [ -z "$1" ] || [ -z "$2" ] || [ -z "$3" ]; then
    echo "usage: sh provision.sh <domain> <email for Let's Encrypt> <the deploy key's public half, a file> ['<what the machine is>' ['<names that redirect>']]" >&2
    exit 1
fi
domain=$1
email=$2
key=$3
# Read through a pipe further down, where a file that is not there would stop nothing.
[ -f "$key" ] && grep -q . "$key" || { echo "the deploy key's public half is not a file with a key in it: $key" >&2; exit 1; }
machine=${4:-}
redirects=${5:-}
here=$(cd "$(dirname "$0")" && pwd)
# The names are written into nginx's configuration and handed to certbot, and each reads them
# its own way: a name is lower-case letters, digits, dots and hyphens, does not start with a
# hyphen, and has a dot only between two of its parts (certbot drops one at the end, and the
# certificate would then never hold the name as given). A name that redirects is not the
# site's own.
not_a_name() {
    echo "give each name alone, in lower case: no scheme, path or port, and the site's own name once" >&2
    exit 1
}
case $redirects in
*[!a-z0-9.\ -]*) not_a_name ;;
esac
# One space between two names and none around them, so no names is the empty text.
# shellcheck disable=SC2086 # one name a word
redirects=$(printf '%s ' $redirects)
redirects=${redirects% }
for name in "$domain" $redirects; do
    case $name in
    "" | -* | .* | *. | *..* | *[!a-z0-9.-]*) not_a_name ;;
    esac
done
case " $redirects " in
*" $domain "*) not_a_name ;;
esac
# What the machine is, as the page states it: the argument, or what an earlier run was given.
[ -n "$machine" ] || machine=$(sed -n 's/^CORTEN_SITE_MACHINE=//p' /etc/corten-site.env 2>/dev/null || true)
# systemd reads quotes and backslashes in an environment file as its own, not as the text, and
# ends a value at a control character such as a carriage return.
case $machine in
*[\"\'\\]* | *[[:cntrl:]]*) echo "say what the machine is without quotes, backslashes or control characters" >&2; exit 1 ;;
esac

export DEBIAN_FRONTEND=noninteractive
# The machine's own nightly update may hold the package lists' lock, and apt-get update does
# not wait for it: it is asked again, for five minutes.
tries=0
until apt-get update; do
    tries=$((tries + 1))
    [ "$tries" -lt 20 ] || exit 1
    sleep 15
done
# sudo and sshd are on a cloud image already; the deploy's one sudo rule and the firewall's
# OpenSSH profile need them wherever this runs.
apt-get install -y --no-install-recommends nginx certbot openssl ufw sudo openssh-server

# Each deploy's release lands in a directory of its own under /opt/corten-site/releases, and
# `current` points at the one served.
id deploy >/dev/null 2>&1 || useradd --create-home --shell /bin/sh deploy
# What lies in a directory of that user's is written by that user: when this runs again the
# deploy key is on the machine, and root would follow a link put where one of these goes.
runuser -u deploy -- install -d -m 700 /home/deploy/.ssh
# The key runs commands and copies files, and nothing else: no forwarding, no terminal. A file
# that was there keeps its mode when written over, and sshd reads none that others can write.
sed 's/^/restrict /' "$key" |
    runuser -u deploy -- sh -c 'umask 077
        cat > /home/deploy/.ssh/authorized_keys && chmod 600 /home/deploy/.ssh/authorized_keys'
install -d -o deploy -g deploy /opt/corten-site
runuser -u deploy -- install -d /opt/corten-site/releases

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
# nginx counts what a reader asks for (nginx.conf), and a connection is not counted there
# until it asks: one address could hold thousands that ask for nothing, each some of nginx's
# memory, or open one after another and ask its hundred requests on each. So one reader (an
# IPv4 address or an IPv6 network, as in nginx.conf) holds 256 connections to nginx at a
# time, where the next is reset, and opens 19 in any one second, where the next is left
# unanswered and its sender's TCP tries again: a second later, and after that every second
# or twice as long each time, as that sender does. Only a connection let in is counted (the
# line that drops looks, and the line after it writes), so an address that keeps trying is
# let in 19 in each second it tries in. The second count is `recent`'s, which
# remembers the last 100 addresses and forgets the oldest, so with more than 100 addresses
# opening connections in a second it counts none of them for long. It is ufw's own for
# `ufw limit`, and a table that refuses a new address when it is full (`hashlimit`'s) could
# be filled for everyone by connections with made-up addresses. The lines are taken out and
# written again, so a second run leaves one copy.
limit_connections() {
    sed -i '/corten-site/d' "$1"
    sed -i "/^COMMIT\$/i \\
-A $2 -p tcp -m multiport --dports 80,443 --syn -m connlimit --connlimit-above 256 --connlimit-mask $3 -m comment --comment corten-site -j REJECT --reject-with tcp-reset\\
-A $2 -p tcp -m multiport --dports 80,443 --syn -m recent --name $4 --mask $5 --rcheck --seconds 1 --hitcount 19 -m comment --comment corten-site -j DROP\\
-A $2 -p tcp -m multiport --dports 80,443 --syn -m recent --name $4 --mask $5 --set -m comment --comment corten-site" "$1"
}
limit_connections /etc/ufw/before.rules ufw-before-input 32 corten-site 255.255.255.255
limit_connections /etc/ufw/before6.rules ufw6-before-input 64 corten-site6 ffff:ffff:ffff:ffff::
# ufw reads these files when it starts, so one that is on is turned off first (connections
# already made go on, and nothing but nginx and SSH listens outside the machine). A kernel
# without what a line needs refuses the whole file, and ufw leaves what it had loaded by
# then: packets dropped unless a rule lets them in, and none of that file's rules, so nginx
# cannot reach the app. The lines are then taken out and the firewall started again, and
# the machine serves without the two counts, which the workflow's check after an apply says
# (site-machine.yml).
ufw disable
if ! ufw --force enable; then
    echo "The firewall refused the lines that count one address's connections: going on without them." >&2
    sed -i '/corten-site/d' /etc/ufw/before.rules /etc/ufw/before6.rules
    ufw disable
    ufw --force enable
fi

# The certificate first, answered by nginx as it is installed, then the site's own configuration,
# which names it. certbot's timer renews it; nginx takes the new one on reload. One certificate
# holds the site's name and each name that redirects to it, and no other: a name it kept after
# its record was gone would fail every renewal, the site's with it. So it is asked for again
# only when the names it holds are not the ones given, and is then replaced by one that holds
# those.
certificate=/etc/letsencrypt/live/$domain/fullchain.pem
held() {
    openssl x509 -in "$certificate" -noout -ext subjectAltName | tr ',' '\n' | sed -n 's/^ *DNS://p' | sort -u
}
given() {
    # shellcheck disable=SC2086 # one name a word
    printf '%s\n' "$domain" $redirects | sort -u
}
install -d /var/www/html
if [ ! -e "$certificate" ] || [ "$(held)" != "$(given)" ]; then
    systemctl start nginx
    set -- -d "$domain"
    for name in $redirects; do
        set -- "$@" -d "$name"
    done
    certbot certonly --webroot -w /var/www/html --cert-name "$domain" "$@" --renew-with-new-domains \
        -m "$email" --agree-tos --non-interactive --deploy-hook 'systemctl reload nginx'
fi
# `_`, which is no host's name, stands where there are none, so the server that redirects is
# there and no visitor reaches it.
sed -e "s/SITE_DOMAIN/$domain/g" -e "s/SITE_REDIRECTS/${redirects:-_}/g" "$here/nginx.conf" > /etc/nginx/sites-available/corten-site
ln -sf /etc/nginx/sites-available/corten-site /etc/nginx/sites-enabled/corten-site
rm -f /etc/nginx/sites-enabled/default
nginx -t
# Started here too: on a run that finds its certificate in place nothing above has started it.
systemctl enable --now nginx
systemctl reload nginx

echo "Ready. The first deploy starts the service: run the Site workflow, or push to main."
