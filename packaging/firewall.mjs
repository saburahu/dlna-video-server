import path from 'node:path';import os from 'node:os';import {execFileSync}from'node:child_process';
const list=v=>Array.isArray(v)?v:v==null?[]:[v],any=v=>list(v).length===1&&String(list(v)[0]).toLowerCase()==='any';
const norm=v=>String(v).replaceAll('/','\\').toLowerCase(),truth=v=>String(v).toLowerCase()==='true';
function covers(values,port){return list(values).some(v=>{if(String(v).toLowerCase()==='any')return true;const p=String(v).split('-').map(Number);return p.length===1?p[0]===port:p.length===2&&p[0]<=port&&port<=p[1];});}
export function evaluateFirewall(snapshot,{root,node,port,address}){
 const result={root,node,tcpPort:port,udpPort:1900,address,networks:[],listeners:snapshot?.listeners??null,channels:[],oldNodeAllowPaths:[],reason:null,limitation:'規則の読み取り診断です。TVからの到達性、ルーター、他社FW、IPsec、組織ポリシー等による通信可否は保証しません。'};
 if(!snapshot?.ok){result.reason='判定不能: 権限不足・ポリシー制限・取得失敗。'+(snapshot?.error??'');return result;}
 const indices=list(snapshot.addresses).filter(v=>v.IPAddress===address).map(v=>Number(v.InterfaceIndex));const networks=list(snapshot.networks).filter(n=>indices.includes(Number(n.index)));result.networks=networks;
 if(!networks.length){result.reason='判定不能: 待受LANアドレスとネットワークプロファイルを対応付けられません。';return result;}
 const rules=list(snapshot.rules),same=r=>norm(r.program)===norm(node),global=r=>r.program==='Any',matches=(r,p)=>String(r.profile).split(/[, ]+/).some(x=>x==='Any'||x===p),proto=(r,p)=>['Any',p,p==='TCP'?'6':'17','256'].includes(String(r.protocol));
 result.oldNodeAllowPaths=[...new Set(rules.filter(r=>!same(r)&&!global(r)&&r.action==='Allow'&&networks.some(n=>matches(r,n.category==='DomainAuthenticated'?'Domain':n.category))).map(r=>r.program))];
 for(const n of networks){const category=n.category==='DomainAuthenticated'?'Domain':n.category,profile=list(snapshot.profiles).find(p=>p.name===category);
  for(const [protocol,number]of [['TCP',port],['UDP',1900]]){
   const relevant=rules.filter(r=>(same(r)||global(r))&&matches(r,category)&&proto(r,protocol)&&covers(r.localPort,number));
   // Restricted address/service/interface/security rules require a richer packet context: never infer connectivity.
   const broad=r=>any(r.localAddress)&&any(r.remotePort)&&list(r.remoteAddress).length>0&&list(r.remoteAddress).every(a=>['Any','LocalSubnet'].includes(a))&&r.service==='Any'&&any(r.interfaces)&&r.interfaceType==='Any'&&r.authentication==='NotRequired'&&r.encryption==='NotRequired'&&r.overrideBlock==='False'&&(!r.package||r.package==='Any');
   const blocks=relevant.filter(r=>r.action==='Block'),allows=relevant.filter(r=>r.action==='Allow'&&same(r)&&broad(r));let state;
   if(!profile)state='unknown-profile';else if(!truth(profile.enabled))state='firewall-disabled-or-unknown';else if(category!=='Private')state='non-private-network';else if(blocks.some(broad))state='blocked';else if(blocks.length||relevant.some(r=>!broad(r)))state='conditional-rules-unknown';else if(profile.allowInbound==='False'||profile.allowLocal==='False')state='policy-restricted';else state=allows.length?'allow-rule-found':'allow-rule-not-found';
   result.channels.push({profile:category,protocol,port:number,state,allowCandidates:allows.length,blockCandidates:blocks.length});
  }
 }
 return result;
}
export function inspectFirewall(root,settings={},run=execFileSync){
 const node=path.resolve(root,'runtime/node.exe'),port=Number(settings.port??19090);const address=settings.interfaceAddress||Object.values(os.networkInterfaces()).flat().find(i=>i?.family==='IPv4'&&!i.internal&&!i.address.startsWith('169.254.'))?.address;
 let snapshot;try{if(process.platform!=='win32')throw Error('Windows専用診断');if(!Number.isInteger(port)||port<1||port>65535)throw Error('待受ポート設定が不正');snapshot=JSON.parse(run('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'firewall.ps1'),'-TcpPort',String(port)],{encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:4*1024*1024}).replace(/^\uFEFF/,''));}catch(e){snapshot={ok:false,error:e.message};}return evaluateFirewall(snapshot,{root:path.resolve(root),node,port,address});
}
export function firewallText(r){return `\nWindowsファイアウォール診断（読み取り専用）\nアプリ: ${r.root}\n対象Node: ${r.node}\n待受: TCP ${r.tcpPort} / SSDP UDP 1900 / LAN ${r.address??'不明'}\n${r.reason??r.channels.map(c=>`${c.profile} ${c.protocol} ${c.port}: ${({'blocked':'受信ブロック規則あり','allow-rule-found':'許可規則候補あり（到達性は未確認）','allow-rule-not-found':'対象パスの許可規則を確認できません','non-private-network':'プライベート以外のネットワークです','conditional-rules-unknown':'条件付き規則のため判定不能','policy-restricted':'組織/ローカル規則ポリシーによる制限','unknown-profile':'プロファイル判定不能','firewall-disabled-or-unknown':'FW無効または状態判定不能'})[c.state]}`).join('\n')}\n旧パスの許可候補: ${r.oldNodeAllowPaths.join(', ')||'なし'}\nTCP待受件数: ${r.listeners?.tcp?.length??'判定不能'} / UDP 1900待受件数: ${r.listeners?.udp?.length??'判定不能'}（他プロセスの可能性あり）\nTVに見えない場合: Windows「セキュリティが強化されたファイアウォール」→「受信の規則」で対象Nodeのプロパティを確認してください。ブロック規則は許可より優先します。許可する場合は、このNodeだけ・プライベートのみ・リモートIPはローカルサブネット・TCP ${r.tcpPort}とUDP 1900だけに限定してください。古い配置先の許可は新しい配置先に適用されません。信頼できる家庭内LANか確認し、パブリックのまま広く許可しないでください。\n${r.limitation}\n設定は自動変更しません。取得失敗時は管理者権限のPowerShellまたはWindows設定画面で再確認してください。\n`;}
