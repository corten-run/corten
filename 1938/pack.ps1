# pack.ps1: writes D:\Temp\cycles\cycles-1938.tar for setup.sh (#1938's cycle kit): 1938/ with its
# scripts, summary.mjs, lua/, the probes, both source trees (export-src.ps1) and results/margin.md
# alone, without any build. Everything is under 1938/, so it unpacks beside other kits under /m.
# Upload it as /root/cycles-1938.tar, then (as root):
#   mkdir -p /m && tar -xf /root/cycles-1938.tar -C /m && sh /m/1938/setup.sh && sh /m/1938/run.sh
$ErrorActionPreference = 'Stop'
$root = 'D:\Temp\cycles'
$kit = Join-Path $root '1938'
$out = Join-Path $root 'cycles-1938.tar'
$extra = Get-ChildItem -LiteralPath (Join-Path $kit 'results') -Force | Where-Object Name -ne 'margin.md'
if ($extra) { throw "1938\results holds more than margin.md: $($extra.Name -join ', ')" }
foreach ($side in 'base', 'head') {
    $commit = (Get-Content -LiteralPath (Join-Path $kit "src-$side.commit")).Trim()
    if ((Get-Content -LiteralPath (Join-Path $kit 'commits.env')) -notcontains "$($side.ToUpper())=$commit") { throw "src-$side.commit ($commit) is not commits.env's: run export-src.ps1 -Pr 1938" }
}
if ((Get-Content -LiteralPath (Join-Path $kit 'results\margin.md') -Raw) -notmatch '(?m)^<!-- commits --> Base `[0-9a-f]{40}`') { throw 'margin.md has no commits line: run export-src.ps1 -Pr 1938' }
& tar.exe -cf $out -C $root --exclude '1938/bin' --exclude '1938/target*' --exclude '1938/build-*.log' --exclude '1938/probe-*/target' 1938
if ($LASTEXITCODE) { throw "tar failed" }
$list = & tar.exe -tf $out
foreach ($need in '1938/README.md', '1938/setup.sh', '1938/build.sh', '1938/run.sh', '1938/run-pair.sh', '1938/summary.mjs', '1938/commits.env',
    '1938/lua/get.lua', '1938/lua/post-same-origin.lua',
    '1938/results/margin.md', '1938/probe-base/Cargo.toml', '1938/probe-base/Cargo.lock', '1938/probe-base/src/main.rs',
    '1938/probe-head/Cargo.toml', '1938/probe-head/Cargo.lock', '1938/probe-head/src/main.rs',
    '1938/src-base.commit', '1938/src-head.commit', '1938/src-base/Cargo.lock', '1938/src-head/Cargo.lock',
    '1938/src-base/crates/corten/src/kept.rs', '1938/src-head/crates/corten/src/kept.rs') {
    if ($list -notcontains $need) { throw "cycles-1938.tar lacks $need" }
}
if ($list | Where-Object { $_ -notlike '1938/*' }) { throw 'cycles-1938.tar holds something outside 1938/' }
"{0}: {1} entries, {2:N1} MB" -f $out, $list.Count, ((Get-Item -LiteralPath $out).Length / 1MB)