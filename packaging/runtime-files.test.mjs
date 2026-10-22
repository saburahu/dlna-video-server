import test from 'node:test';import assert from 'node:assert/strict';
import {runtimeFiles} from './runtime-files.mjs';
test('portable runtime closure retains static/reexport/dynamic imports and excludes unused developer helpers',()=>{
 const files=new Map([['server.js',"import './a.js'; export * from './b.js'; import('./c.js');"],['a.js',"import './b.js'; import fs from 'node:fs';"],['b.js',''],['c.js',''],['verify-private.js',"const secret='private test locator';"]]);
 assert.deepEqual([...runtimeFiles(files)].sort(),['a.js','b.js','c.js','server.js']);
});
test('portable runtime closure fails closed on missing, escaped or unresolved dependencies',()=>{
 for(const source of ["import './missing.js';","import '../private.js';","import(name);"])assert.throws(()=>runtimeFiles(new Map([['server.js',source]])));
});
