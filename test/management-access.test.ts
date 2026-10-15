import test from'node:test';import assert from'node:assert/strict';import{managementAccess,redactHeaders}from'../src/management-access.js';
const req=(remote='127.0.0.1',host='localhost:19090',method='GET',headers:Record<string,string>={})=>({socket:{remoteAddress:remote},headers:{host,...headers},method}) as any;
test('management allows loopback literal Host only; LAN, DNS rebinding, cross-site, foreign origins and absent write header fail closed',()=>{
 assert.equal(managementAccess(req(),19090),undefined);assert.equal(managementAccess(req('::ffff:127.0.0.1','127.0.0.1:19090','POST',{'x-pt3-management':'1'}),19090),undefined);
 for(const r of[req('10.254.254.1'),req('127.0.0.1','attacker.example:19090'),req('127.0.0.1','localhost:19091'),req('127.0.0.1','localhost:19090','GET',{origin:'https://attacker.example'}),req('127.0.0.1','localhost:19090','GET',{'sec-fetch-site':'cross-site'}),req('127.0.0.1','localhost:19090','POST')])assert.ok(managementAccess(r,19090));
});
test('diagnostic headers redact credentials recursively without mutating input',()=>{const v={requestHeaders:{Authorization:'secret',Cookie:'session'},other:'keep'};assert.deepEqual(redactHeaders(v),{requestHeaders:{Authorization:'[REDACTED]',Cookie:'[REDACTED]'},other:'keep'});assert.equal(v.requestHeaders.Authorization,'secret');});
