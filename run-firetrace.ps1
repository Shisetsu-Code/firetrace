$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

$VenvPython = Join-Path $Root ".venv\Scripts\python.exe"

if (-not (Test-Path $VenvPython)) {
    $Python = $null

    if (Get-Command py -ErrorAction SilentlyContinue) {
        try {
            & py -3.12 -c "import sys; print(sys.version)" | Out-Null
            $Python = @("py", "-3.12")
        } catch {}
        if (-not $Python) {
            try {
                & py -3.11 -c "import sys; print(sys.version)" | Out-Null
                $Python = @("py", "-3.11")
            } catch {}
        }
    }

    if (-not $Python -and (Get-Command python -ErrorAction SilentlyContinue)) {
        $Python = @("python")
    }

    if (-not $Python) {
        throw "Python 3.11+ was not found. Install Python and run this script again."
    }

    Write-Host "Creating Firetrace virtual environment..."
    if ($Python.Count -eq 2) {
        & $Python[0] $Python[1] -m venv .venv
    } else {
        & $Python[0] -m venv .venv
    }
}

Write-Host "Updating Firetrace dependencies..."
& $VenvPython -m pip install --disable-pip-version-check -e .

Write-Host "Ensuring Playwright Chromium is installed..."
& $VenvPython -m playwright install chromium

Write-Host ""
Write-Host "Starting Firetrace..."
Write-Host "MCP: http://127.0.0.1:8765/mcp"
Write-Host "Health: http://127.0.0.1:8765/health"
Write-Host ""

& $VenvPython -m firetrace.gui
exit $LASTEXITCODE
