# Builds httparena-corten:<name> from trees/<tree>.tgz and trees/entry-var.tgz.
set -uo pipefail
W=/root/work/httparena-gap
name=$1; tree=$2
S=$W/stage-$name
rm -rf "$S" && mkdir -p "$S" && tar -xzf "$W/trees/$tree.tgz" -C "$S" && tar -xzf "$W/trees/entry-var.tgz" -C "$S"
if docker build -f "$S/bench/httparena/corten/Dockerfile" -t "httparena-corten:$name" "$S" > "$W/build-corten-$name.log" 2>&1; then
    echo "built httparena-corten:$name"
else
    echo "FAIL build $name"; grep -E "error|warning: unused|-->" "$W/build-corten-$name.log" | head -60
fi
echo "# BUILD-DONE"
