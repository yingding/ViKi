$env:DEBUG="record"; $TestFile = Join-Path $PSScriptRoot "manual_test_voicelive.ts"; npx tsx $TestFile
