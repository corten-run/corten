# pack.ps1: writes D:\Temp\cycles\cycles-1846r2.tar for setup.sh (corten-run/corten#1846's fourth
# quiet-host run, its merge with main's 7a275ef15): 1846r2/ with its scripts, the probes, the base and head trees (src-base, src-head,
# git archive of commits.env's BASE and HEAD, written by export-src.ps1 -Pr 1846r2) and
# results/margin.md alone, without any build. Everything is under 1846r2/, so it unpacks beside
# other kits under /m. Upload it as /root/cycles-1846r2.tar, then (root):
#   mkdir -p /m && tar -xf /root/cycles-1846r2.tar -C /m && sh /m/1846r2/setup.sh
#   nohup sh /m/1846r2/run.sh >/m/1846r2/run.out 2>&1 &
$ErrorActionPreference = 'Stop'
$root = 'D:\Temp\cycles'
$kit = Join-Path $root '1846r2'
$out = Join-Path $root 'cycles-1846r2.tar'
$extra = Get-ChildItem -LiteralPath (Join-Path $kit 'results') -Force | Where-Object Name -ne 'margin.md'
if ($extra) { throw "1846r2\results holds more than margin.md: $($extra.Name -join ', ')" }
$env = Get-Content -LiteralPath (Join-Path $kit 'commits.env')
foreach ($side in 'base', 'head') {
    $commit = (Get-Content -LiteralPath (Join-Path $kit "src-$side.commit")).Trim()
    if ($env -notcontains "$($side.ToUpper())=$commit") { throw "src-$side.commit ($commit) is not commits.env's $($side.ToUpper())" }
    $lock = Join-Path $kit "probe-$side\Cargo.lock"
    if ((Get-FileHash $lock).Hash -ne (Get-FileHash (Join-Path $kit "src-$side\Cargo.lock")).Hash) { throw "probe-$side\Cargo.lock is not src-$side's" }
}
$margin = [IO.File]::ReadAllText((Join-Path $kit 'results\margin.md'))
if ($margin -notmatch '(?m)^<!-- commits --> Base `[0-9a-f]{40}`') { throw 'margin.md has no commits line (run export-src.ps1 -Pr 1846r2)' }
if ($margin.Contains('TIME-ESTIMATE')) { throw 'margin.md has no time estimate' }
if (-not $margin.Contains('## Pass 3')) { throw 'margin.md does not declare pass 3' }
$files = Get-ChildItem -LiteralPath $kit -File -Recurse | Where-Object { $_.FullName -notmatch '\\src-(base|head)\\' -and $_.Extension -in '.sh', '.mjs', '.sed', '.txt', '.toml', '.lua', '.diff', '.rs', '.env', '.md' }
foreach ($f in $files) {
    if ([IO.File]::ReadAllText($f.FullName).Contains("`r")) { throw "$($f.FullName) has a carriage return" }
}
& tar.exe -cf $out -C $root --exclude '1846r2/bin' --exclude '1846r2/build-*.log' --exclude '1846r2/probe-*/target' --exclude '1846r2/wait-src-*' --exclude '1846r2/build-wait-*' --exclude '1846r2/run.out' --exclude '1846r2/refused.env' 1846r2
if ($LASTEXITCODE) { throw "tar failed" }
$list = & tar.exe -tf $out
foreach ($need in '1846r2/setup.sh', '1846r2/build.sh', '1846r2/run.sh', '1846r2/run-pair-fresh.sh', '1846r2/run-pair.sh', '1846r2/check-warm.sh',
    '1846r2/calibrate-refused.sh', '1846r2/wait.sh', '1846r2/summary-wait.mjs', '1846r2/wait/probe_wait.rs', '1846r2/wait/side-base.rs',
    '1846r2/wait/side-head.rs', '1846r2/wait/kept-mod.rs', '1846r2/summary.mjs', '1846r2/summary-events.mjs', '1846r2/stats.mjs', '1846r2/commits.env', '1846r2/README.md',
    '1846r2/src-base.commit', '1846r2/src-head.commit', '1846r2/results/margin.md',
    '1846r2/probe-base/Cargo.toml', '1846r2/probe-base/Cargo.lock', '1846r2/probe-base/src/main.rs',
    '1846r2/probe-head/Cargo.toml', '1846r2/probe-head/Cargo.lock', '1846r2/probe-head/src/main.rs',
    '1846r2/checks-browser.txt', '1846r2/checks-gzip.txt', '1846r2/checks-refused.txt', '1846r2/checks-json-browser.txt',
    '1846r2/mask.sed', '1846r2/mask-browser.sed', '1846r2/expect-browser.diff', '1846r2/expect-json-browser.diff',
    '1846r2/lua/get-ae-browser.lua', '1846r2/lua/get-ae-gzip.lua', '1846r2/lua/get-json-browser.lua',
    '1846r2/src-base/Cargo.lock', '1846r2/src-head/Cargo.lock', '1846r2/src-base/crates/corten/src/kept.rs', '1846r2/src-head/crates/corten/src/kept.rs') {
    if ($list -notcontains $need) { throw "cycles-1846r2.tar lacks $need" }
}
if ($list | Where-Object { $_ -notlike '1846r2/*' }) { throw 'cycles-1846r2.tar holds something outside 1846r2/' }
"{0}: {1} entries, {2:N1} MB" -f $out, $list.Count, ((Get-Item -LiteralPath $out).Length / 1MB)
