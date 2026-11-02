import assert from 'node:assert/strict';
import vm from 'node:vm';
import {probeInferenceWebGPU} from '../webgpu-inference-probe.js';

let next = 0;
const urls = new Map();
const revoked = [];
let terminated = 0;
let workerNav = {};
let mainCalls = 0, workerCalls = 0;
class FakeBlob { constructor(parts) { this.source = parts.join(''); } }
const urlApi = { createObjectURL(blob) { const url = `blob:test-${++next}`; urls.set(url, blob.source); return url; }, revokeObjectURL(url) { revoked.push(url); urls.delete(url); } };
class FakeWorker {
  constructor(url) {
    const self = {navigator:workerNav, postMessage: data => queueMicrotask(() => this.onmessage?.({data}))};
    vm.runInNewContext(urls.get(url), {self});
  }
  terminate(){ terminated++; }
}
const gpu = f16 => ({requestAdapter:async()=>({features:{has:name=>name === 'shader-f16' && f16},requestDevice(){throw Error('must not allocate')}})});
const opts = {WorkerClass:FakeWorker,URLApi:urlApi,BlobClass:FakeBlob,timeoutMs:20};
workerNav = {gpu:gpu(true)};
let r=await probeInferenceWebGPU({...opts,nav:{gpu:gpu(true)}});
assert.deepEqual(r,{main:{state:'available',shaderF16:true},worker:{state:'available',shaderF16:true},classification:'worker_ready'});
assert.equal(terminated,1);assert.equal(revoked.length,1);assert.equal(urls.size,0);
workerNav={gpu:gpu(false)};
r=await probeInferenceWebGPU({...opts,nav:{gpu:gpu(true)}});
assert.equal(r.main.shaderF16,true);assert.equal(r.worker.shaderF16,false);assert.equal(r.classification,'worker_missing_shader_f16');
workerNav={gpu:{requestAdapter:async()=>null}};
r=await probeInferenceWebGPU({...opts,nav:{gpu:gpu(true)}});
assert.equal(r.classification,'worker_no_adapter');assert.equal(r.worker.shaderF16,null);
workerNav={};
r=await probeInferenceWebGPU({...opts,nav:{}});
assert.equal(r.main.state,'api_unavailable');assert.equal(r.classification,'worker_api_unavailable');
workerNav={gpu:{requestAdapter:async()=>{workerCalls++;throw Error('internal secret')}}};
r=await probeInferenceWebGPU({...opts,nav:{gpu:{requestAdapter:async()=>{mainCalls++;throw Error('internal secret')}}}});
assert.equal(r.main.state,'error');assert.equal(r.worker.state,'error');assert.equal(r.classification,'worker_unknown');assert.equal(JSON.stringify(r).includes('secret'),false);assert.equal(mainCalls,1);assert.equal(workerCalls,1);
workerNav={gpu:{requestAdapter:async()=>({features:{has(){throw Error('blocked')}}})}};
r=await probeInferenceWebGPU({...opts,nav:{gpu:gpu(false)}});
assert.equal(r.worker.state,'available');assert.equal(r.worker.shaderF16,null);assert.equal(r.classification,'worker_unknown');
class Stuck { terminate(){terminated++} }
r=await probeInferenceWebGPU({...opts,WorkerClass:Stuck,timeoutMs:5,nav:{gpu:{requestAdapter:()=>new Promise(()=>{})}}});
assert.equal(r.main.state,'timeout');assert.equal(r.worker.state,'timeout');assert.equal(r.classification,'worker_unknown');assert.equal(urls.size,0);
class Blocked {constructor(){throw Error('CSP')} }
r=await probeInferenceWebGPU({...opts,WorkerClass:Blocked,nav:{gpu:gpu(true)}});
assert.equal(r.worker.state,'unsupported');assert.equal(r.classification,'worker_unknown');assert.equal(urls.size,0);
r=await probeInferenceWebGPU({...opts,WorkerClass:null,nav:{gpu:gpu(true)}});
assert.equal(r.worker.state,'unsupported');assert.equal(r.classification,'worker_unknown');
assert.equal(urls.size,0);assert.equal(revoked.length,next);
console.log('PASS main/worker shader-f16 capability, mismatch, privacy, timeout, CSP and cleanup');
