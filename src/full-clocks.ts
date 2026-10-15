import assert from 'node:assert/strict';
export const PTS_MODULUS=2**33,TTS_MODULUS=2**32;
export function modularDelta(next:number,previous:number,modulus:number){assert.ok([next,previous,modulus].every(Number.isSafeInteger)&&modulus>0);return ((next-previous)%modulus+modulus)%modulus;}
export function congruentClock(actual:number,expected:number,modulus=PTS_MODULUS){const d=modularDelta(actual,expected,modulus);return Math.min(d,modulus-d);}
