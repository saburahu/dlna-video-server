param([int]$TcpPort=19090)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
try {
  $net=@(Get-NetConnectionProfile | ForEach-Object { [pscustomobject]@{index=$_.InterfaceIndex;category=[string]$_.NetworkCategory;alias=$_.InterfaceAlias} })
  $ips=@(Get-NetIPAddress -AddressFamily IPv4 | Select-Object InterfaceIndex,IPAddress)
  $profiles=@(Get-NetFirewallProfile -PolicyStore ActiveStore | ForEach-Object { [pscustomobject]@{name=[string]$_.Name;enabled=[string]$_.Enabled;allowInbound=[string]$_.AllowInboundRules;allowLocal=[string]$_.AllowLocalFirewallRules} })
  # Read bulk ActiveStore filters once. No rule-name heuristics or rule mutation.
  $maps=@{}
  foreach($kind in @('Application','Port','Address','Service','Interface','InterfaceType','Security')) {
    $map=@{}; & ('Get-NetFirewall'+$kind+'Filter') -PolicyStore ActiveStore | ForEach-Object { $map[[string]$_.InstanceID]=$_ };$maps[$kind]=$map
  }
  $rules=@(Get-NetFirewallRule -PolicyStore ActiveStore -Enabled True -Direction Inbound | ForEach-Object {
    $id=[string]$_.Name;$a=$maps.Application[$id];if(-not $a){throw 'ActiveStore filter association could not be verified'};$p=$maps.Port[$id];$addr=$maps.Address[$id];$svc=$maps.Service[$id];$iface=$maps.Interface[$id];$it=$maps.InterfaceType[$id];$sec=$maps.Security[$id]
    if($a -and ($a.Program -eq 'Any' -or $a.Program -match '(?i)node\.exe$')) {
      [pscustomobject]@{program=[string]$a.Program;action=[string]$_.Action;profile=[string]$_.Profile;protocol=[string]$p.Protocol;localPort=@($p.LocalPort);remotePort=@($p.RemotePort);localAddress=@($addr.LocalAddress);remoteAddress=@($addr.RemoteAddress);service=[string]$svc.Service;interfaces=@($iface.InterfaceAlias);interfaceType=[string]$it.InterfaceType;authentication=[string]$sec.Authentication;encryption=[string]$sec.Encryption;overrideBlock=[string]$sec.OverrideBlockRules;package=[string]$a.Package}
    }
  })
  $tcp=@(Get-NetTCPConnection -State Listen | Where-Object LocalPort -eq $TcpPort | Select-Object LocalAddress,LocalPort,OwningProcess)
  $udp=@(Get-NetUDPEndpoint | Where-Object LocalPort -eq 1900 | Select-Object LocalAddress,LocalPort,OwningProcess)
  [pscustomobject]@{ok=$true;networks=$net;addresses=$ips;profiles=$profiles;rules=$rules;listeners=@{tcp=$tcp;udp=$udp}} | ConvertTo-Json -Depth 7 -Compress
} catch { [pscustomobject]@{ok=$false;error=$_.Exception.Message} | ConvertTo-Json -Compress }
