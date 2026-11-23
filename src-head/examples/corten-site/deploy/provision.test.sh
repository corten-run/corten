#!/bin/sh
# What provision.sh does in the deploy user's directories, run as root in a container by the
# Site machine workflow's check and never on a machine: it makes a user and writes under /etc,
# /home and /opt.
#   docker run --rm -v "$PWD/examples/corten-site/deploy:/deploy:ro" ubuntu:24.04 sh /deploy/provision.test.sh
# Those lines run again whenever the script does, and the deploy key is on the machine by
# then: root must write nothing through a link that user put there. Only those lines are run
# here, cut out of the script from where it makes the user to the comment after them: the
# rest installs packages and asks Let's Encrypt.
set -eu

[ -e /.dockerenv ] || { echo "run this in a container: it makes a user and writes under /etc, /home and /opt" >&2; exit 1; }
here=$(cd "$(dirname "$0")" && pwd)
sed -n '/^id deploy /,/^# The deploy restarts the service/p' "$here/provision.sh" > /tmp/lines
echo "ssh-ed25519 AAAA a deploy key" > /tmp/deploy.pub
provision() { key=/tmp/deploy.pub sh -eu /tmp/lines; }

failed=0
# is <what is expected> <a command that succeeds when it is so>
is() {
    what=$1
    shift
    if "$@" > /dev/null 2>&1; then echo "ok    $what"; else echo "FAILS $what"; failed=1; fi
}
fails() { ! "$@"; }
owned() { [ "$(stat -c '%U %a' "$2")" = "$1" ]; }
as_deploy() { runuser -u deploy -- sh -c "$1"; }
# What root owns and the deploy user points a link at.
install -d /etc/victim.d
echo "root's" > /etc/victim
chmod 600 /etc/victim
untouched() {
    owned "root 600" /etc/victim && [ "$(cat /etc/victim)" = "root's" ] &&
        owned "root 755" /etc/victim.d && [ -z "$(ls -A /etc/victim.d)" ]
}
# stops_for <what was given as the key's file>
stops_for() {
    sh "$here/provision.sh" site.test someone@site.test "$1" 2> /tmp/said && return 1
    grep -q "not a file with a key in it" /tmp/said
}
# The rest of the script, without its comments: a line there that named one of that user's
# directories would be root's, and is not run here.
elsewhere() {
    sed '/^id deploy /,/^# The deploy restarts the service/d' "$here/provision.sh" |
        grep -v '^ *#' | grep -q '/home/deploy\|/opt/corten-site'
}

is "the lines that make the deploy user are found in provision.sh" grep -q useradd /tmp/lines
is "  and no line outside them names a directory of that user's" fails elsewhere
is "a first run ends well" provision
is "  the key's directory the deploy user's alone" owned "deploy 700" /home/deploy/.ssh
is "  and the key's file" owned "deploy 600" /home/deploy/.ssh/authorized_keys
is "  which holds the key, restricted" [ "$(cat /home/deploy/.ssh/authorized_keys)" = "restrict ssh-ed25519 AAAA a deploy key" ]
is "  where releases go that user's" owned "deploy 755" /opt/corten-site
is "  and the releases' directory" owned "deploy 755" /opt/corten-site/releases
is "a second run ends well" provision
chmod 666 /home/deploy/.ssh/authorized_keys
is "a run over a key's file others could write ends well" provision
is "  the file the deploy user's alone again" owned "deploy 600" /home/deploy/.ssh/authorized_keys

as_deploy 'cd /home/deploy/.ssh && mv authorized_keys kept && ln -s /etc/victim authorized_keys'
is "a run over a key's file that is a link to a file of root's fails" fails provision
is "  and root's file is as it was" untouched
as_deploy 'cd /home/deploy/.ssh && rm authorized_keys && mv kept authorized_keys'
as_deploy 'cd /home/deploy && mv .ssh kept && ln -s /etc/victim.d .ssh'
is "a run over a key's directory that is a link to a directory of root's fails" fails provision
is "  and root's directory is as it was" untouched
as_deploy 'cd /home/deploy && rm .ssh && mv kept .ssh'
as_deploy 'cd /opt/corten-site && mv releases kept && ln -s /etc/victim.d releases'
is "a run over a releases' directory that is such a link ends well" provision
is "  and root's directory is as it was" untouched
as_deploy 'cd /opt/corten-site && rm releases && mv kept releases'
is "a run with all of it put back ends well" provision
: > /tmp/empty
is "provision.sh stops before it installs anything for a key's file that is not there" stops_for /tmp/not-there
is "  for one that is empty" stops_for /tmp/empty
echo > /tmp/empty
is "  for one that holds an empty line" stops_for /tmp/empty
is "  and for a directory" stops_for /tmp

[ "$failed" = 0 ] || exit 1
echo "provision.sh writes in the deploy user's directories as that user"
