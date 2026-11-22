# pack.ps1: writes D:\Temp\cycles\cycles-1824c.tar for corten-run/corten#1824's kit (1824c): 1824c/
# with its scripts, the probe, faultcost, main's tree (src-main) and results/margin.md alone,
# without any build or local scratch. Upload it as /root/cycles-1824c.tar, then (root):
#   tar -xOf /root/cycles-1824c.tar 1824c/start.sh >/root/start.sh && sh /root/start.sh
$ErrorActionPreference = 'Stop'
$root = 'D:\Temp\cycles'
$kit = Join-Path $root '1824c'
$out = Join-Path $root 'cycles-1824c.tar'
$extra = Get-ChildItem -LiteralPath (Join-Path $kit 'results') -Force | Where-Object Name -ne 'margin.md'
if ($extra) { throw "1824c\results holds more than margin.md: $($extra.Name -join ', ')" }
$commit = (Get-Content -LiteralPath (Join-Path $kit 'src-main.commit')).Trim()
if ((Get-Content -LiteralPath (Join-Path $kit 'commits.env')) -notcontains "MAIN=$commit") { throw "src-main.commit ($commit) is not commits.env's MAIN" }
if ((Get-FileHash (Join-Path $kit 'probe\Cargo.lock')).Hash -ne (Get-FileHash (Join-Path $kit 'src-main\Cargo.lock')).Hash) { throw 'probe\Cargo.lock is not src-main''s' }
$margin = [IO.File]::ReadAllText((Join-Path $kit 'results\margin.md'))
if ($margin -notmatch "Main ``$commit``") { throw 'margin.md does not name the commit' }
if ($margin.Contains('TIME-')) { throw 'margin.md has a placeholder left' }
$files = Get-ChildItem -LiteralPath $kit -File -Recurse | Where-Object { $_.FullName -notmatch '\\(src-main|local|bin|work)\\' -and $_.Extension -in '.sh', '.mjs', '.sed', '.txt', '.toml', '.lua', '.rs', '.env', '.md', '.lock' }
foreach ($f in $files) {
    if ([IO.File]::ReadAllText($f.FullName).Contains("`r")) { throw "$($f.FullName) has a carriage return" }
}
& tar.exe -cf $out -C $root --exclude '1824c/bin' --exclude '1824c/work' --exclude '1824c/local' --exclude '1824c/perf-data' --exclude '1824c/build-*.log' --exclude '1824c/probe/target' --exclude '1824c/faultcost/target' --exclude '1824c/run.out' 1824c
if ($LASTEXITCODE) { throw "tar failed" }
$list = & tar.exe -tf $out
foreach ($need in '1824c/README.md', '1824c/start.sh', '1824c/setup.sh', '1824c/build.sh', '1824c/run.sh', '1824c/run-pair.sh', '1824c/profile.sh',
    '1824c/entries.mjs', '1824c/profile.mjs', '1824c/summary.mjs', '1824c/commits.env', '1824c/src-main.commit', '1824c/results/margin.md',
    '1824c/mask.sed', '1824c/checks-new.txt', '1824c/lua/new-url.lua', '1824c/lua/get.lua',
    '1824c/probe/Cargo.toml', '1824c/probe/Cargo.lock', '1824c/probe/src/main.rs', '1824c/faultcost/Cargo.toml', '1824c/faultcost/Cargo.lock', '1824c/faultcost/src/main.rs',
    '1824c/src-main/Cargo.lock', '1824c/src-main/crates/corten/src/kept.rs') {
    if ($list -notcontains $need) { throw "cycles-1824c.tar lacks $need" }
}
if ($list | Where-Object { $_ -notlike '1824c/*' }) { throw 'cycles-1824c.tar holds something outside 1824c/' }
if ($list | Where-Object { $_ -like '1824c/local/*' -or $_ -like '1824c/bin/*' -or $_ -like '1824c/work/*' -or $_ -like '1824c/perf-data/*' }) { throw 'cycles-1824c.tar holds a build or local scratch' }
"{0}: {1} entries, {2:N1} MB" -f $out, $list.Count, ((Get-Item -LiteralPath $out).Length / 1MB)