param([string]$DataDirectory, [switch]$Remove, [switch]$PlanOnly)
$ErrorActionPreference = 'Stop'
if (-not $DataDirectory) { $DataDirectory = (Get-Content -Encoding UTF8 -Raw -LiteralPath (Join-Path $PSScriptRoot 'launcher.json') | ConvertFrom-Json).data }
$sha = [System.Security.Cryptography.SHA256]::Create()
$tag = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes([IO.Path]::GetFullPath($DataDirectory).ToLowerInvariant())))).Replace('-','').Substring(0,12)
# New registrations use the product name; legacy registrations are not silently changed.
$name = "DLNA Video Server $tag"
$shortcut = Join-Path ([Environment]::GetFolderPath('Startup')) "$name.lnk"
if ($PlanOnly) { [pscustomobject]@{Name=$name;DataDirectory=$DataDirectory;Executable=(Join-Path $PSScriptRoot 'runtime\node.exe');Arguments=('"' + (Join-Path $PSScriptRoot 'control.mjs') + '" start');Logon='Current user';StartupFallback=$shortcut} | ConvertTo-Json; exit }
if ($Remove) { Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue; if (Test-Path -LiteralPath $shortcut) { Remove-Item -LiteralPath $shortcut }; exit }
$node = Join-Path $PSScriptRoot 'runtime\node.exe'
$control = Join-Path $PSScriptRoot 'control.mjs'
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute $node -Argument ('"' + $control + '" start') -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
try {
  Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
  if (Test-Path -LiteralPath $shortcut) { Remove-Item -LiteralPath $shortcut }
  Write-Host "DLNA Video Server: registered per-user logon task: $name (no password stored)."
} catch {
  # Locked-down PCs may deny Task Scheduler registration even for the current user.
  $shell = New-Object -ComObject WScript.Shell
  $link = $shell.CreateShortcut($shortcut)
  $link.TargetPath = $node
  $link.Arguments = '"' + $control + '" start'
  $link.WorkingDirectory = $PSScriptRoot
  $link.WindowStyle = 7
  $link.Save()
  Write-Host "DLNA Video Server: task registration unavailable; installed per-user Startup shortcut: $name"
}
