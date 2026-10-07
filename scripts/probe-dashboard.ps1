# probe-dashboard-http.ps1 - verify Dashboard via HttpClient with proper cert bypass.
$handler = [System.Net.Http.HttpClientHandler]::new()
$handler.ServerCertificateCustomValidationCallback = { $true }
$client = [System.Net.Http.HttpClient]::new($handler)
$client.Timeout = [TimeSpan]::FromSeconds(6)

foreach ($u in 'https://192.168.0.102:19443/', 'https://127.0.0.1:19443/') {
  try {
    $resp = $client.GetAsync($u).GetAwaiter().GetResult()
    $body = $resp.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    Write-Host "$u -> $($resp.StatusCode) len=$($body.Length)"
    Write-Host "  head: $($body.Substring(0, [Math]::Min(160, $body.Length)))"
  } catch {
    Write-Host "$u -> $($_.Exception.GetType().Name): $($_.Exception.Message)"
  }
}