<#
.SYNOPSIS
    Build script for MSDF-Kit WASM library.

.DESCRIPTION
    Sets up Emscripten environment and builds the WASM module + TypeScript output.

.PARAMETER Clean
    Remove cmake-build directory before configuring.

.PARAMETER SkipWasm
    Skip the WASM/C++ build, only build TypeScript.

.PARAMETER SkipTs
    Skip the TypeScript build.

.EXAMPLE
    .\build.ps1
    .\build.ps1 -Clean
    .\build.ps1 -SkipWasm
#>
param(
    [switch]$Clean,
    [switch]$SkipWasm,
    [switch]$SkipTs
)

$ErrorActionPreference = "Stop"
$ProjectRoot = $PSScriptRoot

# ── Locate tools ──────────────────────────────────────────────

$EmsdkRoot = "C:\Projects\emsdk"
$VS2022Base = "C:\Program Files\Microsoft Visual Studio\2022\Community\Common7\IDE\CommonExtensions\Microsoft\CMake"

if (-not (Test-Path $EmsdkRoot)) {
    Write-Error "Emscripten SDK not found at $EmsdkRoot. Install it first:`n  git clone https://github.com/emscripten-core/emsdk.git $EmsdkRoot`n  cd $EmsdkRoot; .\emsdk.bat install latest; .\emsdk.bat activate latest"
}

# Add emsdk, emscripten, cmake, and ninja to PATH
$pathDirs = @(
    "$EmsdkRoot",
    "$EmsdkRoot\upstream\emscripten",
    "$VS2022Base\CMake\bin",
    "$VS2022Base\Ninja"
)
foreach ($dir in $pathDirs) {
    if ((Test-Path $dir) -and ($env:PATH -notlike "*$dir*")) {
        $env:PATH = "$dir;$env:PATH"
    }
}
$env:EMSDK = $EmsdkRoot -replace '\\', '/'

# Find emsdk node
$emsdkNode = Get-ChildItem "$EmsdkRoot\node" -Directory -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending | Select-Object -First 1
if ($emsdkNode) {
    $env:EMSDK_NODE = Join-Path $emsdkNode.FullName "bin\node.exe"
}

# Verify tools
foreach ($tool in @("emcc", "cmake", "ninja")) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        Write-Error "$tool not found in PATH after setup. Check your installation."
    }
}

Write-Host "Tools OK: emcc, cmake, ninja" -ForegroundColor Green

# ── WASM build ────────────────────────────────────────────────

if (-not $SkipWasm) {
    Push-Location $ProjectRoot

    if ($Clean -and (Test-Path "cmake-build")) {
        Write-Host "Cleaning cmake-build..." -ForegroundColor Yellow
        Remove-Item -Recurse -Force "cmake-build"
    }

    Write-Host "`n=== Configuring CMake (Emscripten) ===" -ForegroundColor Cyan
    emcmake cmake -B cmake-build -S . -DCMAKE_BUILD_TYPE=Release
    if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Error "CMake configure failed" }

    Write-Host "`n=== Building WASM ===" -ForegroundColor Cyan
    cmake --build cmake-build
    if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Error "WASM build failed" }

    Pop-Location

    $wasm = Join-Path $ProjectRoot "build\msdf-kit.wasm"
    $js   = Join-Path $ProjectRoot "build\msdf-kit.js"
    if (Test-Path $wasm) {
        $size = [math]::Round((Get-Item $wasm).Length / 1KB)
        Write-Host "  -> msdf-kit.wasm  ($size KB)" -ForegroundColor Green
    }
    if (Test-Path $js) {
        $size = [math]::Round((Get-Item $js).Length / 1KB)
        Write-Host "  -> msdf-kit.js    ($size KB)" -ForegroundColor Green
    }
}

# ── TypeScript build ──────────────────────────────────────────

if (-not $SkipTs) {
    Push-Location $ProjectRoot

    if (-not (Test-Path "node_modules")) {
        Write-Host "`n=== Installing npm dependencies ===" -ForegroundColor Cyan
        npm install
        if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Error "npm install failed" }
    }

    Write-Host "`n=== Building TypeScript ===" -ForegroundColor Cyan
    npx tsc
    if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Error "TypeScript build failed" }

    Pop-Location
    Write-Host "  -> dist/" -ForegroundColor Green
}

Write-Host "`nBuild complete!" -ForegroundColor Green
