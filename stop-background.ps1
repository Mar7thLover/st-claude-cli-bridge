$ErrorActionPreference = 'Stop'
$pidFile = Join-Path $PSScriptRoot '.runtime\bridge.pid'
if (-not (Test-Path -LiteralPath $pidFile)) {
    Write-Output 'No tracked background bridge. For a foreground server, press Ctrl+C in its terminal.'
    exit 0
}
$bridgePid = [int](Get-Content -LiteralPath $pidFile -Raw).Trim()
$bridgeProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $bridgePid"
if (-not $bridgeProcess) {
    Remove-Item -LiteralPath $pidFile
    Write-Output 'The tracked bridge has already stopped.'
    exit 0
}
$entryFile = Join-Path $PSScriptRoot 'src\index.js'
if ($bridgeProcess.Name -ne 'node.exe' -or $bridgeProcess.CommandLine -notlike "*$entryFile*") {
    throw 'PID does not match this bridge executable. Refusing to stop an unrelated process.'
}
$children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $bridgePid" | Where-Object { $_.Name -ne 'conhost.exe' })
if ($children.Count -gt 0) {
    throw 'The bridge has an active child process. Cancel the generation in your chat frontend before stopping.'
}
Stop-Process -Id $bridgePid
Remove-Item -LiteralPath $pidFile
Write-Output 'Background ClaudeBridge stopped.'
