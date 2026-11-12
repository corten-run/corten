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

environment site
environment site-machine

# Two keys, made here and kept nowhere else. The deploy key's private half is the Site
# workflow's, its public half the machine's. The host key is the other way round: the machine
# is given the private half as it starts, and the Site workflow knows the host by the public
# half, under the site's name, so a machine that replaces another is still the host it trusts.
if has_secret site SITE_SSH_KEY && has_secret site-machine SITE_HOST_KEY; then
    echo "the keys are already there, and are kept"
else
    work=$(mktemp -d)
    trap 'rm -rf "$work"' EXIT
    ssh-keygen -q -t ed25519 -N "" -C corten-site-deploy -f "$work/deploy"
    ssh-keygen -q -t ed25519 -N "" -C corten-site -f "$work/host"
    gh secret set SITE_SSH_KEY --env site < "$work/deploy"
    gh secret set SITE_HOST_KEY --env site-machine < "$work/host"
    gh variable set SITE_DEPLOY_KEY --env site-machine --body "$(cat "$work/deploy.pub")"
    gh variable set SITE_HOST_KEY_PUBLIC --env site-machine --body "$(cat "$work/host.pub")"
fi
# The Site workflow reaches the machine by the site's name, and knows it by the host key.
gh variable get SITE_HOST_KEY_PUBLIC --env site-machine | cut -d' ' -f1-2 | sed "s/^/$domain /" |
    gh secret set SITE_KNOWN_HOSTS --env site

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
