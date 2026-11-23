# pack.ps1: writes D:\Temp\cycles\cycles-1938c.tar (kit 1938c, #1938's integrated pair after round
# 3 of review): 1938c/ with its scripts, start.sh, summary.mjs, lua/, the probes, both source trees
# (export-src.ps1 -Pr 1938c) and results/margin.md alone, without any build. Everything is under
# 1938c/, so it unpacks beside other kits under /m. Upload it as /root/cycles-1938c.tar and
# 1938c/start.sh as /root/start.sh, then (as root): sh /root/start.sh
$ErrorActionPreference = 'Stop'
$root = 'D:\Temp\cycles'
$kit = Join-Path $root '1938c'
$out = Join-Path $root 'cycles-1938c.tar'
$extra = Get-ChildItem -LiteralPath (Join-Path $kit 'results') -Force | Where-Object Name -ne 'margin.md'
if ($extra) { throw "1938c\results holds more than margin.md: $($extra.Name -join ', ')" }
foreach ($side in 'base', 'head') {
    $commit = (Get-Content -LiteralPath (Join-Path $kit "src-$side.commit")).Trim()
    if ((Get-Content -LiteralPath (Join-Path $kit 'commits.env')) -notcontains "$($side.ToUpper())=$commit") { throw "src-$side.commit ($commit) is not commits.env's: run export-src.ps1 -Pr 1938c" }
}
$margin = Get-Content -LiteralPath (Join-Path $kit 'results\margin.md') -Raw
if ($margin -notmatch '(?m)^<!-- commits --> Base `[0-9a-f]{40}`') { throw 'margin.md has no commits line: run export-src.ps1 -Pr 1938c' }
# Shell and Lua files run on Linux: no carriage returns.
foreach ($f in Get-ChildItem -LiteralPath $kit -File -Include *.sh, *.mjs -Recurse:$false) { if ([IO.File]::ReadAllText($f.FullName).Contains("`r")) { throw "$($f.Name) has CR line ends" } }
foreach ($f in Get-ChildItem -LiteralPath (Join-Path $kit 'lua') -File) { if ([IO.File]::ReadAllText($f.FullName).Contains("`r")) { throw "lua\$($f.Name) has CR line ends" } }
# The readiness loop counts with its own variable, and the summary takes exactly the 100 declared pairs.
$rp = [IO.File]::ReadAllText((Join-Path $kit 'run-pair.sh'))
if ($rp -notmatch 'tries=0' -or $rp -notmatch 'tries=\$\(\(tries \+ 1\)\)' -or $rp -notmatch 'wu=\$\(\(wu \+ 1\)\)') { throw 'run-pair.sh: ready() must count with tries and the warm-up loop with wu' }
if ([IO.File]::ReadAllText((Join-Path $kit 'summary.mjs')) -notmatch 'if \(n !== 100\)') { throw 'summary.mjs lacks the 100-pair check' }
if ((Get-FileHash (Join-Path $kit 'probe-base\src\main.rs')).Hash -ne (Get-FileHash (Join-Path $kit 'probe-head\src\main.rs')).Hash) { throw 'the two probes main.rs differ' }
& tar.exe -cf $out -C $root --exclude '1938c/bin' --exclude '1938c/target*' --exclude '1938c/build-*' --exclude '1938c/probe-*/target' 1938c
if ($LASTEXITCODE) { throw "tar failed" }
$list = & tar.exe -tf $out
foreach ($need in '1938c/README.md', '1938c/start.sh', '1938c/setup.sh', '1938c/build.sh', '1938c/run.sh', '1938c/run-pair.sh', '1938c/summary.mjs', '1938c/commits.env',
    '1938c/lua/get.lua', '1938c/lua/get-new.lua', '1938c/lua/post-same-origin.lua',
    '1938c/results/margin.md', '1938c/probe-base/Cargo.toml', '1938c/probe-base/Cargo.lock', '1938c/probe-base/src/main.rs',
    '1938c/probe-head/Cargo.toml', '1938c/probe-head/Cargo.lock', '1938c/probe-head/src/main.rs',
    '1938c/src-base.commit', '1938c/src-head.commit', '1938c/src-base/Cargo.lock', '1938c/src-head/Cargo.lock',
    '1938c/src-base/crates/corten/src/kept.rs', '1938c/src-head/crates/corten/src/kept.rs', '1938c/src-head/crates/corten/src/app.rs') {
    if ($list -notcontains $need) { throw "cycles-1938c.tar lacks $need" }
}
if ($list | Where-Object { $_ -notlike '1938c/*' }) { throw 'cycles-1938c.tar holds something outside 1938c/' }
"{0}: {1} entries, {2:N1} MB, sha256 {3}" -f $out, $list.Count, ((Get-Item -LiteralPath $out).Length / 1MB), (Get-FileHash -LiteralPath $out).Hash.ToLower()