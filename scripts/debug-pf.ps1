# debug-pf.ps1
$ErrorActionPreference = 'Continue'
$kubectl = (Resolve-Path "$PSScriptRoot/../bin/kubectl.exe").Path
Write-Host "Step 1: killing any prior port-forward on 19443"
Get-NetTCPConnection -LocalPort 19443 -ErrorAction SilentlyContinue |
  ForEach-Object {
    Write-Host "  killing PID $($_.OwningProcess)"
    Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue
  }
Start-Sleep -Seconds 1

Write-Host "Step 2: starting port-forward"
$proc = Start-Process -FilePath $kubectl `
  -ArgumentList @('--context','kind-sre-poc','-n','kubernetes-dashboard',
                  'port-forward','--address','0.0.0.0',
                  'svc/kubernetes-dashboard-np','19443:443') `
  -WindowStyle Hidden -PassThru
Write-Host "  PID = $($proc.Id)"

Start-Sleep -Seconds 3

Write-Host "Step 3: listener status"
Get-NetTCPConnection -LocalPort 19443 -ErrorAction SilentlyContinue |
  ForEach-Object { Write-Host "  $($_.LocalAddressString):$($_.LocalPort) owned by PID $($_.OwningProcess)" }

Write-Host "Step 4: test connection"
try {
  $client = New-Object System.Net.Sockets.TcpClient
  $client.Connect('192.168.0.102', 19443)
  Write-Host "  TCP connect OK"
  $client.Close()
} catch {
  Write-Host "  TCP failed: $($_.Exception.Message)"
}