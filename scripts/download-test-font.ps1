<#
.SYNOPSIS
    Download a test font for integration tests.
.DESCRIPTION
    Downloads Roboto-Regular.ttf from Google Fonts into test/fixtures/.
#>

$ErrorActionPreference = "Stop"
$ProjectRoot = $PSScriptRoot | Split-Path -Parent
$FixturesDir = Join-Path $ProjectRoot "test\fixtures"
$FontFile = Join-Path $FixturesDir "Roboto-Regular.ttf"

if (Test-Path $FontFile) {
    Write-Host "Font already exists: $FontFile" -ForegroundColor Green
    exit 0
}

if (-not (Test-Path $FixturesDir)) {
    New-Item -ItemType Directory -Path $FixturesDir -Force | Out-Null
}

$Url = "https://github.com/googlefonts/roboto/raw/main/src/hinted/Roboto-Regular.ttf"
Write-Host "Downloading Roboto-Regular.ttf..." -ForegroundColor Cyan

try {
    Invoke-WebRequest -Uri $Url -OutFile $FontFile -UseBasicParsing
    $size = [math]::Round((Get-Item $FontFile).Length / 1KB)
    Write-Host "  -> Roboto-Regular.ttf ($size KB)" -ForegroundColor Green
} catch {
    Write-Error "Failed to download font: $_"
}
