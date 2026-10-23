import assert from'node:assert/strict';
export const REQUIRED_PLAYBACK_CASES=['avc-avi-mp3-pair','avc-asf-wmapro-pair','avc-asf-wmav2-pair','wrong-receiver','wrong-source','legacy-unscoped','duplicate-permission','receiver-capability-new-source','source-exception-priority'];
/** An offline release gate, not a receiver capability or an enrollment. */
export function assertPlaybackCompatibility(evidence,builds){
 assert.equal(evidence?.version,'playback-compatibility-evidence-v1');assert.equal(evidence.passed,true,'Playback compatibility evidence failed');
 for(const build of builds){const edition=evidence.editions?.find(e=>e.edition===build.edition);assert.equal(edition?.sourceCommit,build.sourceCommit,'Stale/different playback compatibility build');
  for(const id of REQUIRED_PLAYBACK_CASES){const entries=edition.cases?.filter(c=>c.id===id);assert.equal(entries?.length,1,'Missing/duplicate playback case: '+id);assert.equal(entries[0].passed,true,'Playback regression: '+id);assert.ok(['automatic-test','isolated-http'].includes(entries[0].verification),'Missing verification boundary');}
  assert.equal(edition.normalVfrPreserved,true);assert.equal(edition.audioEndpointToleranceMs,64);assert.equal(edition.individualDefaultsEmpty,true);
 }
 return{passed:true,requiredCases:REQUIRED_PLAYBACK_CASES.length};
}
