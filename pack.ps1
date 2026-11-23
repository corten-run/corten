# pack.ps1: writes D:\Temp\cycles\cycles-1846r3.tar for start.sh (corten-run/corten#1846's fifth
# quiet-host run, the branch merged with main's fef1f83de against that main): 1846r3/ with its
# scripts, the probes, the base and head trees (src-base, src-head, git archive of commits.env's BASE
# and HEAD, written by export-src.ps1 -Pr 1846r3 -Repo <the branch's checkout>) and results/margin.md
# alone, without any build. It runs check-gate.mjs first and refuses to pack if any of its checks
# fails. Everything is under 1846r3/, so it unpacks beside other kits under /m. Upload it as
# /root/cycles-1846r3.tar and start.sh as /root/start.sh, then (root): sh /root/start.sh
$ErrorActionPreference = 'Stop'
$root = 'D:\Temp\cycles'
$kit = Join-Path $root '1846r3'
$out = Join-Path $root 'cycles-1846r3.tar'
$extra = Get-ChildItem -LiteralPath (Join-Path $kit 'results') -Force | Where-Object Name -ne 'margin.md'
if ($extra) { throw "1846r3\results holds more than margin.md: $($extra.Name -join ', ')" }
$env = Get-Content -LiteralPath (Join-Path $kit 'commits.env')
foreach ($side in 'base', 'head') {
    $commit = (Get-Content -LiteralPath (Join-Path $kit "src-$side.commit")).Trim()
    if ($env -notcontains "$($side.ToUpper())=$commit") { throw "src-$side.commit ($commit) is not commits.env's $($side.ToUpper())" }
    $lock = Join-Path $kit "probe-$side\Cargo.lock"
    if ((Get-FileHash $lock).Hash -ne (Get-FileHash (Join-Path $kit "src-$side\Cargo.lock")).Hash) { throw "probe-$side\Cargo.lock is not src-$side's" }
}
$margin = [IO.File]::ReadAllText((Join-Path $kit 'results\margin.md'))
if ($margin -notmatch '(?m)^<!-- commits --> Base `[0-9a-f]{40}`') { throw 'margin.md has no commits line (run export-src.ps1 -Pr 1846r3)' }
if ($margin -cmatch '(?m)^## Pass 3') { throw 'margin.md declares a pass 3 this kit does not run' }
$files = Get-ChildItem -LiteralPath $kit -File -Recurse | Where-Object { $_.FullName -notmatch '\\src-(base|head)\\' -and $_.Extension -in '.sh', '.mjs', '.sed', '.txt', '.toml', '.lua', '.diff', '.rs', '.env', '.md', '.ps1' }
foreach ($f in $files) {
    if ($f.Extension -ne '.ps1' -and [IO.File]::ReadAllText($f.FullName).Contains("`r")) { throw "$($f.FullName) has a carriage return" }
}
& node (Join-Path $kit 'check-gate.mjs')
if ($LASTEXITCODE) { throw "check-gate.mjs failed: gate.mjs does not fail closed" }
& tar.exe -cf $out -C $root --exclude '1846r3/bin' --exclude '1846r3/build-*.log' --exclude '1846r3/probe-*/target' --exclude '1846r3/run.out' --exclude '1846r3/refused.env' --exclude '1846r3/dryrun' 1846r3
if ($LASTEXITCODE) { throw "tar failed" }
$list = & tar.exe -tf $out
foreach ($need in '1846r3/start.sh', '1846r3/setup.sh', '1846r3/build.sh', '1846r3/run.sh', '1846r3/run-pair-fresh.sh', '1846r3/run-pair.sh', '1846r3/check-warm.sh',
    '1846r3/calibrate-refused.sh', '1846r3/gate.mjs', '1846r3/check-gate.mjs', '1846r3/summary.mjs', '1846r3/summary-events.mjs', '1846r3/stats.mjs', '1846r3/commits.env', '1846r3/README.md',
    '1846r3/src-base.commit', '1846r3/src-head.commit', '1846r3/results/margin.md',
    '1846r3/probe-base/Cargo.toml', '1846r3/probe-base/Cargo.lock', '1846r3/probe-base/src/main.rs',
    '1846r3/probe-head/Cargo.toml', '1846r3/probe-head/Cargo.lock', '1846r3/probe-head/src/main.rs',
    '1846r3/checks-browser.txt', '1846r3/checks-gzip.txt', '1846r3/checks-refused.txt', '1846r3/checks-json-browser.txt',
    '1846r3/mask.sed', '1846r3/mask-browser.sed', '1846r3/expect-browser.diff', '1846r3/expect-json-browser.diff',
    '1846r3/lua/get-ae-browser.lua', '1846r3/lua/get-ae-gzip.lua', '1846r3/lua/get-json-browser.lua',
    '1846r3/src-base/Cargo.lock', '1846r3/src-head/Cargo.lock', '1846r3/src-base/crates/corten/src/kept.rs', '1846r3/src-head/crates/corten/src/kept.rs') {
    if ($list -notcontains $need) { throw "cycles-1846r3.tar lacks $need" }
}
if ($list | Where-Object { $_ -notlike '1846r3/*' }) { throw 'cycles-1846r3.tar holds something outside 1846r3/' }
if ($list | Where-Object { $_ -like '1846r3/wait*' -or $_ -like '1846r3/summary-wait*' }) { throw 'cycles-1846r3.tar holds a wait pass' }
"{0}: {1} entries, {2:N1} MB, sha256 {3}" -f $out, $list.Count, ((Get-Item -LiteralPath $out).Length / 1MB), (Get-FileHash -LiteralPath $out -Algorithm SHA256).Hash.ToLower()
