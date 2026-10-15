import {legacyAudioEndpoint,legacyAudioStart} from '../src/legacy-audio.js';
import {parseInstalledJitDecoders} from '../src/jit-source-support.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createServer} from 'node:http';
import {openMediaIndex,indexedExperimentalEntry,photoCachePath} from '../src/media-catalog-index.js';
import {createExperimentalCatalog} from '../src/experimental-catalog.js';
import {inspectWebp} from '../src/webp-metadata.js';
import {photoItem,photoTarget,stillSupported,createImageDelivery} from '../src/image-delivery.js';
import {readShadowJson,saveShadowJson} from '../src/playback-shadow-store.js';
import {snapshotHash} from '../src/playback-shadow.js';
import {execute,ffmpeg,ffprobe} from '../src/prepare-executor.js';
import {browseDIDL} from '../src/upnp.js';
import {profiles} from '../src/core.js';
import {jitArguments} from '../src/jit-stream.js';

const chunk=(tag:string,b:Buffer)=>{const h=Buffer.alloc(8);h.write(tag);h.writeUInt32LE(b.length,4);return Buffer.concat([h,b,...(b.length%2?[Buffer.alloc(1)]:[])]);};
const riff=(chunks:Buffer[])=>{const body=Buffer.concat([Buffer.from('WEBP'),...chunks]),header=Buffer.alloc(8);header.write('RIFF');header.writeUInt32LE(body.length,4);return Buffer.concat([header,body]);};
const vp8x=(flags=0)=>{const b=Buffer.alloc(10);b[0]=flags;b.writeUIntLE(399,4,3);b.writeUIntLE(199,7,3);return chunk('VP8X',b);};
const vp8=()=>chunk('VP8 ',Buffer.from([0,0,0,0x9d,1,0x2a,0x90,1,0xc8,0]));
const anim=()=>{const f=Buffer.alloc(16);f.writeUIntLE(399,6,3);f.writeUIntLE(199,9,3);f.writeUIntLE(100,12,3);return riff([vp8x(2),chunk('ANIM',Buffer.alloc(6)),chunk('ANMF',f),chunk('ANMF',f)]);};

test('bounded RIFF metadata distinguishes still, alpha, animation, ICC, Exif and corruption',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'webp-meta-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const file=path.join(dir,'image.webp');
 await fs.writeFile(file,riff([vp8()]));let m=await inspectWebp(file);assert.equal(m.width,400);assert.equal(m.frames,1);assert.ok(stillSupported(m));
 await fs.writeFile(file,anim());m=await inspectWebp(file);assert.equal(m.animated,true);assert.equal(m.frames,2);assert.equal(m.durationMs,200);assert.equal(m.loopCount,0);assert.ok(!stillSupported(m));
 await fs.writeFile(file,riff([vp8x(16),chunk('ICCP',Buffer.from('ICC')),vp8()]));m=await inspectWebp(file);assert.equal(m.alpha,true);assert.equal(m.colorSpace,'embedded-ICC');assert.ok(!stillSupported(m));
 const wrongCanvas=vp8x();wrongCanvas.writeUIntLE(9999,12,3);await fs.writeFile(file,riff([wrongCanvas,vp8()]));await assert.rejects(inspectWebp(file),/dimensions disagree/);
 await fs.writeFile(file,anim().subarray(0,30));await assert.rejects(inspectWebp(file));
 await fs.writeFile(file,riff([vp8x(2),vp8()]));await assert.rejects(inspectWebp(file),/Incomplete animation/);
});

test('catalog indexes AVI/WMV/ASF incrementally; WebP is an independent paged image projection',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'legacy-catalog-')),media=path.join(dir,'media'),cache=path.join(dir,'cache');await fs.mkdir(media);
 for(const name of ['同名.mp4','同名.avi','旧作.WMV','asf.asf'])await fs.writeFile(path.join(media,name),'header fixture');
 const file=path.join(media,'画像.webp');await fs.writeFile(file,riff([vp8()]));await fs.writeFile(path.join(media,'動画.webp'),anim());
 let db=await openMediaIndex(cache);const catalog=createExperimentalCatalog(cache,()=>{throw Error('No probe on Browse');});t.after(async()=>{await catalog.closeIndex();db.close();await fs.rm(dir,{recursive:true,force:true});});
 const a=await db.scan([media],cache);assert.equal(a.added,6);assert.equal(db.count(),4);assert.equal(db.photoCount(),2);const id=db.find(file)!.objectId;
 assert.equal((await db.scan([media],cache)).updateId,a.updateId);db.close();db=await openMediaIndex(cache);assert.equal(db.find(file)!.objectId,id);
 for(const row of db.photoPage(0,0).entries)db.setMetadata(row.objectId,{path:row.path,size:row.size,mtimeMs:row.mtimeMs},{image:await inspectWebp(row.path),imageDecoderAvailable:true},0);
 assert.equal(db.page(0,200).entries.some(r=>r.container==='webp'),false);
 const imageRow=db.find(file)!;assert.ok(photoItem(imageRow,'http://test',photoTarget('http-get:*:image/jpeg:DLNA.ORG_PN=JPEG_MED')).includes('object.item.imageItem.photo'));
 const animation=db.photoPage(0,200).entries.find(r=>(r.metadata as any).image.animated)!;assert.ok(!photoItem(animation,'http://test',photoTarget('http-get:*:image/jpeg:DLNA.ORG_PN=JPEG_MED')).includes('<res'));
 const legacy=(metadata:boolean)=>browseDIDL('0',0,0,[],'http://test',profiles.standard,metadata);
 const root=await catalog.browse({objectId:'0',start:2,count:1,metadata:false},'', 'http://test',legacy);assert.equal(root?.total,3);assert.equal(root.numberReturned,1);assert.ok(root.didl.includes('id="photos"'));
 const page=await catalog.browse({objectId:'photos',start:1,count:1,metadata:false},'','http://test',legacy);assert.equal(page?.numberReturned,1);assert.equal(page.total,2);
 await fs.unlink(file);await db.scan([media],cache);assert.equal(db.photoCount(),1);assert.equal(db.find(file)?.availability,'missing');
});

