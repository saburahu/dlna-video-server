import path from 'node:path';
import {promises as fs} from 'node:fs';
import type {Stats} from 'node:fs';

export const sourcePathKey=(file:string)=>process.platform==='win32'?path.resolve(file).toLowerCase():path.resolve(file);
export const withinSourcePath=(file:string,parent:string)=>{const relative=path.relative(sourcePathKey(parent),sourcePathKey(file));return relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative));};
export interface DiscoveryState {failedPaths:string[];linksSkipped:number;failedRoots?:string[];onDirectory?:(directory:string)=>void;signal?:AbortSignal;beforeDirectory?:()=>Promise<void>}
export interface RecordingInventory {roots:string[];entries:{file:string;stat:Stats}[];failedPaths:string[]}
/** Iterative, stat-only discovery. Never follows reparse links or loads media. */
export async function* discoverLibrary(roots:readonly string[],extensions:RegExp,state:DiscoveryState,
  io:Pick<typeof fs,'realpath'|'opendir'|'stat'>=fs){
 const visited=new Set<string>(),files=new Set<string>();
 const pending:{folder:string;root:string;file?:boolean}[]=[...roots].reverse().map(folder=>({folder:path.resolve(folder),root:path.resolve(folder)}));
 while(pending.length){const {folder,root,file:isFile}=pending.pop()!;
  state.signal?.throwIfAborted();
  if(isFile){try{const stat=await io.stat(folder),key=sourcePathKey(folder);if(stat.isFile()&&!files.has(key)){files.add(key);yield {file:folder,stat,root};}}catch{state.failedPaths.push(folder);(state.failedRoots??=[]).push(root);}continue;}
  await state.beforeDirectory?.();state.signal?.throwIfAborted();
  try{
   const real=await io.realpath(folder),key=sourcePathKey(real);if(visited.has(key))continue;
   const dir=await io.opendir(real);visited.add(key);
   state.onDirectory?.(real);
   const children:{folder:string;root:string;file?:boolean}[]=[];
   for await(const e of dir){const file=path.join(real,e.name);
    if(e.isSymbolicLink()){state.linksSkipped++;continue;}
    if(e.isDirectory()){children.push({folder:file,root});continue;}
    if(!e.isFile()||!extensions.test(e.name))continue;
    children.push({folder:file,root,file:true});
   }
   // Match the old readdir depth-first order, independent of OS enumeration.
   children.sort((a,b)=>{const x=sourcePathKey(a.folder),y=sourcePathKey(b.folder);return x<y?-1:x>y?1:0;});
   pending.push(...children.reverse());
  }catch{state.failedPaths.push(folder);(state.failedRoots??=[]).push(root);}
 }
}
