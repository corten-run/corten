#!/usr/bin/env bash
# Prepare the two Noble PPA packages once. A cache is input, never a trust root.
set -euo pipefail
mode=${1:?cold or warm}; cache=${2:?cache directory}; out=${3:?new output directory}
version='1:2.56.1-0ppa1~ubuntu24.04.1'
fingerprint=F911AB184317630C59970973E363C90F8F1B6217
ppa=https://ppa.launchpadcontent.net/git-core/ppa/ubuntu
tmp=$(mktemp -d); trap 'rm -rf -- "$tmp"' EXIT
export GNUPGHOME="$tmp/gnupg"
mkdir -m 700 "$GNUPGHOME"
fetch() { curl --proto '=https' --tlsv1.2 --fail --silent --show-error --retry 3 --max-time 60 "$1" -o "$cache/$2"; }
case "$mode" in
  cold)
    mkdir "$cache"
    fetch "https://keyserver.ubuntu.com/pks/lookup?op=get&search=0x$fingerprint" key.asc
    fetch "$ppa/dists/noble/InRelease" InRelease
    fetch "$ppa/dists/noble/main/binary-amd64/Packages.gz" Packages.gz
    for spec in git:amd64 git-man:all; do
      pkg=${spec%:*}
      fetch "$ppa/pool/main/g/git/${pkg}_${version#*:}_${spec#*:}.deb" "$pkg.deb"
    done ;;
  warm) ;;
  *) exit 2 ;;
esac

# Only the five named files are used. Never restore an APT configuration,
# keyring, unsigned list, installed-package database or previously built image.
for name in key.asc InRelease Packages.gz git.deb git-man.deb; do
  [[ -f "$cache/$name" && ! -L "$cache/$name" ]]
done
keys=$(gpg --batch --show-keys --with-colons "$cache/key.asc" | awk -F: '$1=="pub"{p=1} p && $1=="fpr"{print $10;p=0}')
[[ "$keys" == "$fingerprint" ]]
dist="$tmp/ppa/dists/noble"
mkdir -p "$dist/main/binary-amd64" "$tmp/lists/partial" "$tmp/empty"
cp "$cache/key.asc" "$tmp/key.asc"
cp "$cache/InRelease" "$dist/InRelease"
cp "$cache/Packages.gz" "$dist/main/binary-amd64/Packages.gz"
printf 'deb [arch=amd64 by-hash=no signed-by=%s/key.asc] file:%s/ppa noble main\n' "$tmp" "$tmp" > "$tmp/sources.list"
export APT_CONFIG="$tmp/apt.conf"
cat > "$APT_CONFIG" <<EOF
Dir::Etc::parts "$tmp/empty";
Dir::Etc::main "-";
Dir::Etc::sourcelist "$tmp/sources.list";
Dir::Etc::sourceparts "-";
Dir::State::lists "$tmp/lists";
Dir::State::status "/dev/null";
Dir::Cache::pkgcache "";
Dir::Cache::srcpkgcache "";
APT::Architecture "amd64";
Acquire::Languages "none";
Acquire::CompressionTypes::Order { "gz"; };
EOF
apt-get update -qq --error-on=any
target=$(apt-get indextargets --format '$(CODENAME) $(COMPONENT) $(ARCHITECTURE)' 'Identifier: Packages')
[[ "$target" == 'noble main amd64' ]]
mkdir "$out"
for spec in git:amd64 git-man:all; do
  pkg=${spec%:*}
  hash=$(apt-cache show "$pkg=$version" | awk '$1=="SHA256:"{print $2}')
  [[ "$hash" =~ ^[0-9a-f]{64}$ ]]
  cp "$cache/$pkg.deb" "$out/$pkg.deb"
  (cd "$out"; printf '%s  %s.deb\n' "$hash" "$pkg" | sha256sum --check)
  [[ "$(dpkg-deb --show --showformat='${Package}:${Architecture}=${Version}' "$out/$pkg.deb")" == "$spec=$version" ]]
  echo "$spec=$version $hash"
done
