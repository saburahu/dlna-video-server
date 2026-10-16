param([switch]$NoStart)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$node = Join-Path $PSScriptRoot 'runtime\node.exe'
$control = Join-Path $PSScriptRoot 'control.mjs'
Write-Host 'DLNA Video Server setup (Windows x64)'
$existing = Join-Path $PSScriptRoot 'launcher.json'
$dataDefault = Join-Path $env:LOCALAPPDATA 'DLNA Video Server'
if (Test-Path -LiteralPath $existing) { $dataDefault = (Get-Content -Encoding UTF8 -Raw -LiteralPath $existing | ConvertFrom-Json).data }
$data = Read-Host "Data directory [$dataDefault]"
if (-not $data) { $data = $dataDefault }
$port = Read-Host 'HTTP port [19090]'
if (-not $port) { $port = '19090' }
Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -ne '127.0.0.1' } | Format-Table InterfaceAlias,IPAddress
$address = Read-Host 'LAN IPv4 address (blank = automatic)'
if (-not $address) { $address = 'auto' }
$ffmpegDefault = Join-Path $PSScriptRoot 'tools\ffmpeg\bin'
if (Test-Path -LiteralPath $existing) { $saved = Get-Content -Encoding UTF8 -Raw -LiteralPath $existing | ConvertFrom-Json; if ($saved.ffmpegDirectory) { $ffmpegDefault = $saved.ffmpegDirectory } }
Write-Host 'FFmpeg is not bundled. Get current Windows x64 essentials/full build from https://www.gyan.dev/ffmpeg/builds/'
Write-Host 'Validated: FFmpeg/ffprobe 8.1.2 from the same build. Bundled Node.js: 24.22.0 LTS. See COMPATIBILITY for the limited receiver test scope.'
$ffmpegDirectory = Read-Host "FFmpeg bin directory [$ffmpegDefault]"
if (-not $ffmpegDirectory) { $ffmpegDirectory = $ffmpegDefault }
& $node $control ffmpeg --data $data --directory $ffmpegDirectory
if ($LASTEXITCODE -ne 0) { throw 'Configure FFmpeg first; see README-ja.md' }
$settingsExists = Test-Path -LiteralPath (Join-Path $data 'settings.json')
$cli = @($control, 'setup', '--data', $data, '--port', $port, '--address', $address)
if (-not $settingsExists) {
  $source = Read-Host 'Import stopped old PC data directory (blank = new server)'
  if ($source) {
    Write-Host 'Old server must be stopped. Preserving its UDN forbids running both together.'
    $confirm = Read-Host 'Type STOPPED to confirm'
    if ($confirm -ne 'STOPPED') { throw 'Import cancelled' }
    $replacement = Read-Host 'Replace old server and preserve its UDN? [y/N; N = additional independent server]'
    $importArgs = @($control, 'import', '--data', $data, '--from', $source, '--source-stopped')
    if ($replacement -ne 'y') { $importArgs += '--new-identity' }
    & $node @importArgs
    if ($LASTEXITCODE -ne 0) { throw 'Import failed' }
  } else {
    $folders = Read-Host 'Recording folders separated by | (blank = add later in web settings)'
    if ($folders) { $cli += @('--folders', $folders) }
  }
}
$name = Read-Host 'Server name shown on TV (blank = keep existing / DLNA Video Server + PC name)'
if ($name) { $cli += @('--name', $name) }
$seconds = Read-Host 'Library refresh interval in seconds (blank = keep existing / 1800)'
if ($seconds) { $cli += @('--scan-seconds', $seconds) }
& $node @cli
if ($LASTEXITCODE -ne 0) { throw 'Setup failed' }
$auto = Read-Host 'Start automatically at this user logon? [y/N]'
if ($auto -eq 'y') {
  $global:LASTEXITCODE = 0
  & (Join-Path $PSScriptRoot 'autostart.ps1') -DataDirectory $data
  if (-not $? -or $LASTEXITCODE -ne 0) { throw 'Logon startup registration failed' }
}
Write-Host 'For TV discovery, allow runtime\node.exe on PRIVATE networks in Windows Firewall.'
Write-Host 'Do not enable public-network access. NAS access uses this logged-in user.'
if (-not $NoStart) {
  & $node $control start
  if ($LASTEXITCODE -ne 0) { throw 'Startup failed; inspect data\logs' }
  Start-Process "http://localhost:$port"
}

Write-Host 'テレビに見えない場合は Diagnose.cmd を実行してください。配置先変更後は新しい runtime\node.exe の受信許可を確認します。'
try { & $node $control firewall; if ($LASTEXITCODE -ne 0) { Write-Warning 'ファイアウォール診断を取得できません。Diagnose.cmd またはWindows設定画面で確認してください。' } } catch { Write-Warning 'ファイアウォール診断は判定不能です。Windows設定画面で確認してください。' }
# Optional read-only diagnosis must not turn a successful setup into a failure.
$global:LASTEXITCODE = 0
