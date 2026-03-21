<#
.SYNOPSIS
    Create a new release by bumping version, tagging, and pushing.

.PARAMETER Bump
    Version component to increment: patch (default), minor, or major.

.EXAMPLE
    .\release.ps1
    .\release.ps1 -Bump minor
    .\release.ps1 -Bump major
#>
param(
    [ValidateSet('patch', 'minor', 'major')]
    [string]$Bump = 'patch'
)

$ErrorActionPreference = 'Stop'

# ── Guards ────────────────────────────────────────────────────

$branch = git rev-parse --abbrev-ref HEAD
if ($branch -ne 'main') {
    Write-Error "Releases must be made from main (current: $branch)"
}

$status = git status --porcelain
if ($status) {
    Write-Error "Working tree is not clean. Commit or stash changes first."
}

git fetch --quiet origin main
$behind = git rev-list --count HEAD..origin/main
if ($behind -gt 0) {
    Write-Error "Local main is $behind commit(s) behind origin/main. Pull first."
}

# ── Bump version ──────────────────────────────────────────────

Write-Host "Bumping $Bump version..." -ForegroundColor Cyan
npm version $Bump --message "chore: release v%s"
if ($LASTEXITCODE -ne 0) { Write-Error "npm version failed" }

$version = node -p "require('./package.json').version"
Write-Host "  -> v$version" -ForegroundColor Green

# ── Push ──────────────────────────────────────────────────────

Write-Host "Pushing commit and tag..." -ForegroundColor Cyan
git push origin main --follow-tags
if ($LASTEXITCODE -ne 0) { Write-Error "git push failed" }

Write-Host ""
Write-Host "Release v$version triggered." -ForegroundColor Green
Write-Host "GitHub Actions will build and publish the release automatically."
Write-Host "https://github.com/Filyus/MSDF-Kit/releases/tag/v$version"
