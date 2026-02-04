Write-Host "Cleaning up ports 7071 (Functions) and 10000 (Azurite)..."

function Kill-Port($port) {
    try {
        $connections = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
        if ($connections) {
            foreach ($conn in $connections) {
                $pid_val = $conn.OwningProcess
                Write-Host "  Port $port is used by PID $pid_val. Killing..."
                Stop-Process -Id $pid_val -Force -ErrorAction SilentlyContinue
            }
        } else {
            Write-Host "  Port $port is free."
        }
    } catch {
        Write-Host "  Could not check port $port (Run as Admin if needed)."
    }
}

Kill-Port 7071
Kill-Port 10000
Kill-Port 3000

Write-Host "Stopping generic node and func processes to be safe..."
Stop-Process -Name "func" -Force -ErrorAction SilentlyContinue
# Stop-Process -Name "node" -Force -ErrorAction SilentlyContinue # Node is used by VS Code and Agent, be careful. Maybe only kill if strictly necessary. 
# Better to rely on port killing for node.

Write-Host "Closing ViKi Backend/Frontend windows..."
Get-Process | Where-Object { $_.MainWindowTitle -eq "ViKi Backend" -or $_.MainWindowTitle -eq "ViKi Frontend" } | Stop-Process -Force -ErrorAction SilentlyContinue

