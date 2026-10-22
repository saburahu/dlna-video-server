// Offline candidate gate. No Git tags, network requests or publishing actions.
import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import{pathToFileURL}from'node:url';
export function assertReleasePair(privateCandidate,publicCandidate,{requirePublicationReady=false}={}){
 const entries=[['private',privateCandidate],['public',publicCandidate]];
 const versions=entries.map(([edition,c])=>{
  assert.equal(c.manifest.edition,edition);assert.match(c.packageVersion,/^\d+\.\d+\.\d+$/);
  for(const v of[c.manifest.productVersion,c.appVersion,c.notesVersion])assert.equal(v,c.packageVersion,'Product SemVer mismatch');
  assert.ok(c.manifest.release.startsWith(c.packageVersion+'-'),'Build ID must retain product SemVer');
  assert.match(c.manifest.sourceCommit,/^[a-f\d]{40}$/);assert.ok(c.manifest.buildId.includes(c.manifest.sourceCommit.slice(0,7)));
  assert.equal(c.bundledNode,true,'Bundled Node required');if(edition==='private')assert.equal(c.bundledRuntime,true,'Private requires bundled FFmpeg');else{assert.equal(c.bundledRuntime,false,'Public must not bundle FFmpeg');assert.equal(c.manifest.runtimeMode,'node-only-external-ffmpeg');}
  assert.equal(c.individualGrants,0,'Distribution defaults must not enroll an individual');
  if(requirePublicationReady)assert.equal(c.manifest.publicationReady,true,'Publication blocked: '+(c.manifest.publicationBlockers??[]).join('; '));
  return c.packageVersion;
 });assert.equal(versions[0],versions[1],'Private/Public product versions must match');
 return {version:versions[0],versionsMatch:true,publicationReady:entries.every(([,c])=>c.manifest.publicationReady===true),builds:entries.map(([edition,c])=>({edition,sourceCommit:c.manifest.sourceCommit,buildId:c.manifest.buildId}))};
}
export async function commonCodeParity(privateRoot,publicRoot){
 const files=['catalog-jit-candidate.ts','experimental-jit.ts','wma-input-permission.ts','wma-input-scope.ts','jit-server.ts','jit-stream.ts','jit-dual-audio.ts','jit-audio-clock.ts','jit-segment.ts','jit-seek.ts','receiver-cfr-trial.ts','receiver-wmv-cfr-trial.ts','receiver-h264-avi-cfr-trial.ts','ts-stability-audit.ts','core.ts','time-seek.ts'];
 const normalize=s=>s.replaceAll('\r\n','\n').replaceAll('bind-c0004-artifact.js','file-fingerprint.js').replaceAll('verified-angel-normalized-artifact-v1','verified-sampleA-normalized-artifact-v1');
 for(const name of files){const [a,b]=await Promise.all([privateRoot,publicRoot].map(root=>fs.readFile(path.join(root,'src',name),'utf8')));assert.equal(normalize(a),normalize(b),'Unexpected common playback divergence: '+name);}
 return {compared:files.length,matched:true,normalizations:['line endings','historical fingerprint module name','historical policy schema alias'],intentionalDifferences:['Public localhost management and source containment','Public explicit external runtime override','Private development tools and non-runtime research tests']};
}
async function candidate(source,distribution){
 const read=async f=>JSON.parse(await fs.readFile(f,'utf8'));
 const pkg=await read(path.join(source,'package.json')),manifest=await read(path.join(distribution,'manifest.json'));
 const text=await fs.readFile(path.join(distribution,'app/src/product-version.js'),'utf8'),appVersion=/PRODUCT_VERSION\s*=\s*['"]([^'"]+)/.exec(text)?.[1];
 const notes=await fs.readFile(path.join(distribution,'RELEASE-NOTES-ja.md'),'utf8'),notesVersion=/v(\d+\.\d+\.\d+)/.exec(notes)?.[1];
 const policy=await read(path.join(distribution,'defaults/jit.json'));
 let individualGrants=0;for(const name of['capabilities','clientAdmissions','clientTrials','dualAudioPermissions','wmaInputPermissions','receiverCfrTrials','receiverWmvCfrTrials','receiverH264AviCfrTrials'])individualGrants+=(policy[name]??[]).length;
 const bundledRuntime=(await Promise.all(['node','ffmpeg','ffprobe'].map(n=>fs.stat(path.join(distribution,'runtime',n+'.exe')).then(s=>s.isFile()).catch(()=>false)))).every(Boolean);
 return {packageVersion:pkg.version,manifest,appVersion,notesVersion,individualGrants,bundledRuntime,bundledNode:await fs.stat(path.join(distribution,'runtime/node.exe')).then(s=>s.isFile()).catch(()=>false)};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const args=process.argv.slice(2).filter(v=>v!=='--for-publication');assert.equal(args.length,4,'Private source, Public source, Private package, Public package required');
 console.log(JSON.stringify({...assertReleasePair(await candidate(args[0],args[2]),await candidate(args[1],args[3]),{requirePublicationReady:process.argv.includes('--for-publication')}),common:await commonCodeParity(args[0],args[1])},null,2));
}
