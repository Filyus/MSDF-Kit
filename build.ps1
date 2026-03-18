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

.PARAMETER EmsdkRoot
    Optional override for the Emscripten SDK root directory.

.PARAMETER VsCMakeBase
    Optional override for the Visual Studio CMake tools directory.

.EXAMPLE
    .\build.ps1
    .\build.ps1 -Clean
    .\build.ps1 -SkipWasm
    .\build.ps1 -EmsdkRoot D:\emsdk
    .\build.ps1 -EmsdkRoot D:\emsdk -VsCMakeBase "C:\Program Files\Microsoft Visual Studio\2022\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake"
#>
param(
    [switch]$Clean,
    [switch]$SkipWasm,
    [switch]$SkipTs,
    [string]$EmsdkRoot,
    [string]$VsCMakeBase
)

$ErrorActionPreference = "Stop"
$ProjectRoot = $PSScriptRoot

# ── Locate tools ──────────────────────────────────────────────

function Resolve-EmsdkRoot([string]$ExplicitRoot) {
    if ($ExplicitRoot) {
        if (Test-Path (Join-Path $ExplicitRoot "emsdk.bat")) {
            return (Resolve-Path $ExplicitRoot).Path
        }
        Write-Error "Explicit EmsdkRoot is invalid: $ExplicitRoot"
    }

    $candidates = @()

    if ($env:EMSDK) {
        $candidates += $env:EMSDK
    }

    $candidates += @(
        "C:\Projects\emsdk",
        (Join-Path $HOME "emsdk")
    )

    foreach ($candidate in $candidates) {
        if (-not $candidate) { continue }
        if (Test-Path (Join-Path $candidate "emsdk.bat")) {
            return (Resolve-Path $candidate).Path
        }
    }

    $emcc = Get-Command emcc -ErrorAction SilentlyContinue
    if ($emcc) {
        $emccDir = Split-Path -Parent $emcc.Source
        $emsdkFromEmcc = Resolve-Path (Join-Path $emccDir "..\..") -ErrorAction SilentlyContinue
        if ($emsdkFromEmcc -and (Test-Path (Join-Path $emsdkFromEmcc.Path "emsdk.bat"))) {
            return $emsdkFromEmcc.Path
        }
    }

    return $null
}

function Resolve-VsCMakeBase([string]$ExplicitBase) {
    if ($ExplicitBase) {
        if (Test-Path (Join-Path $ExplicitBase "CMake\bin\cmake.exe")) {
            return (Resolve-Path $ExplicitBase).Path
        }
        Write-Error "Explicit VsCMakeBase is invalid: $ExplicitBase"
    }

    $vswhereCandidates = @(
        (Get-Command vswhere -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -ErrorAction SilentlyContinue),
        "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
    ) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique

    foreach ($vswherePath in $vswhereCandidates) {
        $installPath = & $vswherePath -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
        if (-not $installPath) { continue }

        $cmakeBase = Join-Path $installPath "Common7\IDE\CommonExtensions\Microsoft\CMake"
        if (Test-Path (Join-Path $cmakeBase "CMake\bin\cmake.exe")) {
            return $cmakeBase
        }
    }

    $candidates = @(
        "C:\Program Files\Microsoft Visual Studio\2022\Community\Common7\IDE\CommonExtensions\Microsoft\CMake",
        "C:\Program Files\Microsoft Visual Studio\2022\Professional\Common7\IDE\CommonExtensions\Microsoft\CMake",
        "C:\Program Files\Microsoft Visual Studio\2022\Enterprise\Common7\IDE\CommonExtensions\Microsoft\CMake",
        "C:\Program Files\Microsoft Visual Studio\2022\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake"
    )

    foreach ($candidate in $candidates) {
        if (Test-Path (Join-Path $candidate "CMake\bin\cmake.exe")) {
            return $candidate
        }
    }

    return $null
}

