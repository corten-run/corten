# pack.ps1: writes D:\Temp\cycles\cycles-1824b.tar for corten-run/corten#1824's kit (1824b): 1824b/
# with its scripts, the probe, faultcost, main's tree (src-main), the variant's diff and
# results/margin.md alone, without any build or local scratch. Upload it as /root/cycles-1824b.tar,
# then (root): tar -xOf /root/cycles-1824b.tar 1824b/start.sh >/root/start.sh && sh /root/start.sh
$ErrorActionPreference = 'Stop'
$root = 'D:\Temp\cycles'
$kit = Join-Path $root '1824b'
$out = Join-Path $root 'cycles-1824b.tar'
$extra = Get-ChildItem -LiteralPath (Join-Path $kit 'results') -Force | Where-Object Name -ne 'margin.md'
if ($extra) { throw "1824b\results holds more than margin.md: $($extra.Name -join ', ')" }
$commit = (Get-Content -LiteralPath (Join-Path $kit 'src-main.commit')).Trim()
if ((Get-Content -LiteralPath (Join-Path $kit 'commits.env')) -notcontains "MAIN=$commit") { throw "src-main.commit ($commit) is not commits.env's MAIN" }
if ((Get-FileHash (Join-Path $kit 'probe\Cargo.lock')).Hash -ne (Get-FileHash (Join-Path $kit 'src-main\Cargo.lock')).Hash) { throw 'probe\Cargo.lock is not src-main''s' }
$margin = [IO.File]::ReadAllText((Join-Path $kit 'results\margin.md'))
if ($margin -notmatch "Main ``$commit``") { throw 'margin.md does not name the commit' }
if ($margin.Contains('TIME-')) { throw 'margin.md has a placeholder left' }
$files = Get-ChildItem -LiteralPath $kit -File -Recurse | Where-Object { $_.FullName -notmatch '\\(src-main|local|bin|work)\\' -and $_.Extension -in '.sh', '.mjs', '.sed', '.txt', '.toml', '.lua', '.diff', '.rs', '.env', '.md' }
foreach ($f in $files) {
    if ([IO.File]::ReadAllText($f.FullName).Contains("`r")) { throw "$($f.FullName) has a carriage return" }
}
& tar.exe -cf $out -C $root --exclude '1824b/bin' --exclude '1824b/work' --exclude '1824b/local' --exclude '1824b/build-*.log' --exclude '1824b/probe/target' --exclude '1824b/faultcost/target' --exclude '1824b/run.out' 1824b
if ($LASTEXITCODE) { throw "tar failed" }
$list = & tar.exe -tf $out
foreach ($need in '1824b/README.md', '1824b/start.sh', '1824b/setup.sh', '1824b/build.sh', '1824b/run.sh', '1824b/run-pair.sh', '1824b/summary.mjs',
    '1824b/commits.env', '1824b/src-main.commit', '1824b/results/margin.md', '1824b/variants/populate.diff', '1824b/mask.sed',
    '1824b/checks-new.txt', '1824b/checks-page.txt', '1824b/checks-private.txt', '1824b/lua/new-url.lua', '1824b/lua/get.lua',
    '1824b/probe/Cargo.toml', '1824b/probe/Cargo.lock', '1824b/probe/src/main.rs', '1824b/faultcost/Cargo.toml', '1824b/faultcost/src/main.rs',
    '1824b/src-main/Cargo.lock', '1824b/src-main/crates/corten/src/kept.rs') {
    if ($list -notcontains $need) { throw "cycles-1824b.tar lacks $need" }
}
if ($list | Where-Object { $_ -notlike '1824b/*' }) { throw 'cycles-1824b.tar holds something outside 1824b/' }
if ($list | Where-Object { $_ -like '1824b/local/*' -or $_ -like '1824b/bin/*' -or $_ -like '1824b/work/*' }) { throw 'cycles-1824b.tar holds a build or local scratch' }
"{0}: {1} entries, {2:N1} MB" -f $out, $list.Count, ((Get-Item -LiteralPath $out).Length / 1MB)