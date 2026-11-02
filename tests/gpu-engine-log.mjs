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

const c = createOffloadLogCollector();
assert.deepEqual(c.getDiagnostics(), {webgpuInitialized:null, modelBuffers:[]});
c.logger.debug('load_tensors:       WebGPU model buffer size =  2702.21 MiB');
c.logger.debug('load_tensors:          CPU model buffer size =    24.10 MiB\n');
c.logger.debug('load_tensors:   CPU_Mapped model buffer size =    1.20 MiB');
assert.deepEqual(c.getDiagnostics(), {webgpuInitialized:null, modelBuffers:[{backend:'WebGPU',mib:2702.21},{backend:'CPU',mib:24.1},{backend:'CPU_Mapped',mib:1.2}]});
c.logger.debug('ggml_webgpu: adapter_info: vendor_id: 4318 | vendor: nvidia | architecture: blackwell | device_id: 11266 | name: some-device | device_desc: NVIDIA GPU');
assert.equal(c.getDiagnostics().webgpuInitialized,true);
const snapshot=c.getDiagnostics();snapshot.modelBuffers[0].mib=0;snapshot.modelBuffers.push({backend:'BAD',mib:1});
assert.equal(c.getDiagnostics().modelBuffers[0].mib,2702.21);
assert.equal(c.getDiagnostics().modelBuffers.length,3);
const d=createOffloadLogCollector();
for (const msg of [
  'load_tensors:       GPU model buffer size = 200.00 MiB',
  'load_tensors:       WebGPU model buffer size = -3.00 MiB',
  'load_tensors:       WebGPU model buffer size = 1000001.00 MiB',
  'load_tensors:       WebGPU model buffer size = 0.00 MiB secret',
  'load_tensors:       WebGPU model buffer size = NaN MiB',
  'ggml_webgpu: adapter_info: vendor_id: ? | vendor: nvidia | architecture: blackwell | device_id: 11266 | name: device | device_desc: GPU',
]) d.logger.debug(msg);
assert.deepEqual(d.getDiagnostics(),{webgpuInitialized:null,modelBuffers:[]});
for(let i=0;i<20;i++) d.logger.debug('load_tensors:       WebGPU model buffer size = 1.00 MiB');
assert.equal(d.getDiagnostics().modelBuffers.length,16);
console.log('PASS bounded native backend/buffer signals and immutable snapshots');
