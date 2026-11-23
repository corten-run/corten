#!/bin/sh
# Run in an empty build directory. Git signs the .tar, not the .tar.xz.
set -eu
base=https://www.kernel.org/pub/software/scm/git/git-2.56.1.tar
get() { curl --proto '=https' --proto-redir '=https' -fsSL --retry 3 --max-time 90 "$1" -o "$2"; }
get "$base.xz" git.tar.xz
echo 'f0b0bf89264b9bd2e1c640363e7529643989da76281600473c50745cd34a607f  git.tar.xz' | sha256sum -c -
get "$base.sign" git.tar.sign
get https://github.com/gitster.gpg release-key.asc
export GNUPGHOME="$PWD/gnupg"
mkdir -m 700 "$GNUPGHOME"
gpg --batch --dearmor -o release-key.gpg release-key.asc
xz -dc git.tar.xz > git.tar
gpgv --status-fd 1 --keyring "$PWD/release-key.gpg" git.tar.sign git.tar > signer
verified=$(awk '$1=="[GNUPG:]" && $2=="VALIDSIG"{print $3, $NF}' signer)
test "$verified" = \
  'E1F036B1FEE7221FC778ECEFB0B5E88696AFE6CB 96E07AF25771955980DAD10020D04E5A713660A7'
