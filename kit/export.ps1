# export.ps1: writes 1846w's two trees from commits.env, the one place its commits are set:
# src-{base,head} (git archive <commit> crates examples Cargo.toml Cargo.lock .cargo) and
# src-{base,head}.commit, and fills the commits line of results/margin.md. Run on the workstation:
#   pwsh -File D:\Temp\cycles\1846w\export.ps1 [-Repo <checkout>]
# Checks that BASE is an ancestor of HEAD and says whether BASE is the merge-base with origin/main.
param([string]$Repo = 'D:\Temp\up\i1793')
$ErrorActionPreference = 'Stop'
$dir = 'D:\Temp\cycles\1846w'
$commits = @{}
foreach ($line in Get-Content (Join-Path $dir 'commits.env')) {
    if ($line -match '^\s*([A-Z_]+)=([0-9a-fA-F]+)\s*$') { $commits[$Matches[1]] = $Matches[2] }
}
foreach ($k in 'BASE', 'HEAD') { if (-not $commits[$k]) { throw "commits.env sets no $k" } }
$git = { param([string[]]$a) $out = & git -C $Repo @a; if ($LASTEXITCODE) { throw "git $($a -join ' ') failed" }; $out }
$base = & $git @('rev-parse', '--verify', "$($commits.BASE)^{commit}")
$head = & $git @('rev-parse', '--verify', "$($commits.HEAD)^{commit}")
if ($base -eq $head) { throw "BASE and HEAD are both $base" }
& git -C $Repo merge-base --is-ancestor $base $head
if ($LASTEXITCODE) { throw "BASE $base is not an ancestor of HEAD $head" }
$main = & $git @('rev-parse', 'origin/main')
$mergeBase = & $git @('merge-base', $head, 'origin/main')
"BASE $base; HEAD $head; merge-base(HEAD, origin/main) $mergeBase; origin/main $main"
if ($mergeBase -ne $base) { Write-Warning "BASE is not the merge-base of HEAD with origin/main ($mergeBase)" }
foreach ($side in @(@('base', $base), @('head', $head))) {
    $name, $sha = $side
    $src = Join-Path $dir "src-$name"
    if (Test-Path -LiteralPath $src) {
        $full = (Resolve-Path -LiteralPath $src).Path
        if (-not $full.StartsWith("$dir\src-")) { throw "refusing to remove $full" }
        Remove-Item -LiteralPath $full -Recurse -Force
    }
    New-Item -ItemType Directory $src | Out-Null
    $tar = Join-Path $dir "src-$name.tar"
    & $git @('archive', '--format=tar', '-o', $tar, $sha, 'crates', 'examples', 'Cargo.toml', 'Cargo.lock', '.cargo') | Out-Null
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
