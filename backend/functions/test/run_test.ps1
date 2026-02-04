# Navigate to the project root (backend/functions) to ensure correct module resolution
Set-Location "$PSScriptRoot/.."
Write-Host "Current Directory: $(Get-Location)"

# Run the V2 test script which contains the Half-Duplex and Barge-in logic
$env:DEBUG="record"
$TestFile = Join-Path $PSScriptRoot "manual_test_voicelive.ts"
npx ts-node "$TestFile"
