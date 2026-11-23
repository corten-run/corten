#!/usr/bin/env bash
# Exercise real APT authentication and deb identity against a tiny signed Noble
# fixture. Replace only the primary fingerprint and transport, never apt or gpg.
set -euo pipefail
src=$(realpath "$(dirname "$0")/benchmark-evidence-git.sh")
t=$(mktemp -d); trap 'rm -rf -- "$t"' EXIT
cd "$t"
export GNUPGHOME="$t/gpg" FIXTURE="$t"
mkdir -m 700 "$GNUPGHOME"; mkdir bin repo
gpg --batch --passphrase '' --quick-gen-key 'Evidence test <test@example.invalid>' ed25519 sign 1d >/dev/null 2>&1
fpr=$(gpg --batch --with-colons --list-keys | awk -F: '$1=="fpr"{print $10}')
gpg --batch --armor --export "$fpr" > repo/key.asc
sed "s/F911AB184317630C59970973E363C90F8F1B6217/$fpr/g" "$src" > prepare.sh
version=$(sed -n "s/^version='\(.*\)'/\1/p" prepare.sh)
for spec in git:amd64 git-man:all; do
  pkg=${spec%:*}; arch=${spec#*:}
  mkdir -p "$pkg/DEBIAN"
  printf 'Package: %s\nVersion: %s\nArchitecture: %s\nMaintainer: CI <test@example.invalid>\nDescription: synthetic Git package\n' "$pkg" "$version" "$arch" > "$pkg/DEBIAN/control"
  deb="${pkg}_${version#*:}_${arch}.deb"
  dpkg-deb --build --root-owner-group "$pkg" "repo/$deb" >/dev/null
  cat "$pkg/DEBIAN/control" >> Packages
  hash=$(sha256sum "repo/$deb")
  printf 'Filename: pool/main/g/git/%s\nSize: %s\nSHA256: %s\n\n' "$deb" "$(stat -c %s "repo/$deb")" "${hash%% *}" >> Packages
done
gzip -c Packages > repo/Packages.gz
xz -c Packages > Packages.xz
{
  printf 'Origin: fixture\nSuite: noble\nCodename: noble\nArchitectures: amd64\nComponents: main\nAcquire-By-Hash: yes\nDate: %s\nSHA256:\n' "$(date -Ru)"
  for file in Packages repo/Packages.gz Packages.xz; do
    hash=$(sha256sum "$file")
    printf ' %s %s main/binary-amd64/%s\n' "${hash%% *}" "$(stat -c %s "$file")" "${file##*/}"
  done
} > Release
gpg --batch --clearsign --output repo/InRelease Release
cat > bin/curl <<'SH'
#!/usr/bin/env bash
set -eu
while [[ "$2" != -o ]]; do shift; done
case "$1" in
  https://keyserver.ubuntu.com/*) name=key.asc ;;
  https://ppa.launchpadcontent.net/git-core/ppa/ubuntu/*) name=${1##*/} ;;
  *) exit 1 ;;
esac
echo "$name" >> "$FIXTURE/calls"
cp "$FIXTURE/repo/$name" "$3"
SH
chmod +x bin/curl; export PATH="$t/bin:$PATH"
run() { bash prepare.sh "$1" "$t/cache" "$t/$2"; }
reject() { if run "$1" "rejected-$2" > rejected.log 2>&1; then echo "accepted: $2" >&2; exit 1; fi; }
run cold first
[[ $(wc -l < calls) == 5 ]]
mv repo offline
run warm second
cmp first/git.deb second/git.deb; cmp first/git-man.deb second/git-man.deb
cp cache/git.deb original; cp cache/git-man.deb cache/git.deb
reject warm 'substituted package'; mv original cache/git.deb
printf x >> cache/Packages.gz
reject warm 'unsigned index change'
cp offline/Packages.gz cache/Packages.gz
sed -i 's/Suite: noble/Suite: other/' cache/InRelease
reject warm 'changed signed release'
cp offline/InRelease cache/InRelease
gpg --batch --passphrase '' --quick-gen-key 'Other test <other@example.invalid>' ed25519 sign 1d >/dev/null 2>&1
gpg --batch --armor --export other@example.invalid > cache/key.asc
gpg --batch --yes --local-user other@example.invalid --clearsign --output cache/InRelease Release
reject warm 'valid signature by a different primary'
[[ $(wc -l < calls) == 5 ]]
mv cache saved
reject cold 'unavailable cold source'
echo 'PASS signed cold packages, offline reuse, and refused invalid or unavailable inputs'
