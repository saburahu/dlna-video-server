// UI actions are deliberate; polling performs GET only.
(()=>{
 const el=id=>document.getElementById(id);let revision,working=false;
 async function request(options){const r=await fetch('/api/dbr-color-trial',options);const v=await r.json();if(!r.ok)throw Error(v.error||r.status);return v;}
 function render(v){revision=v.revision;el('colorStatus').textContent=JSON.stringify({phase:v.phase,progress:v.progress,error:v.error,asset:v.asset?{sourceTitle:v.asset.sourceTitle,sourceId:v.asset.sourceId,sha256:v.asset.sha256,size:v.asset.size,seconds:v.asset.seconds,pcm:v.asset.audit.pcm,segments:v.asset.audit.segments}:undefined,publication:v.publication,lastResult:v.lastResult},null,2);el('colorAudit').textContent=JSON.stringify(v.asset?.audit??{},null,2);const select=el('colorPeer'),old=select.value;select.replaceChildren(...v.peers.map(p=>{const o=document.createElement('option');o.value=p.id;o.textContent=typeof p.title==='string'?p.title:JSON.stringify(p.title);o.disabled=!p.eligible;return o;}));if([...select.options].some(o=>o.value===old))select.value=old;el('colorPublish').disabled=v.phase!=='ready'||!!v.publication||!el('colorRisk').checked||v.asset?.sourceId!==el('colorSource').value;el('colorPrepare').disabled=v.phase==='preparing'||!!v.publication;}
 async function refresh(){if(!working)try{render(await request());}catch(e){el('colorMessage').textContent=String(e);}}
 async function action(action,extra={}){if(working)return;working=true;try{render(await request({method:'POST',headers:{'Content-Type':'application/json','X-PT3-Management':'1'},body:JSON.stringify({action,revision,...extra})}));el('colorMessage').textContent='操作を受け付けました。公開状態と監査結果を確認してください。';el('colorRisk').checked=false;}catch(e){el('colorMessage').textContent=String(e);}finally{working=false;await refresh();}}
 el('colorFind').onclick=async()=>{try{const r=await fetch('/api/dbr-color-trial?q='+encodeURIComponent(el('colorSearch').value)),v=await r.json();if(!r.ok)throw Error(v.error);el('colorSource').replaceChildren(...v.sources.map(s=>{const o=document.createElement('option');o.value=s.id;o.textContent=s.title;return o;}));}catch(e){el('colorMessage').textContent=String(e);}};
 el('colorSource').onchange=()=>{el('colorRisk').checked=false;void refresh();};
 el('colorPrepare').onclick=()=>action('prepare',{sourceId:el('colorSource').value});
 el('colorPublish').onclick=()=>action('publish',{sourceId:el('colorSource').value,peerId:el('colorPeer').value,riskAcknowledged:el('colorRisk').checked});
 el('colorCancel').onclick=()=>action('cancel');el('colorRisk').onchange=refresh;
 document.querySelector('[data-tab="dbrColor"]').addEventListener('click',refresh);
 setInterval(()=>{if(el('dbrColor').classList.contains('active'))void refresh();},2000);
})();
