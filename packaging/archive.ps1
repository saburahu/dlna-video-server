param([Parameter(Mandatory=$true)][string]$Package, [Parameter(Mandatory=$true)][string]$Zip)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$packagePath = (Resolve-Path -LiteralPath $Package).Path
$zipPath = [System.IO.Path]::GetFullPath($Zip)
if (Test-Path -LiteralPath $zipPath) { throw 'ZIP already exists; refusing overwrite' }
[System.IO.Compression.ZipFile]::CreateFromDirectory($packagePath, $zipPath, [System.IO.Compression.CompressionLevel]::Optimal, $false)
