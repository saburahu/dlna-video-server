import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';

export interface WebpMetadata {
 version:'webp-riff-v1'; width:number; height:number; animated:boolean; frames:number;
 durationMs:number; loopCount?:number; alpha:boolean; colorSpace:'sRGB-assumed'|'embedded-ICC';
 orientation:number; issues:string[];
}
function orientation(b:Buffer){
 if(b.subarray(0,6).equals(Buffer.from('Exif\0\0')))b=b.subarray(6);
 assert.ok(b.length>=8,'Truncated Exif');
 const le=b.toString('ascii',0,2)==='II';if(!le&&b.toString('ascii',0,2)!=='MM')throw Error('Invalid Exif byte order');
 const u16=(p:number)=>le?b.readUInt16LE(p):b.readUInt16BE(p),u32=(p:number)=>le?b.readUInt32LE(p):b.readUInt32BE(p);
 assert.equal(u16(2),42);const at=u32(4);assert.ok(at+2<=b.length);const n=u16(at);assert.ok(at+2+n*12<=b.length);
 for(let i=0;i<n;i++){const p=at+2+12*i;if(u16(p)===0x112){assert.equal(u16(p+2),3);assert.equal(u32(p+4),1);const v=u16(p+8);assert.ok(v>=1&&v<=8);return v;}}
 return 1;
}
/** RIFF headers only. Chunk payloads are skipped; memory is independent of image/frame count. */
export async function inspectWebp(file:string,signal?:AbortSignal):Promise<WebpMetadata>{
 signal?.throwIfAborted();
 const h=await fs.open(file,'r');
 try{
  const st=await h.stat(),head=Buffer.alloc(12);assert.equal((await h.read(head,0,12,0)).bytesRead,12);
  assert.equal(head.toString('ascii',0,4),'RIFF');assert.equal(head.toString('ascii',8,12),'WEBP');
  const end=head.readUInt32LE(4)+8;assert.equal(end,st.size,'Truncated/trailing WebP RIFF');
  const m:WebpMetadata={version:'webp-riff-v1',width:0,height:0,animated:false,frames:0,durationMs:0,alpha:false,colorSpace:'sRGB-assumed',orientation:1,issues:[]};
  let count=0,hasImage=false,animHeader=false,images=0,imageWidth=0,imageHeight=0;
  for(let p=12;p<end;){
   signal?.throwIfAborted();
   assert.ok(++count<=100000&&p+8<=end,'RIFF chunk limit/boundary');
   const b=Buffer.alloc(8);assert.equal((await h.read(b,0,8,p)).bytesRead,8);const tag=b.toString('ascii',0,4),size=b.readUInt32LE(4),next=p+8+size+(size&1);
   assert.ok(next<=end,'Truncated WebP chunk');
   const take=tag==='EXIF'?Math.min(size,65536):Math.min(size,16),v=Buffer.alloc(take);assert.equal((await h.read(v,0,take,p+8)).bytesRead,take);
   if(tag==='VP8X'){assert.equal(size,10);m.animated=!!(v[0]&2);m.alpha=!!(v[0]&16);m.width=v.readUIntLE(4,3)+1;m.height=v.readUIntLE(7,3)+1;}
   if(tag==='VP8 '){assert.ok(v.length>=10&&v.subarray(3,6).equals(Buffer.from([0x9d,1,0x2a])));imageWidth=v.readUInt16LE(6)&16383;imageHeight=v.readUInt16LE(8)&16383;if(!m.width){m.width=imageWidth;m.height=imageHeight;}hasImage=true;images++;}
   if(tag==='VP8L'){assert.ok(v.length>=5&&v[0]===0x2f);const bits=v.readUInt32LE(1);imageWidth=(bits&16383)+1;imageHeight=((bits>>>14)&16383)+1;if(!m.width){m.width=imageWidth;m.height=imageHeight;}images++;m.alpha||=!!(bits&(1<<28));hasImage=true;}
   if(tag==='ALPH')m.alpha=true;
   if(tag==='ICCP')m.colorSpace='embedded-ICC';
   if(tag==='EXIF'){if(size>65536)m.issues.push('Exif exceeds bounded inspection');else try{m.orientation=orientation(v);}catch{m.issues.push('Invalid Exif orientation');}}
   if(tag==='ANIM'){assert.ok(size>=6);m.loopCount=v.readUInt16LE(4);animHeader=true;}
   if(tag==='ANMF'){assert.ok(size>=16);const w=v.readUIntLE(6,3)+1,hh=v.readUIntLE(9,3)+1;assert.ok(2*v.readUIntLE(0,3)+w<=m.width&&2*v.readUIntLE(3,3)+hh<=m.height);m.frames++;m.durationMs+=v.readUIntLE(12,3);}
   p=next;
  }
  assert.ok(m.width>0&&m.height>0);
  if(m.animated)assert.ok(animHeader&&m.frames>0,'Incomplete animation');
  else{assert.ok(hasImage&&images===1&&m.frames===0&&!animHeader,'Inconsistent still/animation flags');assert.ok(m.width===imageWidth&&m.height===imageHeight,'Canvas/image dimensions disagree');m.frames=1;}
  return m;
 }finally{await h.close();}
}
