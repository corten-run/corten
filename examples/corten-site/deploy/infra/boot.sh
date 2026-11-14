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
# private half is the workflow's alone, and is not among what a machine is handed. The key
# signs in as a user of its own, made as provision.sh makes `deploy`, and not as root: a cloud
# image may hold root to a password that must be changed before anything signs in as it.
# sudo and sshd are on a cloud image already.
handed=/var/lib/corten-site-handover
if grep -q . /root/deploy/handover.pub 2>/dev/null; then
    install -m 755 /root/deploy/handover.sh /usr/local/sbin/corten-site-handover
    id handover >/dev/null 2>&1 || useradd --create-home --shell /bin/sh handover
    install -d -m 700 -o handover -g handover /home/handover/.ssh
    # The word the key's holder sends is one argument, whatever is in it, and sudo lets three
    # words through.
    # shellcheck disable=SC2016 # read by the shell sshd starts, not this one
    printf 'restrict,command="sudo -n /usr/local/sbin/corten-site-handover \\"$SSH_ORIGINAL_COMMAND\\"" %s\n' \
        "$(cat /root/deploy/handover.pub)" > /home/handover/.ssh/authorized_keys
    chown handover:handover /home/handover/.ssh/authorized_keys
    chmod 600 /home/handover/.ssh/authorized_keys
    cat > /etc/sudoers.d/corten-site-handover <<'EOF'
handover ALL=(root) NOPASSWD: /usr/local/sbin/corten-site-handover ask, /usr/local/sbin/corten-site-handover give, /usr/local/sbin/corten-site-handover take
EOF
    chmod 440 /etc/sudoers.d/corten-site-handover
    visudo -cf /etc/sudoers.d/corten-site-handover
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
#
# The names the site's certificate holds beside the site's own, one a line.
held() {
    openssl x509 -in "/etc/letsencrypt/live/$domain/fullchain.pem" -noout -ext subjectAltName |
        tr ',' '\n' | sed -n 's/^ *DNS://p' | grep -vxF "$domain" || true
}
take_over() {
    if [ -d "$handed/etc/letsencrypt" ]; then
        # cli.ini is the certbot package's own and is not sent: where an earlier try has
        # installed the package, its file is kept.
        [ ! -e /etc/letsencrypt/cli.ini ] || cp -p /etc/letsencrypt/cli.ini "$handed/etc/letsencrypt/cli.ini"
        rm -rf /etc/letsencrypt
        mv "$handed/etc/letsencrypt" /etc/letsencrypt
    fi
    sh /root/deploy/provision.sh "$domain" "$email" /root/deploy/deploy.pub "$machine" "$(held | tr '\n' ' ')"
    placed=no
    for release in "$handed"/*/; do
        release=${release%/}
        name=${release##*/}
        [ ! -L "$release" ] && [ -x "$release/corten-site" ] || continue
        # A release's name was a deploy's to choose on the machine before this one, which
        # sends none that a command would take for an option, nor `etc`, where certbot's
        # directory lay (handover.sh). Refused here too.
        case $name in etc | *[!A-Za-z0-9._-]* | [!A-Za-z0-9]*) continue ;; esac
        # Put there by the deploy user, as a deploy puts one: the directory is that user's,
        # and its key is on this machine by now, so root writes nothing in it and follows no
        # link there. What that user's tar writes is that user's, whatever its mode was.
        runuser -u deploy -- rm -rf "/opt/corten-site/releases/$name"
        tar -cf - -C "$handed" "$name" | runuser -u deploy -- tar -xf - -C /opt/corten-site/releases
        # The pipe ends as its reader does, whatever the tar that writes into it met.
        [ -x "/opt/corten-site/releases/$name/corten-site" ] || continue
        # As release.sh points `current` at a release: made beside it and moved over it.
        runuser -u deploy -- ln -sfn "/opt/corten-site/releases/$name" /opt/corten-site/next
        runuser -u deploy -- mv -T /opt/corten-site/next /opt/corten-site/current
        systemctl restart corten-site.service
        placed=yes
    done
    # handover.sh takes nothing without a release in it; were one not put in place all the
    # same, this machine would answer 502 as a machine that is set up, and take nothing more.
    if [ "$placed" = no ]; then
        echo "what was handed over holds no release this machine could put in place" >&2
        exit 1
    fi
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
# the old machine's certificate holds. Where they are the same the machine is set up already,
# and is left as it is: a second run would start the firewall again under a machine that
# serves.
listed() { tr ' ' '\n' | grep . | sort -u; }
if [ -e /var/lib/corten-site-boot.handed ] && [ "$(echo "$redirects" | listed)" = "$(held | listed)" ]; then
    echo "the names given are the ones the certificate holds: nothing more to set up"
else
    for name in $redirects; do
        wait_for "$name"
    done
    if [ -n "$redirects" ] || [ -e /var/lib/corten-site-boot.handed ]; then
        sh /root/deploy/provision.sh "$domain" "$email" /root/deploy/deploy.pub "$machine" "$redirects"
    fi
fi
rm -f /var/www/html/.well-known/acme-challenge/corten-site-boot
touch /var/lib/corten-site-boot.done
