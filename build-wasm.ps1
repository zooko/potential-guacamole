# Build WASM with Visual Studio environment
$ErrorActionPreference = "Stop"

# Set up paths manually (vcvars64 doesn't work well in PowerShell)
$vsPath = "C:\Program Files\Microsoft Visual Studio\2022\Community"
$msvcVersion = "14.44.35207"
$sdkVersion = "10.0.18362.0"

# MSVC paths
$msvcBin = "$vsPath\VC\Tools\MSVC\$msvcVersion\bin\HostX64\x64"
$msvcLib = "$vsPath\VC\Tools\MSVC\$msvcVersion\lib\x64"
$msvcInclude = "$vsPath\VC\Tools\MSVC\$msvcVersion\include"

# Windows SDK paths
$sdkBase = "C:\Program Files (x86)\Windows Kits\10"
$sdkLib = "$sdkBase\Lib\$sdkVersion"
$sdkInclude = "$sdkBase\Include\$sdkVersion"

# Set environment variables
$env:PATH = "$msvcBin;$env:PATH"
$env:LIB = "$msvcLib;$sdkLib\ucrt\x64;$sdkLib\um\x64"
$env:INCLUDE = "$msvcInclude;$sdkInclude\ucrt;$sdkInclude\um;$sdkInclude\shared"

Write-Host "PATH includes: $msvcBin"
Write-Host "LIB = $env:LIB"
Write-Host "INCLUDE = $env:INCLUDE"
Write-Host ""

# Change to project directory
Set-Location "C:\Users\burba\blake3-benchmark\potential-guacamole\blake3-wasm-rayon"
Write-Host "Building in: $(Get-Location)"
Write-Host ""

# Clean and build
cargo clean
wasm-pack build --release --target web --out-dir pkg
