# The 1865v3 kit's copy of D:\Temp\cycles\export-src.ps1: exports #1865's base and head trees from
# the commits in 1865\commits.env, the one place they are set. Run on the workstation after
# `git fetch origin`:
#   pwsh -File D:\Temp\cycles\1865v3\export-src.ps1 [-Repo <checkout>]
# Unlike the shared script it leaves the probes' Cargo.lock alone (lock.ps1 makes them) and refuses a
# BASE that is not the merge-base of HEAD with origin/main.
# It checks that BASE is an ancestor of HEAD (the PR merged it) and says whether BASE is still
# origin/main; writes <pr>\src-{base,head} (git archive <commit> crates examples Cargo.toml
# Cargo.lock .cargo), <pr>\src-{base,head}.commit, copies each tree's Cargo.lock into its probe,
# and fills the commits line of <pr>\results\margin.md. -AllowSame lets BASE equal HEAD (a
# compile check only, never a measurement).
param(
    [string]$Pr = '1865',
    [string]$Repo = 'D:\Temp\up\i1825'
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$dir = [IO.Path]::GetFullPath((Join-Path $root $Pr))
if (-not $dir.StartsWith("$root\") -or -not (Test-Path "$dir\commits.env")) { throw "no $dir\commits.env" }
$commits = @{}
foreach ($line in Get-Content "$dir\commits.env") {
    if ($line -match '^\s*([A-Z_]+)=([0-9a-fA-F]+)\s*$') { $commits[$Matches[1]] = $Matches[2] }
}
foreach ($k in 'BASE', 'HEAD') { if (-not $commits[$k]) { throw "commits.env sets no $k" } }
$git = { param([string[]]$a) $out = & git -C $Repo @a; if ($LASTEXITCODE) { throw "git $($a -join ' ') failed" }; $out }
$base = & $git @('rev-parse', '--verify', "$($commits.BASE)^{commit}")
$head = & $git @('rev-parse', '--verify', "$($commits.HEAD)^{commit}")
if ($base -eq $head) { throw "BASE and HEAD are both ${base}: set HEAD to the PR's head" }
& git -C $Repo merge-base --is-ancestor $base $head
if ($LASTEXITCODE) { throw "BASE $base is not an ancestor of HEAD $head" }
$main = & $git @('rev-parse', 'origin/main')
$mergeBase = & $git @('merge-base', $head, 'origin/main')
"BASE $base; HEAD $head; merge-base(HEAD, origin/main) $mergeBase; origin/main $main"
if ($mergeBase -ne $base) { throw "BASE is not the merge-base of HEAD with origin/main ($mergeBase)" }
foreach ($side in @(@('base', $base), @('head', $head))) {
    $name, $sha = $side
    $src = Join-Path $dir "src-$name"
    if (Test-Path $src) {
        $full = (Resolve-Path $src).Path
        if (-not $full.StartsWith("$dir\src-")) { throw "refusing to remove $full" }
        Remove-Item -LiteralPath $full -Recurse -Force
    }
    New-Item -ItemType Directory $src | Out-Null
    $tar = Join-Path $dir "src-$name.tar"
    & $git @('-c', 'core.autocrlf=false', 'archive', '--format=tar', '-o', $tar, $sha, 'crates', 'examples', 'Cargo.toml', 'Cargo.lock', '.cargo') | Out-Null
    & tar.exe -xf $tar -C $src
    if ($LASTEXITCODE) { throw "tar failed for $tar" }
    Remove-Item -LiteralPath $tar
    [IO.File]::WriteAllText((Join-Path $dir "src-$name.commit"), "$sha`n")
}
$margin = Join-Path $dir 'results\margin.md'
$text = [IO.File]::ReadAllText($margin)
$line = "Base ``$base``, head ``$head`` (from commits.env; merge-base of the head with origin/main: ``$mergeBase``; origin/main at export: ``$main``)."
$text = [regex]::Replace($text, '(?m)^<!-- commits -->.*$', "<!-- commits --> $line")
[IO.File]::WriteAllText($margin, $text)
"exported $dir"