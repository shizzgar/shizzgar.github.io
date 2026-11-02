import assert from 'node:assert/strict';
import {createOffloadLogCollector} from '../gpu-engine-log.js';
const a=createOffloadLogCollector(),b=createOffloadLogCollector();
assert.equal(a.getResult(),null);
for (const value of [
  'prefix load_tensors: offloaded 41/41 layers to GPU',
  'load_tensors: offloaded 41/41 layers to GPU plus extra',
  'load_tensors: offloaded 42/41 layers to GPU',
  'load_tensors: offloaded 0/0 layers to GPU',
  'load_tensors: offloaded -1/41 layers to GPU',
  'other: offloaded 1/41 layers to GPU',
  {toString(){throw Error('must not be called')}},
]) a.logger.debug(value);
a.logger.log('load_tensors: offloaded 41/41 layers to GPU');
a.logger.debug('load_tensors: offloaded 41/41 layers to GPU', 'extra');
assert.equal(a.getResult(),null);
a.logger.debug('load_tensors: offloaded 41/41 layers to GPU\n');
assert.deepEqual(a.getResult(),{gpuLayers:41,totalLayers:41});
const copy=a.getResult();copy.gpuLayers=0;assert.equal(a.getResult().gpuLayers,41);
assert.equal(b.getResult(),null);
b.logger.debug('load_tensors: offloaded 0/41 layers to GPU');
assert.deepEqual(b.getResult(),{gpuLayers:0,totalLayers:41});
assert.equal(a.getResult().gpuLayers,41);
console.log('PASS strict per-worker GPU offload log collection');
