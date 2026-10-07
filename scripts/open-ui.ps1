# open-ui.ps1 - print the working UI URLs for the SRE POC.
# Bypasses the wslrelay.exe interception of 127.0.0.1 by using the host's
# external IPv4 (Docker's port forwards are on 0.0.0.0:<port>, not 127.0.0.1).

$external = (Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object {
    $_.IPAddress -notlike '127.*' -and
    $_.IPAddress -notlike '169.254.*' -and
    $_.InterfaceAlias -notlike '*WSL*' -and
    $_.InterfaceAlias -notlike '*Hyper-V*'
  })[0].IPAddress

if (-not $external) {
  # Fallback: first IPv4 that isn't loopback/link-local
  $external = (Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' })[0].IPAddress
}

Write-Host ""
Write-Host "SRE POC UI URLs (use these, not localhost):" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Grafana       http://${external}:13000/         (admin/admin)"
Write-Host "  Loki API      http://${external}:13100/ready    (use Grafana Explore for UI)"
Write-Host "  Tempo API     http://${external}:13200/ready    (use Grafana Explore for UI)"
Write-Host "  Prometheus    http://${external}:19090/"
Write-Host "  Alertmanager  http://${external}:19093/"
Write-Host "  K8s Dashboard https://${external}:19443/        (paste a SA token; see instructions)"
Write-Host ""
Write-Host "  (localhost:NNNN will fail because wslrelay.exe binds 127.0.0.1:<port>)" -ForegroundColor DarkYellow