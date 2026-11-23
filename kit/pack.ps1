# pack.ps1: writes D:\Temp\cycles\cycles-1846w.tar (corten-run/corten#1846's held-value wait
# alone, 1846w): 1846w/ with its scripts, the probe, the base and head trees (export.ps1) and
# results/margin.md alone, without any build or dry run. Upload it as /root/cycles-1846w.tar with
# start.sh as /root/start.sh, then: sh /root/start.sh
$ErrorActionPreference = 'Stop'
$root = 'D:\Temp\cycles'
$kit = Join-Path $root '1846w'
$out = Join-Path $root 'cycles-1846w.tar'
$extra = Get-ChildItem -LiteralPath (Join-Path $kit 'results') -Force | Where-Object Name -ne 'margin.md'
if ($extra) { throw "1846w\results holds more than margin.md: $($extra.Name -join ', ')" }
$env = Get-Content -LiteralPath (Join-Path $kit 'commits.env')
foreach ($side in 'base', 'head') {
    $commit = (Get-Content -LiteralPath (Join-Path $kit "src-$side.commit")).Trim()
    if ($env -notcontains "$($side.ToUpper())=$commit") { throw "src-$side.commit ($commit) is not commits.env's $($side.ToUpper())" }
}
if (-not (Select-String -LiteralPath (Join-Path $kit 'src-head\crates\corten\src\kept.rs') -Pattern 'static LOCKING' -Quiet)) { throw "src-head has no LOCKING hook" }
$margin = [IO.File]::ReadAllText((Join-Path $kit 'results\margin.md'))
if ($margin -notmatch '(?m)^<!-- commits --> Base `[0-9a-f]{40}`, head `[0-9a-f]{40}`') { throw 'margin.md has no commits line (run export.ps1)' }
if ($margin.Contains('TIME-ESTIMATE')) { throw 'margin.md has no time estimate' }
& node (Join-Path $kit 'check-summary.mjs') | Out-Null
if ($LASTEXITCODE) { throw 'check-summary.mjs failed' }
$files = Get-ChildItem -LiteralPath $kit -File -Recurse | Where-Object { $_.FullName -notmatch '\\(src-(base|head)|dryrun)\\' -and $_.Extension -in '.sh', '.mjs', '.rs', '.env', '.md', '.commit' }
foreach ($f in $files) {
    if ([IO.File]::ReadAllText($f.FullName).Contains("`r")) { throw "$($f.FullName) has a carriage return" }
}
& tar.exe -cf $out -C $root --exclude '1846w/bin' --exclude '1846w/wait-src-*' --exclude '1846w/build-wait-*' --exclude '1846w/run.out' --exclude '1846w/dryrun' --exclude '1846w/*.ps1' 1846w
if ($LASTEXITCODE) { throw "tar failed" }
$list = & tar.exe -tf $out
foreach ($need in '1846w/start.sh', '1846w/setup.sh', '1846w/build.sh', '1846w/run.sh', '1846w/wait.sh', '1846w/summary-wait.mjs',
    '1846w/check-summary.mjs', '1846w/stats.mjs', '1846w/wait/probe_wait.rs', '1846w/wait/side-base.rs', '1846w/wait/side-head.rs',
    '1846w/wait/kept-mod.rs', '1846w/commits.env', '1846w/README.md', '1846w/src-base.commit', '1846w/src-head.commit',
    '1846w/results/margin.md', '1846w/src-base/Cargo.lock', '1846w/src-head/Cargo.lock', '1846w/src-base/crates/corten/src/kept.rs',
    '1846w/src-head/crates/corten/src/kept.rs') {
    if ($list -notcontains $need) { throw "cycles-1846w.tar lacks $need" }
}
if ($list | Where-Object { $_ -notlike '1846w/*' }) { throw 'cycles-1846w.tar holds something outside 1846w/' }
"{0}: {1} entries, {2:N1} MB, sha256 {3}" -f $out, $list.Count, ((Get-Item -LiteralPath $out).Length / 1MB), (Get-FileHash -LiteralPath $out).Hash.ToLower()
