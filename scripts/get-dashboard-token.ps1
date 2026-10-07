# get-dashboard-token.ps1 - issue a fresh login token for the Kubernetes Dashboard.
# Prints the token to stdout and starts a port-forward so the Dashboard is reachable
# at https://<host-external-ip>:19443/ on the host.
#
# Usage: .\scripts\get-dashboard-token.ps1
#
# On the Dashboard login page, choose "Token" and paste the printed token.

$ErrorActionPreference = 'Continue'   # not Stop: get-net* can throw on no match
$env:KUBECONFIG = (Resolve-Path "$PSScriptRoot/../bin/kubeconfig").Path
$kubectl = (Resolve-Path "$PSScriptRoot/../bin/kubectl.exe").Path

# 1. Issue the token
$token = & $kubectl -n kubernetes-dashboard create token admin-user --duration=240h 2>$null
if (-not $token) {
  Write-Host "ERROR: failed to issue token. Is the dashboard installed?" -ForegroundColor Red
  Write-Host "  Apply: kubectl apply -f manifests/dashboard/"
  exit 1
}

# 2. Resolve host external IP
$externalIp = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object {
    $_.IPAddress -notlike '127.*' -and
    $_.IPAddress -notlike '169.254.*' -and
    $_.InterfaceAlias -notlike '*WSL*' -and
    $_.InterfaceAlias -notlike '*Hyper-V*'
  } | Select-Object -First 1).IPAddress

if (-not $externalIp) {
  $externalIp = '127.0.0.1'   # fallback so the URL is still printed
}

# 3. Start port-forward (kill any prior listener first; ignore "no match" errors)
Get-NetTCPConnection -LocalPort 19443 -ErrorAction SilentlyContinue 2>$null |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 500

Write-Host "Starting port-forward 19443 -> kubernetes-dashboard-np:443 ..." -ForegroundColor DarkGray
$proc = Start-Process -FilePath $kubectl `
  -ArgumentList @('--context','kind-sre-poc','-n','kubernetes-dashboard',
                  'port-forward','--address','0.0.0.0',
                  'svc/kubernetes-dashboard-np','19443:443') `
  -WindowStyle Hidden -PassThru
Start-Sleep -Seconds 2

Write-Host ""
Write-Host "Dashboard URL: https://${externalIp}:19443/" -ForegroundColor Cyan
Write-Host ""
Write-Host "Login token (paste into the 'Token' field on the login page):"
Write-Host ""
Write-Host $token -ForegroundColor Yellow
Write-Host ""
Write-Host "(Browser will warn about a self-signed certificate - accept it.)"
Write-Host "Token TTL: ~10h. Re-run this script to issue a fresh one."