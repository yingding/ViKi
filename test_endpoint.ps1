$url = "http://localhost:7071/api/consults/mock-1/voice-input"
Write-Host "POSTing to $url..."

try {
    # Send a small byte array as audio
    $bytes = [System.Text.Encoding]::UTF8.GetBytes("dummy audio data")
    
    Invoke-WebRequest -Uri $url -Method Post -Body $bytes -ContentType "application/octet-stream" -TimeoutSec 30
} catch {
    Write-Host "Error: $($_.Exception.Message)"
    if ($_.Exception.Response) {
        $reader = New-Object System.IO.StreamReader $_.Exception.Response.GetResponseStream()
        $respBody = $reader.ReadToEnd()
        Write-Host "Server Response: $respBody"
    }
}
