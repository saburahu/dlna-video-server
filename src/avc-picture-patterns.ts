import assert from 'node:assert/strict';
/** Diagnostics only: retain all other recorded production encoder arguments. */
export function picturePatternArguments(recorded:string[],variant:'baseline'|'resolution720'|'cfr2997'|'cfr23976'|'cfr24'|'cfr30',output:string,seconds=30){
 assert.ok(seconds>=5&&seconds<=60&&output.endsWith('.ts'));
 const a=[...recorded],filter=a.indexOf('-vf')+1;
 assert.ok(a.at(-1)==='pipe:1'&&a.includes('libx264')&&filter>0&&a.includes('-t')&&a.includes('-i'));
 assert.ok(a[a.indexOf('-i')+1]!==output);
 a[a.indexOf('-t')+1]=String(seconds);a[a.length-1]=output;
 if(variant==='resolution720'){
  assert.ok(a[filter].includes('1920')&&a[filter].includes('1080'));
  a[filter]=a[filter].replaceAll('1920','1280').replaceAll('1080','720');
 }else if(variant!=='baseline'){
  const rates={cfr2997:'30000/1001',cfr23976:'24000/1001',cfr24:'24/1',cfr30:'30/1'};
  a[filter]+=`,fps=${rates[variant]}:round=near`;
 }
 return a;
}
