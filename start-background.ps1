$ErrorActionPreference = 'Stop'
$runtimeDir = Join-Path $PSScriptRoot '.runtime'
$pidFile = Join-Path $runtimeDir 'bridge.pid'
$entryFile = Join-Path $PSScriptRoot 'src\index.js'
New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
if (Test-Path -LiteralPath $pidFile) {
    $bridgePid = [int](Get-Content -LiteralPath $pidFile -Raw).Trim()
    $existing = Get-CimInstance Win32_Process -Filter "ProcessId = $bridgePid"
    if ($existing -and $existing.Name -eq 'node.exe' -and $existing.CommandLine -like "*$entryFile*") {
        Write-Output "ClaudeBridge is already running (PID $bridgePid)."
        exit 0
    }
}
$nodePath = (Get-Command node -ErrorAction Stop).Source
$bridgeProcess = Start-Process -FilePath $nodePath -ArgumentList ('"' + $entryFile + '"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimeDir 'stdout.log') -RedirectStandardError (Join-Path $runtimeDir 'stderr.log') -PassThru
$ready = $false
# Model discovery can take up to claude.discoveryTimeoutSeconds; allow 60s.
for ($attempt = 0; $attempt -lt 300; $attempt++) {
    Start-Sleep -Milliseconds 200
    $bridgeProcess.Refresh()
    if ($bridgeProcess.HasExited) {
        Get-Content -LiteralPath (Join-Path $runtimeDir 'stderr.log')
        throw 'ClaudeBridge failed to start.'
    }
    $output = Get-Content -LiteralPath (Join-Path $runtimeDir 'stdout.log') -Raw -ErrorAction SilentlyContinue
    if ($output -match '\[ClaudeBridge\] http://') { $ready = $true; break }
}
$bridgeProcess.Id | Set-Content -LiteralPath $pidFile
if (-not $ready) { throw 'ClaudeBridge startup is still pending. Inspect .runtime logs before retrying.' }
Write-Output "ClaudeBridge started in the background (PID $($bridgeProcess.Id)). Logs: $runtimeDir"
