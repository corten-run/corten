# pack.ps1: writes D:\Temp\cycles\cycles-1938b.tar (kit 1938b, #1938's supplement after round 2 of
# review): 1938b/ with its scripts, start.sh, summary.mjs, lua/, the probes, both source trees
# (export-src.ps1 -Pr 1938b) and results/margin.md alone, without any build. Everything is under
# 1938b/, so it unpacks beside other kits under /m. Upload it as /root/cycles-1938b.tar and
# 1938b/start.sh as /root/start.sh, then (as root): sh /root/start.sh
$ErrorActionPreference = 'Stop'
$root = 'D:\Temp\cycles'
$kit = Join-Path $root '1938b'
$out = Join-Path $root 'cycles-1938b.tar'
$extra = Get-ChildItem -LiteralPath (Join-Path $kit 'results') -Force | Where-Object Name -ne 'margin.md'
if ($extra) { throw "1938b\results holds more than margin.md: $($extra.Name -join ', ')" }
foreach ($side in 'base', 'head') {
    $commit = (Get-Content -LiteralPath (Join-Path $kit "src-$side.commit")).Trim()
    if ((Get-Content -LiteralPath (Join-Path $kit 'commits.env')) -notcontains "$($side.ToUpper())=$commit") { throw "src-$side.commit ($commit) is not commits.env's: run export-src.ps1 -Pr 1938b" }
}
$margin = Get-Content -LiteralPath (Join-Path $kit 'results\margin.md') -Raw
if ($margin -notmatch '(?m)^<!-- commits --> Base `[0-9a-f]{40}`') { throw 'margin.md has no commits line: run export-src.ps1 -Pr 1938b' }
# Shell and Lua files run on Linux: no carriage returns.
foreach ($f in Get-ChildItem -LiteralPath $kit -File -Include *.sh, *.mjs -Recurse:$false) { if ([IO.File]::ReadAllText($f.FullName).Contains("`r")) { throw "$($f.Name) has CR line ends" } }
foreach ($f in Get-ChildItem -LiteralPath (Join-Path $kit 'lua') -File) { if ([IO.File]::ReadAllText($f.FullName).Contains("`r")) { throw "lua\$($f.Name) has CR line ends" } }
if ((Get-FileHash (Join-Path $kit 'probe-base\src\main.rs')).Hash -ne (Get-FileHash (Join-Path $kit 'probe-head\src\main.rs')).Hash) { throw 'the two probes main.rs differ' }
& tar.exe -cf $out -C $root --exclude '1938b/bin' --exclude '1938b/target*' --exclude '1938b/build-*' --exclude '1938b/probe-*/target' 1938b
if ($LASTEXITCODE) { throw "tar failed" }
$list = & tar.exe -tf $out
foreach ($need in '1938b/README.md', '1938b/start.sh', '1938b/setup.sh', '1938b/build.sh', '1938b/run.sh', '1938b/run-pair.sh', '1938b/summary.mjs', '1938b/commits.env',
    '1938b/lua/get.lua', '1938b/lua/get-new.lua', '1938b/lua/post-same-origin.lua',
    '1938b/results/margin.md', '1938b/probe-base/Cargo.toml', '1938b/probe-base/Cargo.lock', '1938b/probe-base/src/main.rs',
    '1938b/probe-head/Cargo.toml', '1938b/probe-head/Cargo.lock', '1938b/probe-head/src/main.rs',
    '1938b/src-base.commit', '1938b/src-head.commit', '1938b/src-base/Cargo.lock', '1938b/src-head/Cargo.lock',
    '1938b/src-base/crates/corten/src/kept.rs', '1938b/src-head/crates/corten/src/kept.rs') {
    if ($list -notcontains $need) { throw "cycles-1938b.tar lacks $need" }
}
if ($list | Where-Object { $_ -notlike '1938b/*' }) { throw 'cycles-1938b.tar holds something outside 1938b/' }
"{0}: {1} entries, {2:N1} MB, sha256 {3}" -f $out, $list.Count, ((Get-Item -LiteralPath $out).Length / 1MB), (Get-FileHash -LiteralPath $out).Hash.ToLower()