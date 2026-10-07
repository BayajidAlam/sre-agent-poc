# debug-token2.ps1
$ErrorActionPreference = 'Continue'
$env:KUBECONFIG = (Resolve-Path "$PSScriptRoot/../bin/kubeconfig").Path
$kubectl = (Resolve-Path "$PSScriptRoot/../bin/kubectl.exe").Path

Write-Host ">>> Step 1: token"
$token = & $kubectl -n kubernetes-dashboard create token admin-user --duration=240h 2>&1
Write-Host "<<< token first 40: $($token.Substring(0, 40))"
Write-Host "<<< exit code: $LASTEXITCODE"

Write-Host ""
Write-Host ">>> Step 2: external IP"
$externalIp = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object {
    $_.IPAddress -notlike '127.*' -and
    $_.IPAddress -notlike '169.254.*' -and
    $_.InterfaceAlias -notlike '*WSL*' -and
    $_.InterfaceAlias -notlike '*Hyper-V*'
  } | Select-Object -First 1).IPAddress
Write-Host "<<< IP = $externalIp"

Write-Host ""
Write-Host ">>> Step 3: cleanup (should not throw)"
$conns = Get-NetTCPConnection -LocalPort 19443 -ErrorAction SilentlyContinue 2>&1
Write-Host "<<< conns count = $($conns.Count)"
foreach ($c in $conns) {
  Write-Host "<<< killing PID $($c.OwningProcess)"
  Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host ">>> Step 4: start port-forward"
$proc = Start-Process -FilePath $kubectl `
  -ArgumentList @('--context','kind-sre-poc','-n','kubernetes-dashboard',
                  'port-forward','--address','0.0.0.0',
                  'svc/kubernetes-dashboard-np','19443:443') `
  -WindowStyle Hidden -PassThru
Write-Host "<<< proc.Id = $($proc.Id)"
Start-Sleep -Seconds 2
$running = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
Write-Host "<<< proc alive: $($null -ne $running)"

Write-Host ""
Write-Host ">>> Step 5: listener"
Get-NetTCPConnection -LocalPort 19443 -ErrorAction SilentlyContinue |
  ForEach-Object { Write-Host "<<< $($_.LocalAddress):$($_.LocalPort) PID $($_.OwningProcess)" }

Write-Host ""
Write-Host "DONE"