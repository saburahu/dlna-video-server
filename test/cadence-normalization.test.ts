import {test} from 'node:test';import assert from 'node:assert/strict';
import {minimumRemovalTicks,selectCompatiblePictures} from '../src/cadence-normalization.js';
test('coded size and explicit level constraints derive the integer deadline without device defaults',()=>{
  const c={codedWidth:1920,codedHeight:1088,maxMBPS:245760,minimumFrameSeconds:1/172,timebase:90000};
  assert.deepEqual(minimumRemovalTicks(c),{macroblocks:8160,minimumSeconds:0.033203125,minimumTicks:2989});
  assert.equal(minimumRemovalTicks({...c,maxMBPS:522240}).minimumTicks,1407);
  assert.throws(()=>minimumRemovalTicks({...c,timebase:0}));
});
test('only dense pictures are dropped, original times and sparse VFR stay intact',()=>{
  const pts=[0,4505,7508,9009,10511,13514,18019],r=selectCompatiblePictures(pts,2989);
  assert.deepEqual(r.retained.map(p=>p.pts),[0,4505,7508,10511,13514,18019]);assert.equal(r.dropped[0].index,3);assert.equal(r.duplicated,0);
  assert.deepEqual(pts,[0,4505,7508,9009,10511,13514,18019]);assert.throws(()=>selectCompatiblePictures([0,0],2989));
});
test('90 short intervals are thinned with no shift and greedy keeps maximum possible pictures',()=>{
  const pts=Array.from({length:91},(_,i)=>i*1501),r=selectCompatiblePictures(pts,2989);
  assert.equal(r.retained.length,46);assert.equal(r.dropped.length,45);assert.equal(r.retained.at(-1)!.pts,pts.at(-1));
  for(const times of [[0,1,2,4,5,8],[0,3,4,5,7,11],[0,2,4,6,8]]){let best=0;for(let mask=1;mask<2**times.length;mask+=2){const p=times.filter((_,i)=>mask&(1<<i));if(p.every((v,i)=>!i||v-p[i-1]>=3))best=Math.max(best,p.length);}assert.equal(selectCompatiblePictures(times,3).retained.length,best);}
});
