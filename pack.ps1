# pack.ps1: writes D:\Temp\cycles\cycles-1965.tar for setup.sh (corten-run/corten#1965's placement
# kit): 1965/ with its scripts, the probe, the three trees (src-main, src-base, src-head, from
# export.ps1) and results/margin.md alone, without any build. Checks first that the trees are
# commits.env's, that margin.md states plan.env's K, R, pad lists, diagnostic and bound rank, that
# the pads are pads.mjs's, that no script has a carriage return, and that check-report.mjs passes. Everything is under 1965/, so it unpacks beside
# other kits under /m. Upload it as /root/cycles-1965.tar, then (root):
#   mkdir -p /m && tar -xf /root/cycles-1965.tar -C /m && sh /m/1965/setup.sh
#   nohup sh /m/1965/run.sh >/m/1965/run.out 2>&1 &
$ErrorActionPreference = 'Stop'
$root = 'D:\Temp\cycles'
$kit = Join-Path $root '1965'
$out = Join-Path $root 'cycles-1965.tar'
$extra = Get-ChildItem -LiteralPath (Join-Path $kit 'results') -Force | Where-Object Name -ne 'margin.md'
if ($extra) { throw "1965\results holds more than margin.md: $($extra.Name -join ', ')" }
$envText = Get-Content -LiteralPath (Join-Path $kit 'commits.env')
foreach ($side in 'main', 'base', 'head') {
    $commit = (Get-Content -LiteralPath (Join-Path $kit "src-$side.commit")).Trim()
    if ($envText -notcontains "$($side.ToUpper())=$commit") { throw "src-$side.commit ($commit) is not commits.env's $($side.ToUpper())" }
    if (-not (Test-Path (Join-Path $kit "src-$side\Cargo.lock"))) { throw "no src-$side (run export.ps1)" }
}
$plan = @{}
foreach ($line in Get-Content -LiteralPath (Join-Path $kit 'plan.env')) { if ($line -match '^([A-Z_]+)="?([^"]*)"?$') { $plan[$Matches[1]] = $Matches[2] } }
$margin = [IO.File]::ReadAllText((Join-Path $kit 'results\margin.md'))
foreach ($need in "K = $($plan.K)", "R = $($plan.R)", "``$($plan.PADS_P)``", "``$($plan.PADS_Q)``", "DIAG_K = $($plan.DIAG_K)", "DIAG_R = $($plan.DIAG_R)", 'the 20th of the 30') {
    if (-not $margin.Contains($need)) { throw "margin.md does not state $need" }
}
foreach ($f in Get-ChildItem -LiteralPath $kit -Recurse -File | Where-Object { $_.FullName -notmatch '\\(src-|bin\\|work\\|capture\\)' -and $_.Extension -in '.sh', '.mjs', '.env', '.sed', '.txt', '.toml', '.lua', '.md', '' }) {
    if ([IO.File]::ReadAllText($f.FullName).Contains("`r")) { throw "$($f.Name) has a carriage return" }
}
& node (Join-Path $kit 'pads.mjs') --check (Join-Path $kit 'plan.env')
if ($LASTEXITCODE) { throw "plan.env's pads are not pads.mjs's" }
& node (Join-Path $kit 'check-report.mjs') | Select-Object -Last 1
if ($LASTEXITCODE) { throw "check-report.mjs failed" }
& tar.exe -cf $out -C $root --exclude '1965/bin' --exclude '1965/pads' --exclude '1965/work' --exclude '1965/capture' --exclude '1965/build-*.log' --exclude '1965/probe/target' --exclude '1965/run.out' --exclude '1965/export.ps1' --exclude '1965/pack.ps1' 1965
if ($LASTEXITCODE) { throw "tar failed" }
$list = & tar.exe -tf $out
foreach ($need in '1965/setup.sh', '1965/build.sh', '1965/run.sh', '1965/verify.sh', '1965/run-pair-fresh.sh', '1965/start.sh',
    '1965/link-capture.mjs', '1965/relink.mjs', '1965/layout.mjs', '1965/stats.mjs', '1965/placement.mjs', '1965/report.mjs',
    '1965/check-report.mjs', '1965/pads.mjs', '1965/plan.sh', '1965/wrap/cc', '1965/plan.env', '1965/commits.env', '1965/README.md', '1965/results/margin.md',
    '1965/src-main.commit', '1965/src-base.commit', '1965/src-head.commit', '1965/probe/Cargo.toml', '1965/probe/src/main.rs',
    '1965/checks-plain.txt', '1965/checks-kept.txt', '1965/checks-verify.txt', '1965/mask.sed', '1965/lua/get.lua',
    '1965/src-main/Cargo.lock', '1965/src-base/Cargo.lock', '1965/src-head/Cargo.lock', '1965/src-head/crates/corten/src/kept.rs') {
    if ($list -notcontains $need) { throw "cycles-1965.tar lacks $need" }
}
if ($list | Where-Object { $_ -notlike '1965/*' }) { throw 'cycles-1965.tar holds something outside 1965/' }
"{0}: {1} entries, {2:N1} MB, sha256 {3}" -f $out, $list.Count, ((Get-Item -LiteralPath $out).Length / 1MB), (Get-FileHash -Algorithm SHA256 -LiteralPath $out).Hash.ToLower()
