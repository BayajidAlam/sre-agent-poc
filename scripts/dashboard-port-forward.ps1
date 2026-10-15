# dashboard-port-forward.ps1
# Self-healing port-forward for the k8s dashboard.
# The HTTPS-only dashboard cannot survive half-open TCP probes (e.g.
# Chrome HSTS preflight) which kill kubectl's spdy tunnel. This script
# restarts the port-forward whenever it dies, on a short backoff.
#
# Usage:  powershell -File scripts/dashboard-port-forward.ps1

$ErrorActionPreference = "Stop"
$ctx       = "kind-sre-poc"
$ns        = "kubernetes-dashboard"
$svc       = "kubernetes-dashboard"
$localPort = 18443
$svcPort   = 443
$backoffMs = 2000

function Free-Port($port) {
    Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
        ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
}

Free-Port $localPort
Write-Host ">>> Self-healing port-forward: localhost:$localPort -> $svc`:$svcPort"
Write-Host ">>> Press Ctrl-C to stop."

while ($true) {
    try {
        # Use Start-Process so we can kill the exact child on retry.
        $proc = Start-Process -FilePath "kubectl" `
            -ArgumentList @("--context", $ctx, "port-forward", "-n", $ns, "svc/$svc", "${localPort}:$svcPort") `
            -NoNewWindow -PassThru -RedirectStandardError "nul"
        Write-Host "[$(Get-Date -Format HH:mm:ss)] started kubectl pid=$($proc.Id)"
        $proc.WaitForExit()
        Write-Host "[$(Get-Date -Format HH:mm:ss)] kubectl exited (code=$($proc.ExitCode)). Restarting in ${backoffMs}ms..."
    } catch {
        Write-Host "[$(Get-Date -Format HH:mm:ss)] error: $_"
    }
    Free-Port $localPort
    Start-Sleep -Milliseconds $backoffMs
}
