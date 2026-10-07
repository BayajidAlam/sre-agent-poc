# probe-all-uis.ps1 - quick reachability check for all 6 UIs
$ErrorActionPreference = 'Continue'

# Enable TLS 1.2 for HTTPS (Dashboard)
[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12

$urls = @(
  @{ Name = 'Grafana';        Url = 'http://192.168.0.102:13000/' },
  @{ Name = 'Prometheus';     Url = 'http://192.168.0.102:19090/' },
  @{ Name = 'Alertmanager';   Url = 'http://192.168.0.102:19093/' },
  @{ Name = 'Loki /ready';    Url = 'http://192.168.0.102:13100/ready' },
  @{ Name = 'Tempo /ready';   Url = 'http://192.168.0.102:13200/ready' },
  @{ Name = 'Dashboard';      Url = 'https://192.168.0.102:19443/' }
)

foreach ($u in $urls) {
  try {
    if ($u.Url.StartsWith('https://')) {
      # bypass self-signed cert
      $req = [System.Net.HttpWebRequest]::Create($u.Url)
    } else {
      $req = [System.Net.HttpWebRequest]::Create($u.Url)
    }
    $req.Timeout = 6000
    $req.Method = 'GET'
    if ($u.Url.StartsWith('https://')) {
      # ignore cert errors
      [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
    }
    $resp = $req.GetResponse()
    Write-Host ("{0,-14} -> {1} {2}" -f $u.Name, [int]$resp.StatusCode, $resp.StatusDescription)
    $resp.Close()
  } catch {
    $msg = $_.Exception.Message
    if ($_.Exception.InnerException) { $msg = $msg + ' | ' + $_.Exception.InnerException.Message }
    Write-Host ("{0,-14} -> ERR {1}" -f $u.Name, $msg)
  }
}
