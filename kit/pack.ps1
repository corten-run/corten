# pack.ps1: writes D:\Temp\cycles\cycles-1824f.tar for corten-run/corten#1824's kit (1824f): 1824f/
# with its scripts, the probe, main's tree (src-main), the candidate's diff and results/margin.md
# alone, without any build or local scratch. Upload it as /root/cycles-1824f.tar, then (root):
#   tar -xOf /root/cycles-1824f.tar 1824f/start.sh >/root/start.sh && sh /root/start.sh
$ErrorActionPreference = 'Stop'
$root = 'D:\Temp\cycles'
$kit = Join-Path $root '1824f'
$out = Join-Path $root 'cycles-1824f.tar'
$extra = Get-ChildItem -LiteralPath (Join-Path $kit 'results') -Force | Where-Object Name -ne 'margin.md'
if ($extra) { throw "1824f\results holds more than margin.md: $($extra.Name -join ', ')" }
$main = (Get-Content -LiteralPath (Join-Path $kit 'src-main.commit')).Trim()
$head = (Get-Content -LiteralPath (Join-Path $kit 'src-head.commit')).Trim()
$env = Get-Content -LiteralPath (Join-Path $kit 'commits.env')
if ($env -notcontains "MAIN=$main") { throw "src-main.commit ($main) is not commits.env's MAIN" }
if ($env -notcontains "HEAD=$head") { throw "src-head.commit ($head) is not commits.env's HEAD" }
if ((Get-FileHash (Join-Path $kit 'probe\Cargo.lock')).Hash -ne (Get-FileHash (Join-Path $kit 'src-main\Cargo.lock')).Hash) { throw 'probe\Cargo.lock is not src-main''s' }
$margin = [IO.File]::ReadAllText((Join-Path $kit 'results\margin.md'))
if ($margin -notmatch "Main ``$main``") { throw 'margin.md does not name main' }
if ($margin -notmatch "candidate ``$head``") { throw 'margin.md does not name the candidate' }
if ($margin.Contains('TIME-') -or $margin.Contains('HEAD-')) { throw 'margin.md has a placeholder left' }
# Exported from git: the diff is git's from main to the candidate under crates/, and src-main is
# main's tree file for file (each file's blob id against git ls-tree).
$repo = if ($env:I1824_REPO) { $env:I1824_REPO } else { 'D:\Temp\up\i1824b' }
& git -C $repo cat-file -e "$head^{commit}"; if ($LASTEXITCODE) { throw "$head is not a commit in $repo" }
& git -C $repo merge-base --is-ancestor $main $head; if ($LASTEXITCODE) { throw "$main is not an ancestor of $head" }
$want = (& git -C $repo diff --no-color $main $head -- crates/ | Out-String -Stream) -join "`n"
$have = ([IO.File]::ReadAllText((Join-Path $kit 'variants\head.diff'))).TrimEnd("`n")
if ($want.TrimEnd("`n") -ne $have) { throw 'variants\head.diff is not git diff main..candidate -- crates/' }
$tree = & git -C $repo ls-tree -r $main -- .cargo crates examples Cargo.lock Cargo.toml
if ($LASTEXITCODE) { throw 'git ls-tree failed' }
$blobs = @{}; foreach ($l in $tree) { $p = $l -split "`t", 2; $blobs[$p[1]] = ($p[0] -split ' ')[2] }
$src = Join-Path $kit 'src-main'
$local = Get-ChildItem -LiteralPath $src -File -Recurse -Force | ForEach-Object { $_.FullName.Substring($src.Length + 1).Replace('\', '/') }
if ($local.Count -ne $blobs.Count) { throw "src-main holds $($local.Count) files, main's tree $($blobs.Count)" }
$ids = $local | ForEach-Object { Join-Path $src $_ } | & git -C $repo hash-object --no-filters --stdin-paths
for ($i = 0; $i -lt $local.Count; $i++) { if ($blobs[$local[$i]] -ne $ids[$i]) { throw "src-main/$($local[$i]) is not main's" } }
$diff = [IO.File]::ReadAllText((Join-Path $kit 'variants\head.diff'))
if (-not $diff.Contains('crates/corten/src/kept.rs')) { throw 'head.diff does not change kept.rs' }
$files = Get-ChildItem -LiteralPath $kit -File -Recurse | Where-Object { $_.FullName -notmatch '\\(src-main|local|bin|work)\\' -and $_.Extension -in '.sh', '.mjs', '.sed', '.txt', '.toml', '.lua', '.diff', '.rs', '.env', '.md', '.commit' }
foreach ($f in $files) {
    if ([IO.File]::ReadAllText($f.FullName).Contains("`r")) { throw "$($f.FullName) has a carriage return" }
}
& tar.exe -cf $out -C $root --exclude '1824f/bin' --exclude '1824f/work' --exclude '1824f/local' --exclude '1824f/allocmap' --exclude '1824f/build-*.log' --exclude '1824f/probe/target' --exclude '1824f/run.out' 1824f
if ($LASTEXITCODE) { throw "tar failed" }
$list = & tar.exe -tf $out
foreach ($need in '1824f/README.md', '1824f/start.sh', '1824f/setup.sh', '1824f/build.sh', '1824f/run.sh', '1824f/run-pair.sh', '1824f/summary.mjs',
    '1824f/commits.env', '1824f/src-main.commit', '1824f/src-head.commit', '1824f/results/margin.md', '1824f/variants/head.diff', '1824f/mask.sed',
    '1824f/checks-new.txt', '1824f/checks-page.txt', '1824f/checks-private.txt', '1824f/checks-json.txt', '1824f/lua/new-url.lua',
    '1824f/lua/new-url-json.lua', '1824f/lua/get.lua', '1824f/probe/Cargo.toml', '1824f/probe/Cargo.lock', '1824f/probe/src/main.rs',
    '1824f/src-main/Cargo.lock', '1824f/src-main/crates/corten/src/kept.rs') {
    if ($list -notcontains $need) { throw "cycles-1824f.tar lacks $need" }
}
if ($list | Where-Object { $_ -notlike '1824f/*' }) { throw 'cycles-1824f.tar holds something outside 1824f/' }
if ($list | Where-Object { $_ -like '1824f/local/*' -or $_ -like '1824f/bin/*' -or $_ -like '1824f/work/*' -or $_ -like '1824f/allocmap/*' }) { throw 'cycles-1824f.tar holds a build or local scratch' }
"{0}: {1} entries, {2:N1} MB" -f $out, $list.Count, ((Get-Item -LiteralPath $out).Length / 1MB)
