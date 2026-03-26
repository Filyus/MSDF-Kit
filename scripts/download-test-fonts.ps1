<#
.SYNOPSIS
    Download test fonts for integration tests.
.DESCRIPTION
    Downloads the Latin and Arabic test fonts into test/fixtures/.
#>

$ErrorActionPreference = "Stop"
$ProjectRoot = $PSScriptRoot | Split-Path -Parent
$FixturesDir = Join-Path $ProjectRoot "test\fixtures"

if (-not (Test-Path $FixturesDir)) {
    New-Item -ItemType Directory -Path $FixturesDir -Force | Out-Null
}

$Fonts = @(
    @{
        Name = "Roboto-Regular.ttf"
        Url = "https://github.com/googlefonts/roboto/raw/main/src/hinted/Roboto-Regular.ttf"
    },
    @{
        Name = "NotoNaskhArabic-Regular.ttf"
        Url = "https://github.com/notofonts/arabic/raw/main/fonts/ttf/NotoNaskhArabic/NotoNaskhArabic-Regular.ttf"
    }
)

try {
    foreach ($font in $Fonts) {
        $fontFile = Join-Path $FixturesDir $font.Name

        if (Test-Path $fontFile) {
            Write-Host "Font already exists: $fontFile" -ForegroundColor Green
            continue
        }

        Write-Host "Downloading $($font.Name)..." -ForegroundColor Cyan
        Invoke-WebRequest -Uri $font.Url -OutFile $fontFile -UseBasicParsing

        $size = [math]::Round((Get-Item $fontFile).Length / 1KB)
        Write-Host "  -> $($font.Name) ($size KB)" -ForegroundColor Green
    }
} catch {
    Write-Error "Failed to download test fonts: $_"
}
