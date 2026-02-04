Write-Host "Starting Virtual Clinic Services..."

# Check ports
$portsToCheck = @(7071, 10000, 3000)
$portsBusy = $false
foreach ($p in $portsToCheck) {
    if (Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue) {
        Write-Host "Port $p is in use."
        $portsBusy = $true
    }
}

if ($portsBusy) {
    Write-Host "One or more ports are busy. Running cleanup..."
    .\kill_services.ps1
    # Small pause to ensure ports are freed
    Start-Sleep -Seconds 2
} else {
    Write-Host "Ports are clear."
}

# Start Backend (Azure Functions + Azurite)
Write-Host "Launching Backend (backend/functions)..."
$backendEnv = @{ "USE_MOCK_VOICE" = "true" }
Start-Process powershell -ArgumentList "-NoExit", "-Command", "`$env:USE_MOCK_VOICE='true'; `$Host.UI.RawUI.WindowTitle = 'ViKi Backend'; cd backend/functions; npm start"

# Start Frontend (Next.js Portal)
Write-Host "Launching Frontend (frontend/portal)..."
Start-Process powershell -ArgumentList "-NoExit", "-Command", "`$Host.UI.RawUI.WindowTitle = 'ViKi Frontend'; cd frontend/portal; npm run dev"

Write-Host "Services launched in separate windows."
