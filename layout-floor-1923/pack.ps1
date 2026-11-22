# pack.ps1: writes D:\Temp\cycles\cycles-1923.tar for setup.sh (corten-run/corten#1923's A/A
# kit): 1923/ with its scripts, the probe, main's tree (src-main, git archive of commits.env's
# MAIN), the layout patches and results/margin.md alone, without any build. Everything is under
# 1923/, so it unpacks beside other kits under /m. Upload it as /root/cycles-1923.tar, then (root):
#   mkdir -p /m && tar -xf /root/cycles-1923.tar -C /m && sh /m/1923/setup.sh
#   nohup sh /m/1923/run.sh >/m/1923/run.out 2>&1 &
$ErrorActionPreference = 'Stop'
$root = 'D:\Temp\cycles'
$kit = Join-Path $root '1923'
$out = Join-Path $root 'cycles-1923.tar'
$extra = Get-ChildItem -LiteralPath (Join-Path $kit 'results') -Force | Where-Object Name -ne 'margin.md'
if ($extra) { throw "1923\results holds more than margin.md: $($extra.Name -join ', ')" }
$commit = (Get-Content -LiteralPath (Join-Path $kit 'src-main.commit')).Trim()
if ((Get-Content -LiteralPath (Join-Path $kit 'commits.env')) -notcontains "MAIN=$commit") { throw "src-main.commit ($commit) is not commits.env's MAIN" }
foreach ($f in Get-ChildItem -LiteralPath $kit -File | Where-Object { $_.Extension -in '.sh', '.mjs', '.diff', '.sed', '.txt', '.toml', '.lua' }) {
    if ([IO.File]::ReadAllText($f.FullName).Contains("`r")) { throw "$($f.Name) has a carriage return" }
}
& tar.exe -cf $out -C $root --exclude '1923/bin' --exclude '1923/work' --exclude '1923/build-*.log' --exclude '1923/probe/target' --exclude '1923/run.out' 1923
if ($LASTEXITCODE) { throw "tar failed" }
$list = & tar.exe -tf $out
foreach ($need in '1923/setup.sh', '1923/build.sh', '1923/run.sh', '1923/run-pair-fresh.sh', '1923/run-pair.sh', '1923/check-warm.sh',
    '1923/summary.mjs', '1923/summary-events.mjs', '1923/stats.mjs', '1923/report.mjs', '1923/layout.mjs', '1923/commits.env',
    '1923/src-main.commit', '1923/results/margin.md', '1923/probe/Cargo.toml', '1923/probe/Cargo.lock', '1923/probe/src/main.rs',
    '1923/variants/pad40.diff', '1923/variants/pad3100.diff', '1923/checks-plain.txt', '1923/checks-hit.txt', '1923/mask.sed',
    '1923/lua/get.lua', '1923/src-main/Cargo.lock', '1923/src-main/crates/corten/src/router.rs') {
    if ($list -notcontains $need) { throw "cycles-1923.tar lacks $need" }
}
if ($list | Where-Object { $_ -notlike '1923/*' }) { throw 'cycles-1923.tar holds something outside 1923/' }
"{0}: {1} entries, {2:N1} MB" -f $out, $list.Count, ((Get-Item -LiteralPath $out).Length / 1MB)