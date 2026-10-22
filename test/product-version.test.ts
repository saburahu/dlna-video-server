import test from 'node:test';import assert from 'node:assert/strict';import{promises as fs}from'node:fs';import{PRODUCT_VERSION}from'../src/product-version.js';
test('package, lockfile and management UI share the product SemVer',async()=>{
 const pkg=JSON.parse(await fs.readFile('package.json','utf8')),lock=JSON.parse(await fs.readFile('package-lock.json','utf8'));
 assert.equal(PRODUCT_VERSION,pkg.version);assert.equal(lock.version,pkg.version);assert.equal(lock.packages[''].version,pkg.version);
 assert.ok((await fs.readFile('public/index.html','utf8')).includes('v'+PRODUCT_VERSION));
});
