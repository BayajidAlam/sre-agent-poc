# debug-token.ps1
$ErrorActionPreference = 'Continue'
Write-Host "Step 1: locating kubectl"
$kubectl = (Resolve-Path "$PSScriptRoot/../bin/kubectl.exe").Path
Write-Host "  kubectl = $kubectl"

Write-Host "Step 2: token"
$token = & $kubectl -n kubernetes-dashboard create token admin-user --duration=240h 2>&1
Write-Host "  token (first 60 chars): $($token.Substring(0, 60))..."
Write-Host "  exit code: $LASTEXITCODE"