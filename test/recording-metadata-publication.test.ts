import test from 'node:test';import assert from 'node:assert/strict';
import {programs,applyRecordingMetadata,systemUpdateId} from '../src/store.js';
import type {RecordingMetadata} from '../src/recording-metadata.js';

test('publication uses the discovery Stats Date, including rounded NTFS fractions; stale revisions are rejected',()=>{
 const source='publication-source.ts',modified='2026-01-01T00:00:00.113Z',mtime=new Date(modified);
 const fractionalMilliseconds=Date.parse('2026-01-01T00:00:00.112Z')+0.5818;
 assert.notEqual(new Date(fractionalMilliseconds).getTime(),mtime.getTime());
 const previous=programs.splice(0),metadata:RecordingMetadata={state:'no-eit'};
 try{
  programs.push({id:'publication',filePath:source,title:'filename',size:188,modified,published:true,analysis:'ok'});
  const update=systemUpdateId;assert.equal(applyRecordingMetadata(source,metadata,188,mtime),true);
  assert.equal(programs[0].metadata,metadata);assert.equal(systemUpdateId,update+1);
  assert.equal(applyRecordingMetadata(source,metadata,188,mtime),false);
  assert.equal(applyRecordingMetadata(source,{state:'pending'},188,new Date(mtime.getTime()+1)),false);
  assert.equal(applyRecordingMetadata(source,{state:'pending'},189,mtime),false);
  assert.equal(systemUpdateId,update+1);
 }finally{programs.splice(0,programs.length,...previous);}
});