function Add-ToPathIfExists([string]$dir) {
    if ((Test-Path $dir) -and ($env:PATH -notlike "*$dir*")) {
        $env:PATH = "$dir;$env:PATH"
    }
}

function Reset-BuildDirectory([string]$buildDir) {
    if (Test-Path $buildDir) {
        Write-Host "Resetting $buildDir..." -ForegroundColor Yellow
        Remove-Item -Recurse -Force $buildDir
    }
}

$ResolvedEmsdkRoot = Resolve-EmsdkRoot $EmsdkRoot
$ResolvedVsCMakeBase = Resolve-VsCMakeBase $VsCMakeBase

if ($ResolvedEmsdkRoot) {
    Add-ToPathIfExists $ResolvedEmsdkRoot
    Add-ToPathIfExists (Join-Path $ResolvedEmsdkRoot "upstream\emscripten")
    $env:EMSDK = $ResolvedEmsdkRoot -replace '\\', '/'

    # Find emsdk node
    $emsdkNode = Get-ChildItem (Join-Path $ResolvedEmsdkRoot "node") -Directory -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending | Select-Object -First 1
    if ($emsdkNode) {
        $nodeExe = Join-Path $emsdkNode.FullName "bin\node.exe"
        if (Test-Path $nodeExe) {
            $env:EMSDK_NODE = $nodeExe
        }
    }
}

if ($ResolvedVsCMakeBase) {
    Add-ToPathIfExists (Join-Path $ResolvedVsCMakeBase "CMake\bin")
    Add-ToPathIfExists (Join-Path $ResolvedVsCMakeBase "Ninja")
}

$emccCmd = Get-Command emcc -ErrorAction SilentlyContinue
$emcmakeCmd = Get-Command emcmake -ErrorAction SilentlyContinue

if (-not $emccCmd -or -not $emcmakeCmd) {
    $emsdkHelp = if ($ResolvedEmsdkRoot) {
        "Resolved EMSDK root: $ResolvedEmsdkRoot"
    } else {
        "Set the EMSDK environment variable, pass -EmsdkRoot, add emcc/emcmake to PATH, or install emsdk in C:\Projects\emsdk or $HOME\emsdk."
    }
    Write-Error "Emscripten tools not found. $emsdkHelp"
}

$cmakeCmd = Get-Command cmake -ErrorAction SilentlyContinue
$ninjaCmd = Get-Command ninja -ErrorAction SilentlyContinue

if (-not $cmakeCmd -or -not $ninjaCmd) {
    $vsHelp = if ($ResolvedVsCMakeBase) {
        "Resolved Visual Studio CMake tools at: $ResolvedVsCMakeBase"
    } else {
        "Install CMake/Ninja, pass -VsCMakeBase, add them to PATH, or install Visual Studio with C++/CMake tools."
    }
    Write-Error "Build tools not found. $vsHelp"
}

# Verify tools
foreach ($tool in @("emcc", "emcmake", "cmake", "ninja")) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        Write-Error "$tool not found in PATH after setup. Check your installation."
    }
}

Write-Host "Tools OK: emcc, emcmake, cmake, ninja" -ForegroundColor Green

# ── WASM build ────────────────────────────────────────────────

if (-not $SkipWasm) {
    Push-Location $ProjectRoot

    $buildDir = Join-Path $ProjectRoot "cmake-build"
    $cachePath = Join-Path $buildDir "CMakeCache.txt"

    if ($Clean) {
        Reset-BuildDirectory $buildDir
    }

    if ((Test-Path $cachePath) -and -not $Clean) {
        $cache = Get-Content $cachePath -Raw
        $projectPathEscaped = [regex]::Escape($ProjectRoot)
        if ($cache -notmatch "(?im)^CMAKE_HOME_DIRECTORY:INTERNAL=$projectPathEscaped$") {
            Write-Host "Detected stale CMake cache from another source tree." -ForegroundColor Yellow
            Reset-BuildDirectory $buildDir
        }
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
