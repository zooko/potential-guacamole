@echo off
setlocal enabledelayedexpansion

echo Setting up Visual Studio environment...
call "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1

echo LIB path: %LIB%
echo.

cd /d "C:\Users\burba\blake3-benchmark\potential-guacamole\blake3-wasm-rayon"
echo Building in: %CD%
echo.

wasm-pack build --release --target web --out-dir pkg

if %errorlevel% neq 0 (
    echo.
    echo Build failed with error code %errorlevel%
    exit /b %errorlevel%
)

echo.
echo Build successful!
