#!/bin/bash
# try-build.sh: on the build host, no load and no reading. Builds one card-market image at the base
# as the plan's time measurement names it (base-1), and its glibc image (base-1-glibc) by a
# Dockerfile of two lines. Run under nohup; ends with TRY-BUILD-DONE.
set -u
T=/root/stage-a/try
L="--label agent.owner=author --label agent.task=stage-a"
cd "$T/tree" || exit 1
for i in base-1 base-1-glibc; do
    if docker image inspect "$i" >/dev/null 2>&1; then echo "REFUSED: an image named $i exists"; exit 3; fi
done
s=$(date +%s)
docker build $L -f examples/card-market/Dockerfile -t base-1 . >"$T/build-base-1.log" 2>&1
echo "build base-1 exit $? in $(( $(date +%s) - s )) s"
mkdir -p "$T/glibc"
printf 'FROM base-1\nENV LD_PRELOAD=\n' >"$T/glibc/Dockerfile"
cat "$T/glibc/Dockerfile"
docker build $L -t base-1-glibc "$T/glibc" >"$T/build-base-1-glibc.log" 2>&1
echo "build base-1-glibc exit $?"
docker image inspect base-1 base-1-glibc --format '{{index .RepoTags 0}} {{.Id}} {{.Size}} {{json .Config.Env}}'
echo TRY-BUILD-DONE
# end

