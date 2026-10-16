$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
& node 'src/index.js'
exit $LASTEXITCODE
