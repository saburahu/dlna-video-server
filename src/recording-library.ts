import {promises as fs} from 'node:fs';
import path from 'node:path';
import type {BrowseInput,BrowsePage} from './experimental-catalog.js';
export const LIBRARY_VIEWS=new Set(['all']);
export const LIBRARY_PAGE_LIMIT=200;
/** Optional integration switch. Corrupt/missing config is disabled. */
export function librarySwitch(directory:string){
 let stamp=-2,enabled=false,revision=0;
 const read=async()=>{const file=path.join(directory,'library.json'),next=await fs.stat(file).then(s=>s.mtimeMs).catch(()=>-1);if(next!==stamp){stamp=next;try{const p=JSON.parse(await fs.readFile(file,'utf8'));enabled=p.version==='recording-library-v1'&&p.enabled===true;revision=p.version==='recording-library-v1'&&Number.isSafeInteger(p.revision)&&p.revision>=0?p.revision:0;}catch{enabled=false;revision=0;}}return enabled;};
 return Object.assign(read,{revision:async()=>{await read();return revision;}});
}
/** TS prefix is immutable. Query only the catalog portion of the requested page. */
export function libraryPagePlan(start:number,count:number,tsTotal:number){
 if(!Number.isSafeInteger(start)||start<0||!Number.isSafeInteger(count)||count<0)throw Error('Invalid library page');
 const limit=count===0?LIBRARY_PAGE_LIMIT:Math.min(count,LIBRARY_PAGE_LIMIT),tsCount=Math.max(0,Math.min(limit,tsTotal-start));
 return {limit,tsStart:start,tsCount,catalogStart:Math.max(0,start-tsTotal),catalogCount:limit-tsCount};
}
export function combineLibraryPage(ts:BrowsePage,items:string[],total:number,updateId:number):BrowsePage{
 return {didl:ts.didl.replace('</DIDL-Lite>',items.join('')+'</DIDL-Lite>'),numberReturned:ts.numberReturned+items.length,total,updateId};
}
