$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

$VenvPython = Join-Path $Root ".venv\Scripts\python.exe"

function Test-PythonLauncher([string[]]$Command) {
    & $Command[0] $Command[1] -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)" 2>$null
    return ($LASTEXITCODE -eq 0)
}

if (-not (Test-Path $VenvPython)) {
    $Python = $null

    if (Get-Command py -ErrorAction SilentlyContinue) {
        if (Test-PythonLauncher @("py", "-3.12")) {
            $Python = @("py", "-3.12")
        }
        elseif (Test-PythonLauncher @("py", "-3.11")) {
            $Python = @("py", "-3.11")
        }
    }

    if (-not $Python -and (Get-Command python -ErrorAction SilentlyContinue)) {
        & python -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)" 2>$null
        if ($LASTEXITCODE -eq 0) {
            $Python = @("python")
        }
    }

    if (-not $Python) {
        throw "Python 3.11+ was not found. Install Python 3.11 or newer and run this script again."
    }

    Write-Host "Creating Firetrace virtual environment..."
    if ($Python.Count -eq 2) {
        & $Python[0] $Python[1] -m venv .venv
    }
    else {
        & $Python[0] -m venv .venv
    }

    if ($LASTEXITCODE -ne 0) {
        throw "Could not create .venv."
    }
}

Write-Host "Updating Firetrace dependencies..."
& $VenvPython -m pip install --disable-pip-version-check -e .
if ($LASTEXITCODE -ne 0) {
    throw "pip install failed."
}

Write-Host "Ensuring Playwright Chromium is installed..."
& $VenvPython -m playwright install chromium
if ($LASTEXITCODE -ne 0) {
    throw "Playwright Chromium installation failed."
}

Write-Host ""
Write-Host "Starting Firetrace..."
Write-Host "MCP: http://127.0.0.1:8765/mcp"
Write-Host "Health: http://127.0.0.1:8765/health"
Write-Host ""

& $VenvPython -m firetrace.gui
exit $LASTEXITCODE
