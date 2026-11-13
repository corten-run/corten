#!/bin/sh
# Gives the repository what its two workflows need to make the site's machine and ship to it:
# the two environments only `main` may use, the machine's keys, and where things are. Run once
# from a clone of the repository, by someone who administers it, with `gh` signed in:
#   sh examples/corten-site/deploy/infra/bootstrap.sh <domain> <email for Let's Encrypt> <state bucket> <Spaces endpoint> [refuse-mail]
# such as: ... example.com someone@example.com example-site-state https://sfo3.digitaloceanspaces.com
# Safe to run again: the keys are made once and kept, and everything else is set as given.
# It ends by naming the secrets only their owner can type (../README.md).
set -eu

if [ $# -lt 4 ] || [ -z "$1" ] || [ -z "$2" ] || [ -z "$3" ] || [ -z "$4" ]; then
    echo "usage: sh bootstrap.sh <domain> <email for Let's Encrypt> <state bucket> <Spaces endpoint> [refuse-mail]" >&2
    exit 1
fi
domain=$1
email=$2
bucket=$3
endpoint=$4
mail=${5:-}
repo=$(gh repo view --json nameWithOwner --jq .nameWithOwner)

# An environment's secrets are handed only to a job its rule lets in: here, one on main.
environment() {
    gh api -X PUT "repos/$repo/environments/$1" --input - > /dev/null <<'EOF'
{"deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}}
EOF
    gh api "repos/$repo/environments/$1/deployment-branch-policies" --jq '.branch_policies[].name' | grep -qx main ||
        gh api -X POST "repos/$repo/environments/$1/deployment-branch-policies" -f name=main > /dev/null
}
has_secret() { gh secret list --env "$1" --json name --jq '.[].name' | grep -qx "$2"; }
has_variable() { gh variable list --env "$1" --json name --jq '.[].name' | grep -qx "$2"; }

environment site
environment site-machine

# Two keys, made here and kept nowhere else. The deploy key's private half is the Site
# workflow's, its public half the machine's. The host key is the other way round: the machine
# is given the private half as it starts, and the Site workflow knows the host by the public
# half, under the site's name, so a machine that replaces another is still the host it trusts.
# All four halves or none: a run that stopped between them leaves keys nothing can be matched
# to, and they are made again.
if has_secret site SITE_SSH_KEY && has_secret site-machine SITE_HOST_KEY &&
    has_variable site-machine SITE_DEPLOY_KEY && has_variable site-machine SITE_HOST_KEY_PUBLIC; then
    echo "the keys are already there, and are kept"
else
    work=$(mktemp -d)
    # The private halves do not outlast the run, however it ends: sh runs the EXIT trap for a
    # signal only when the signal is caught.
    trap 'rm -rf "$work"' EXIT
    trap 'exit 1' INT TERM HUP
    ssh-keygen -q -t ed25519 -N "" -C corten-site-deploy -f "$work/deploy"
    ssh-keygen -q -t ed25519 -N "" -C corten-site -f "$work/host"
    gh secret set SITE_SSH_KEY --env site < "$work/deploy"
    gh secret set SITE_HOST_KEY --env site-machine < "$work/host"
    gh variable set SITE_DEPLOY_KEY --env site-machine --body "$(cat "$work/deploy.pub")"
    gh variable set SITE_HOST_KEY_PUBLIC --env site-machine --body "$(cat "$work/host.pub")"
fi
# The Site workflow reaches the machine by the site's name, and knows it by the host key.
host=$(gh variable get SITE_HOST_KEY_PUBLIC --env site-machine)
host=$(printf '%s\n' "$host" | cut -d' ' -f1-2)
case $host in
"ssh-ed25519 "?*) ;;
*) echo "the machine's host key did not read back as a public key: nothing more was set" >&2; exit 1 ;;
esac
printf '%s %s\n' "$domain" "$host" | gh secret set SITE_KNOWN_HOSTS --env site

printf '%s' "$email" | gh secret set SITE_EMAIL --env site-machine
gh variable set SITE_DOMAIN --body "$domain"
gh variable set SITE_STATE_BUCKET --body "$bucket"
gh variable set SITE_STATE_ENDPOINT --body "$endpoint"
if [ "$mail" = refuse-mail ]; then refuses=true; else refuses=false; fi
gh variable set SITE_REFUSES_MAIL --body "$refuses"

echo "Set. What is left is typed by whoever holds the DigitalOcean account, each at gh's prompt:"
for secret in DIGITALOCEAN_TOKEN SPACES_ACCESS_KEY_ID SPACES_SECRET_ACCESS_KEY; do
    has_secret site-machine "$secret" || echo "  gh secret set $secret --env site-machine"
done
echo "Then: gh workflow run site-machine.yml"
