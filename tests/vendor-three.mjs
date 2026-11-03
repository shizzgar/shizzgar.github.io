import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

const file = new URL('../vendor/three-r160.module.min.js', import.meta.url);
const bytes = await readFile(file);
assert.equal(bytes.length, 670681);
assert.equal(createHash('sha256').update(bytes).digest('hex'), '3e690ac7d180b0aadf0891bea39eec643e29e2d3e75c99b18689518665f69ba6', 'vendored runtime matches official r160 build');
const source = bytes.toString('utf8');
assert.doesNotMatch(source, /\bimport\s*\(/, 'pinned core has no deferred dependency downloads');
assert.match(await readFile(new URL('../vendor/three-LICENSE.txt', import.meta.url),'utf8'), /The MIT License/);
const THREE = await import(file.href);
assert.equal(THREE.REVISION, '160');
assert.equal(typeof THREE.WebGLRenderer, 'function');
console.log('PASS pinned Three.js source integrity, license and module exports');