test('legacy audio timeline reconciliation is explicit; existing filters and encoder settings stay unchanged',()=>{
 const old=jitArguments('source.mp4',2989,150),legacy=jitArguments('source.avi',2989,150,undefined,undefined,undefined,{reconcileAudioTimeline:true,deinterlace:true,resample:true});
 assert.equal(old[old.indexOf('-af')+1],'asettb=1/48000,ashowinfo,asetpts=STARTPTS+N');
 assert.ok(legacy[legacy.indexOf('-af')+1].startsWith('aresample=48000:async=1,'));assert.ok(legacy[legacy.indexOf('-vf')+1].includes('bwdif=mode=send_frame'));
 for(const key of ['-x264-params','-profile:v','-level:v','-muxrate','-pcr_period'])assert.equal(legacy[legacy.indexOf(key)+1],old[old.indexOf(key)+1]);
 assert.equal(photoTarget('http-get:*:image/webp:*'),undefined);
 assert.equal(photoTarget('http-get:*:image/jpeg:DLNA.ORG_PN=JPEG_SM')?.width,640);
});

test('real WebP JPEG HTTP: rotation, white alpha, bounded geometry, Range, fingerprint cache and stale rejection',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'webp-http-')),source=path.join(dir,'media','alpha.webp'),cache=path.join(dir,'cache'),oldShadow=process.env.PT3_SHADOW_DIR;
 process.env.PT3_SHADOW_DIR=path.join(dir,'shadow');await fs.mkdir(cache);await fs.mkdir(path.dirname(source));const events:string[]=[];
 const sink='http-get:*:image/jpeg:DLNA.ORG_PN=JPEG_MED',cap={deviceId:'uuid:image-fixture',remoteIp:'127.0.0.1',sink,sinkHash:snapshotHash(sink),controlUrl:'http://127.0.0.1/cm',acquiredAt:new Date().toISOString(),origin:'current-read' as const};
 await saveShadowJson(path.join(cache,'jit.json'),{enabled:true,capabilities:[cap]});await saveShadowJson(path.join(process.env.PT3_SHADOW_DIR,'devices.json'),[{remoteIp:'127.0.0.1',controlUrl:cap.controlUrl,descriptionUrl:'http://127.0.0.1/device'}]);
 await execute(ffmpeg(),['-nostdin','-v','error','-f','lavfi','-i','color=red:s=400x200,format=rgba,colorchannelmixer=aa=0','-frames:v','1','-c:v','libwebp','-lossless','1',source],{windowsHide:true,timeout:10000,maxBuffer:1048576});
 const original=await fs.readFile(source),chunks:Buffer[]=[];for(let p=12;p<original.length;){const n=original.readUInt32LE(p+4),next=p+8+n+(n&1);if(original.toString('ascii',p,p+4)!=='VP8X')chunks.push(original.subarray(p,next));p=next;}
 const exif=Buffer.alloc(26);exif.write('II');exif.writeUInt16LE(42,2);exif.writeUInt32LE(8,4);exif.writeUInt16LE(1,8);exif.writeUInt16LE(0x112,10);exif.writeUInt16LE(3,12);exif.writeUInt32LE(1,14);exif.writeUInt16LE(6,18);
 await fs.writeFile(source,riff([vp8x(16|8),...chunks,chunk('EXIF',exif)]));const before=await fs.readFile(source),st=await fs.stat(source);
 const db=await openMediaIndex(cache);await db.scan([path.dirname(source)],cache);let row=db.find(source)!;const metadata={image:await inspectWebp(source),imageDecoderAvailable:true};assert.equal(metadata.image.orientation,6);db.setMetadata(row.objectId,{path:source,size:st.size,mtimeMs:st.mtimeMs},metadata,0);row=db.get(row.objectId)!;
 const delivery=createImageDelivery(cache,event=>events.push(event),{capability:async()=>cap}),server=createServer((req,res)=>void delivery.deliver(req,res,row,'127.0.0.1'));
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${(server.address() as any).port}`;
 t.after(async()=>{await new Promise<void>(r=>server.close(()=>r()));db.close();if(oldShadow===undefined)delete process.env.PT3_SHADOW_DIR;else process.env.PT3_SHADOW_DIR=oldShadow;await fs.rm(dir,{recursive:true,force:true});});
 const response=await fetch(base),jpeg=Buffer.from(await response.arrayBuffer());assert.equal(response.status,200);assert.equal(Number(response.headers.get('content-length')),jpeg.length);assert.equal(response.headers.get('content-type'),'image/jpeg');assert.ok(response.headers.get('contentfeatures.dlna.org')?.includes('JPEG_MED'));
 const file=path.join(dir,'output.jpg');await fs.writeFile(file,jpeg);const info=JSON.parse((await execute(ffprobe(),['-v','error','-show_streams','-of','json',file],{windowsHide:true,timeout:10000})).stdout).streams[0];assert.equal(info.width,200);assert.equal(info.height,400);
 const pixel=await execute(ffmpeg(),['-v','error','-i',file,'-vf','crop=2:2:100:100,format=rgb24','-frames:v','1','-f','rawvideo','-'],{windowsHide:true,timeout:10000,encoding:'buffer',maxBuffer:1048576});assert.ok([...pixel.stdout].every(v=>v>=245),'Transparent pixels must become white');
 const range=await fetch(base,{headers:{Range:'bytes=0-15'}});assert.equal(range.status,206);assert.deepEqual(Buffer.from(await range.arrayBuffer()),jpeg.subarray(0,16));assert.ok(events.includes('IMAGE_CACHE_HIT'));
 const head=await fetch(base,{method:'HEAD'});assert.equal(Number(head.headers.get('content-length')),jpeg.length);assert.equal((await head.arrayBuffer()).byteLength,0);
 assert.deepEqual(await fs.readFile(source),before);await fs.appendFile(source,'changed');assert.equal((await fetch(base)).status,503);
});

test('decoder admission resolves codec aliases but never treats other installed decoders as certified',()=>{
 assert.deepEqual(parseInstalledJitDecoders(' V...BD msmpeg4 Microsoft MPEG4\n A....D wmapro WMAPro\n V...BD indeo5 Indeo\n'),['msmpeg4v3','wmapro']);
});

test('conventional image cache exclusion is scoped to generated image paths',()=>{
 assert.ok(photoCachePath(path.join('/library','.thumbnails','x.webp'),'/library'));
 assert.ok(photoCachePath(path.join('/library','deep','IMAGE-CACHE','x.webp'),'/library'));
 assert.ok(!photoCachePath(path.join('/library','日本語','写真.webp'),'/library'));
});

test('legacy decoded audio endpoint has fingerprint-bound cache, strict errors and cancellation',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'legacy-audio-')),file=path.join(dir,'audio.wma');t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 await execute(ffmpeg(),['-nostdin','-v','error','-f','lavfi','-i','sine=frequency=440:sample_rate=44100','-t','3.333','-c:a','wmav2',file],{windowsHide:true,timeout:10000});
 const probe=JSON.parse((await execute(ffprobe(),['-v','error','-show_streams','-show_format','-of','json',file],{windowsHide:true,timeout:10000})).stdout),st=await fs.stat(file),fp={path:file,size:st.size,mtimeMs:st.mtimeMs};
 const first=await legacyAudioEndpoint(fp,probe,path.join(dir,'cache'));assert.ok(first.end>3.2&&first.end<3.5);assert.equal(first.cacheHit,false);
 const decoded=await execute(ffmpeg(),['-hide_banner','-nostdin','-copyts','-i',file,'-map','0:a:0','-af','aresample=48000,asettb=1/48000,ashowinfo','-f','null','-'],{windowsHide:true,timeout:10000,maxBuffer:1048576});
 const frames=[...decoded.stderr.matchAll(/pts:(-?\d+) .*rate:(\d+) nb_samples:(\d+)/g)];assert.ok(frames.length);const last=frames.at(-1)!;
 assert.equal(first.end,(Number(last[1])+Number(last[3]))/Number(last[2]),'Reference is decoded source timestamp + samples, not a reconciled clock');
 const start=await legacyAudioStart(fp,probe,path.join(dir,'cache'));assert.equal(start.start,Number(frames[0][1])/Number(frames[0][2]));assert.equal(start.cacheHit,false);assert.equal((await legacyAudioStart(fp,probe,path.join(dir,'cache'))).cacheHit,true);
 const second=await legacyAudioEndpoint(fp,probe,path.join(dir,'cache'));assert.equal(second.end,first.end);assert.equal(second.cacheHit,true);
 const c=new AbortController();c.abort();await assert.rejects(legacyAudioEndpoint(fp,probe,path.join(dir,'cache'),c.signal));
 await fs.appendFile(file,'changed');await assert.rejects(legacyAudioEndpoint(fp,probe,path.join(dir,'cache')),/Stale/);
});
