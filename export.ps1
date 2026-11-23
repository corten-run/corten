# export.ps1: writes 1965\src-{main,base,head} (git archive of crates examples Cargo.toml
# Cargo.lock .cargo at commits.env's MAIN, BASE and HEAD) and src-*.commit, after checking that
# BASE is HEAD's first parent and both are on MAIN's history. Run on the workstation after
# `git fetch origin`:  pwsh -File D:\Temp\cycles\1965\export.ps1
param([string]$Repo = 'D:\Users\ToddS\Source\Repos\corten')
$ErrorActionPreference = 'Stop'
$dir = 'D:\Temp\cycles\1965'
$c = @{}
foreach ($line in Get-Content "$dir\commits.env") { if ($line -match '^([A-Z]+)=([0-9a-f]{40})$') { $c[$Matches[1]] = $Matches[2] } }
foreach ($k in 'MAIN', 'BASE', 'HEAD') { if (-not $c[$k]) { throw "commits.env sets no $k" } }
$first = (& git -C $Repo rev-parse "$($c.HEAD)^1").Trim()
if ($first -ne $c.BASE) { throw "BASE $($c.BASE) is not HEAD's first parent ($first)" }
foreach ($k in 'BASE', 'HEAD') { & git -C $Repo merge-base --is-ancestor $c[$k] $c.MAIN; if ($LASTEXITCODE) { throw "$k is not on MAIN's history" } }
foreach ($side in 'main', 'base', 'head') {
    $sha = $c[$side.ToUpper()]
    $src = Join-Path $dir "src-$side"
    if (Test-Path $src) {
        $full = (Resolve-Path $src).Path
        if ($full -ne "$dir\src-$side") { throw "refusing to remove $full" }
        Remove-Item -LiteralPath $full -Recurse -Force
    }
    New-Item -ItemType Directory $src | Out-Null
    $tar = Join-Path $dir "src-$side.tar"
    & git -C $Repo archive --format=tar -o $tar $sha crates examples Cargo.toml Cargo.lock .cargo
    if ($LASTEXITCODE) { throw "git archive failed for $side" }
    & tar.exe -xf $tar -C $src
    if ($LASTEXITCODE) { throw "tar failed for $tar" }
    Remove-Item -LiteralPath $tar
    [IO.File]::WriteAllText((Join-Path $dir "src-$side.commit"), "$sha`n")
    "src-$side $sha"
}
