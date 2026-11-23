# pack.ps1: writes D:\Temp\cycles\cycles-1865v3.tar for setup.sh: this kit's scripts, lua/, and
# 1865/ (probes with their declared locks, source trees, checks, mask, the passes, gate.mjs,
# icache-summary.mjs and results/margin.md), without builds, history or any result. Upload it as
# /root/cycles-1865v3.tar beside setup.sh, run `sh /root/setup.sh`, then `sh /m/run-all.sh`.
# Export the trees and make the locks first (export-src.ps1, lock.sh).
$ErrorActionPreference = 'Stop'
$kit = $PSScriptRoot
$out = Join-Path (Split-Path $kit) 'cycles-1865v3.tar'
$top = Get-ChildItem -LiteralPath $kit -File | Where-Object { $_.Extension -in '.sh', '.mjs' } | ForEach-Object Name
$results = Get-ChildItem -LiteralPath (Join-Path $kit '1865\results') -Force | ForEach-Object Name
if (($results -join ',') -ne 'margin.md') { throw "1865\results holds more than margin.md: $($results -join ', ')" }
Push-Location $kit
try {
    & (Join-Path $env:SystemRoot 'System32\tar.exe') -cf $out --exclude '1865/bin' --exclude '1865/history' --exclude '1865/build-*.log' --exclude 'target-1865' --exclude '1865/src-*/target' @top lua 1865
    if ($LASTEXITCODE) { throw "tar failed" }
} finally { Pop-Location }
$list = & (Join-Path $env:SystemRoot 'System32\tar.exe') -tf $out
foreach ($need in 'run-pair.sh', 'run-pair-fresh.sh', 'check-warm.sh', 'build.sh', 'setup.sh', 'run-all.sh', 'lua/get.lua',
    '1865/run-fresh.sh', '1865/run-icache.sh', '1865/run-pair-icache.sh', '1865/icache-summary.mjs', '1865/gate.mjs',
    '1865/results/margin.md', '1865/locks.sha256', '1865/mask.sed', '1865/commits.env',
    '1865/checks-private.txt', '1865/checks-off.txt', '1865/checks-hit.txt', '1865/checks-staged.txt', '1865/checks-unstaged.txt',
    '1865/checks-unstaged-one.txt', '1865/checks-fallback.txt', '1865/checks-nostore.txt', '1865/checks-immutable.txt',
    '1865/probe-base/Cargo.toml', '1865/probe-head/Cargo.toml', '1865/probe-base/Cargo.lock', '1865/probe-head/Cargo.lock',
    '1865/probe-base/src/main.rs', '1865/probe-head/src/main.rs', '1865/src-base.commit', '1865/src-head.commit',
    '1865/src-base/Cargo.lock', '1865/src-head/Cargo.lock') {
    if ($list -notcontains $need) { throw "cycles-1865v3.tar lacks $need" }
}
if ($list | Where-Object { $_ -like '1865/results/*' -and $_ -ne '1865/results/margin.md' -and $_ -ne '1865/results/' }) { throw 'the tar holds results beside margin.md' }
if ($list | Where-Object { $_ -like '1865/bin*' -or $_ -like 'target-1865*' -or $_ -like '1865/history*' }) { throw 'the tar holds a build or history' }
"{0}: {1} entries, {2:N1} MB" -f $out, $list.Count, ((Get-Item -LiteralPath $out).Length / 1MB)
