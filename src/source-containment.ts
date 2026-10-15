import {promises as fs}from'node:fs';import{withinSourcePath}from'./library-discovery.js';
/** Canonical check repeated at GET; discovery also skips symlinks/reparse entries. */
export async function sourceContained(file:string,folders:readonly string[]):Promise<boolean>{
 try{const actual=await fs.realpath(file),roots=await Promise.all(folders.map(f=>fs.realpath(f).catch(()=>'')));return roots.some(r=>!!r&&withinSourcePath(actual,r));}catch{return false;}
}
