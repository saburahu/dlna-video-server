import {VirtualChildren,parseVirtual} from './virtual-folders.js';
import path from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {snapshotHash} from './playback-shadow.js';
import {sourcePathKey,withinSourcePath} from './library-discovery.js';

export const FOLDER_ROOT='folders';
const hash=(s:string)=>snapshotHash(s).slice(0,32);
export const rootIdentity=(source:string)=>hash(sourcePathKey(source));
export const folderIdentity=(root:string,relative:string)=>`library/folder/${hash(rootIdentity(root)+'/'+(process.platform==='win32'?relative.toLowerCase():relative).split(path.sep).join('/'))}`;
export interface FolderRow {id:string;parent:string;root_id:string;name:string;sort_key:string;kind:'folder'|'media';source_path?:string;source_id?:string;children?:number}
/** Display labels never participate in identities. Always keep a root level. */
export function rootLabels(roots:readonly string[]){
 const basic=roots.map(root=>{const parsed=path.parse(root),name=path.basename(root)||parsed.root,volume=parsed.root.replace(/[\\/]+$/,'');return {root,name,label:`${name} (${volume||'root'})`};});
 return basic.map(r=>({root:r.root,label:basic.filter(x=>x.label.toLowerCase()===r.label.toLowerCase()).length>1?`${r.name} (${path.dirname(r.root)})`:r.label}));
}
export function initializeFolders(db:DatabaseSync){
 db.exec(`CREATE TABLE IF NOT EXISTS folders(id TEXT PRIMARY KEY,parent TEXT NOT NULL,root_id TEXT NOT NULL,name TEXT NOT NULL,sort_key TEXT NOT NULL) STRICT;
 CREATE INDEX IF NOT EXISTS folders_parent ON folders(parent,sort_key,id);
 CREATE INDEX IF NOT EXISTS folders_root ON folders(root_id);
 CREATE TABLE IF NOT EXISTS folder_media(id TEXT PRIMARY KEY,parent TEXT NOT NULL,root_id TEXT NOT NULL,name TEXT NOT NULL,sort_key TEXT NOT NULL,source_path TEXT NOT NULL,source_id TEXT NOT NULL) STRICT;
 CREATE INDEX IF NOT EXISTS folder_media_parent ON folder_media(parent,sort_key,id);
 CREATE INDEX IF NOT EXISTS folder_media_root ON folder_media(root_id);`);
}
/** Index-only projection. A source is stored once in the catalog but may have multiple root placements. */
export class FolderIndex {
 constructor(private db:DatabaseSync){}
 begin(roots:readonly {configured:string;real:string}[]){
  this.db.exec('DROP TABLE IF EXISTS temp.next_folders; DROP TABLE IF EXISTS temp.next_folder_media; CREATE TEMP TABLE next_folders AS SELECT * FROM folders WHERE 0; CREATE UNIQUE INDEX next_folders_id ON next_folders(id); CREATE TEMP TABLE next_folder_media AS SELECT * FROM folder_media WHERE 0; CREATE UNIQUE INDEX next_folder_media_id ON next_folder_media(id);');
  const folder=this.db.prepare('INSERT OR IGNORE INTO next_folders VALUES(?,?,?,?,?)'),media=this.db.prepare('INSERT OR IGNORE INTO next_folder_media VALUES(?,?,?,?,?,?,?)');
  const labels=rootLabels(roots.map(r=>r.configured));
  const addDirectory=(directory:string)=>{for(const r of roots){if(!withinSourcePath(directory,r.real))continue;const rel=path.relative(r.real,directory),id=folderIdentity(r.configured,rel),parent=rel?folderIdentity(r.configured,path.dirname(rel)==='.'?'':path.dirname(rel)):FOLDER_ROOT,name=rel?path.basename(directory):labels.find(x=>x.root===r.configured)!.label;folder.run(id,parent,rootIdentity(r.configured),name,name.toLowerCase());}};
  for(const r of roots)addDirectory(r.real);
  return {directory:addDirectory,media:(file:string,sourceId:string)=>{addDirectory(path.dirname(file));for(const r of roots){if(!withinSourcePath(file,r.real))continue;const parent=folderIdentity(r.configured,path.relative(r.real,path.dirname(file))),name=path.basename(file);media.run(`library/folder-item/${hash(parent+'/'+sourcePathKey(file))}`,parent,rootIdentity(r.configured),name,name.toLowerCase(),file,sourceId);}},
   commit:(failedRoots:readonly string[])=>{
    for(const r of roots)if(failedRoots.some(f=>withinSourcePath(f,r.real)||withinSourcePath(f,r.configured))){const id=rootIdentity(r.configured);this.db.prepare('INSERT OR IGNORE INTO next_folders SELECT * FROM folders WHERE root_id=?').run(id);this.db.prepare('INSERT OR IGNORE INTO next_folder_media SELECT * FROM folder_media WHERE root_id=?').run(id);}
    const changes=Number(this.db.prepare(`SELECT EXISTS(SELECT * FROM folders EXCEPT SELECT * FROM next_folders) OR EXISTS(SELECT * FROM next_folders EXCEPT SELECT * FROM folders) OR EXISTS(SELECT * FROM folder_media EXCEPT SELECT * FROM next_folder_media) OR EXISTS(SELECT * FROM next_folder_media EXCEPT SELECT * FROM folder_media) changed`).get()!.changed);
    if(changes)this.db.exec(`DELETE FROM folders WHERE id NOT IN (SELECT id FROM next_folders);
      INSERT INTO folders SELECT * FROM next_folders WHERE true ON CONFLICT(id) DO UPDATE SET parent=excluded.parent,root_id=excluded.root_id,name=excluded.name,sort_key=excluded.sort_key WHERE folders.parent!=excluded.parent OR folders.name!=excluded.name OR folders.sort_key!=excluded.sort_key;
      DELETE FROM folder_media WHERE id NOT IN (SELECT id FROM next_folder_media);
      INSERT INTO folder_media SELECT * FROM next_folder_media WHERE true ON CONFLICT(id) DO UPDATE SET parent=excluded.parent,root_id=excluded.root_id,name=excluded.name,sort_key=excluded.sort_key,source_path=excluded.source_path,source_id=excluded.source_id WHERE folder_media.name!=excluded.name OR folder_media.source_path!=excluded.source_path OR folder_media.source_id!=excluded.source_id;`);
    return changes>0;
   }};
 }
 get(id:string):FolderRow|undefined{
  const f=this.db.prepare('SELECT *,\'folder\' kind FROM folders WHERE id=?').get(id) as unknown as FolderRow|undefined;if(f)return {...f,children:this.count(id)};
  return this.db.prepare('SELECT *,\'media\' kind FROM folder_media WHERE id=?').get(id) as unknown as FolderRow|undefined;
 }
 count(parent:string){return Number(this.db.prepare('SELECT (SELECT count(*) FROM folders WHERE parent=?)+(SELECT count(*) FROM folder_media WHERE parent=?) n').get(parent,parent)!.n);}
 page(parent:string,start:number,count:number){
  if(!Number.isSafeInteger(start)||start<0||!Number.isSafeInteger(count)||count<0)throw Error('Invalid folder page');
  this.db.exec('BEGIN');try{const total=this.count(parent),rows=this.db.prepare(`SELECT *, 'folder' kind, NULL source_path,NULL source_id,0 priority FROM folders WHERE parent=? UNION ALL SELECT id,parent,root_id,name,sort_key,'media' kind,source_path,source_id,1 priority FROM folder_media WHERE parent=? ORDER BY priority,sort_key,id LIMIT ? OFFSET ?`).all(parent,parent,Math.min(count||200,200),start) as unknown as FolderRow[];
   return {total,rows:rows.map(r=>r.kind==='folder'?{...r,children:this.count(r.id)}:r)};
  }finally{this.db.exec('COMMIT');}
 }
 projection(parent:string){const f=Number(this.db.prepare('SELECT count(*) n FROM folders WHERE parent=?').get(parent)!.n),m=Number(this.db.prepare('SELECT count(*) n FROM folder_media WHERE parent=?').get(parent)!.n);return new VirtualChildren(parent,f,m);}
 position(row:FolderRow){const table=row.kind==='folder'?'folders':'folder_media';return Number(this.db.prepare('SELECT count(*) n FROM '+table+' WHERE parent=? AND (sort_key<? OR (sort_key=? AND id<?))').get(row.parent,row.sort_key,row.sort_key,row.id)!.n);}
 axisPage(parent:string,axis:'folders'|'media',start:number,count:number){const table=axis==='folders'?'folders':'folder_media';return this.db.prepare('SELECT *, ? kind FROM '+table+' WHERE parent=? ORDER BY sort_key,id LIMIT ? OFFSET ?').all(axis==='folders'?'folder':'media',parent,count,start) as unknown as FolderRow[];}
 browseGet(id:string):FolderRow|undefined{
  const parsed=parseVirtual(id);if(parsed){if(parsed.base!==FOLDER_ROOT&&this.get(parsed.base)?.kind!=='folder')return;const n=this.projection(parsed.base).node(id);return n?{id:n.id,parent:n.parent,root_id:'',name:n.title,sort_key:'',kind:'folder',children:n.children}:undefined;}
  const r=id===FOLDER_ROOT?{id,parent:'rec',root_id:'',name:'フォルダ別',sort_key:'',kind:'folder' as const}:this.get(id);if(!r)return;
  return {...r,parent:id===FOLDER_ROOT?r.parent:this.projection(r.parent).parent(r.kind==='folder'?'folders':'media',this.position(r))??r.parent,...(r.kind==='folder'?{children:this.projection(id).page(id,0,1).total}:{})};
 }
 browsePage(id:string,start:number,count:number){
  const base=parseVirtual(id)?.base??id;if(base!==FOLDER_ROOT&&this.get(base)?.kind!=='folder')return {total:0,rows:[] as FolderRow[]};const projection=this.projection(base),page=projection.page(id,start,count),lookups=new Map<string,FolderRow>();
  for(const axis of ['folders','media'] as const){const indices=page.children.filter(c=>c.kind==='entry'&&c.axis===axis).map(c=>c.kind==='entry'?c.index:0);if(!indices.length)continue;const lo=Math.min(...indices),hi=Math.max(...indices);this.axisPage(base,axis,lo,hi-lo+1).forEach((r,i)=>lookups.set(axis+':'+(lo+i),r));}
  return {total:page.total,rows:page.children.map(c=>{if(c.kind==='virtual')return {id:c.id,parent:c.parent,root_id:'',name:c.title,sort_key:'',kind:'folder',children:c.children} as FolderRow;const r=lookups.get(c.axis+':'+c.index)!;return {...r,parent:c.parent,...(r.kind==='folder'?{children:this.projection(r.id).page(r.id,0,1).total}:{})};})};
 }

}
