import test from'node:test';import assert from'node:assert/strict';
import os from'node:os';import path from'node:path';import{promises as fs}from'node:fs';
const modulePath='../packaging/external-ffmpeg.mjs';const{acceptableVersion,sameBuild,externalFFmpeg}=await import(modulePath);
test('external FFmpeg rejects the historical 7.1.1 baseline and unknown builds, accepts patched versions',()=>{
 for(const v of['ffmpeg version 7.1.1-full_build','ffmpeg version 6.1','ffmpeg version N-unknown'])assert.equal(acceptableVersion(v),false);
 for(const v of['ffmpeg version 7.1.2-full_build','ffprobe version 8.1.2-essentials_build'])assert.equal(acceptableVersion(v),true);
});
test('missing user-managed FFmpeg gives actionable setup instructions without installing anything',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pt3-external-missing-'));
 try{await assert.rejects(externalFFmpeg(dir,{ffmpegDirectory:dir}),/FFmpeg\/ffprobe.*Setup/s);assert.deepEqual(await fs.readdir(dir),[]);}finally{await fs.rmdir(dir);}
});
test('matching executable builds ignore different copyright years but require version, compiler and configuration',()=>{
 const a='ffmpeg version 8.1.2-essentials Copyright 2000-2026\nbuilt with gcc 15\nconfiguration: --enable-gpl --enable-libx264\n';
 const b=a.replace('ffmpeg','ffprobe').replace('2000','2007');
 assert.equal(sameBuild(a,b),true);
 assert.equal(sameBuild(a,b.replace('8.1.2','8.1.1')),false);
 assert.equal(sameBuild(a,b.replace('gcc 15','gcc 14')),false);
 assert.equal(sameBuild(a,b.replace('--enable-gpl','--disable-gpl')),false);
 assert.equal(sameBuild('unknown','unknown'),false);
});
