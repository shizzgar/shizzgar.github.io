import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const inferenceSource = await readFile(new URL('../inference.js', import.meta.url),'utf8');
const collectorSource = await readFile(new URL('../gpu-engine-log.js', import.meta.url),'utf8');
const instances = [];
let nextFailure = null;
let failuresRemaining = 0;
const navigator = {hardwareConcurrency:4,gpu:{requestAdapter:async()=>({})}};
const context = vm.createContext({navigator,isSecureContext:true,crossOriginIsolated:false,console,Blob,URL,ArrayBuffer,Uint8Array,DOMException,AbortController,Promise,Math,setTimeout,clearTimeout});
async function synth(values) {const m=new vm.SyntheticModule(Object.keys(values),function(){for(const [k,v] of Object.entries(values))this.setExport(k,v)},{context});await m.link(()=>{});await m.evaluate();return m;}
class Wllama {
  constructor(_path, config) {this.logger=config.logger;instances.push(this)}
  setCompat(){}
  async loadModel(files,opts) {this.files=files;this.opts=opts;if(failuresRemaining){failuresRemaining--;throw new Error(nextFailure)}}
  async exit(){}
  supportInputModality(){return this.files.length > 1}
  getLoadedContextInfo(){return {n_ctx:8192}}
  getNumThreads(){return 1}
}
const runtime=await synth({Wllama});
const local=await synth({prepareLocalModel:async(shards,projector)=>({shards,projector,files:projector?[...shards,projector]:shards}),validateProjectorFile:async file=>file});
const download=await synth({downloadFiles:async()=>[new Blob(['x'])],modelShardUrls:()=>['test']});
const logger=new vm.SourceTextModule(collectorSource,{context});
const app=new vm.SourceTextModule(inferenceSource,{context,importModuleDynamically:async()=>runtime});
await app.link(spec=>(spec=spec.split('?')[0],spec==='./local-model.js'?local:spec==='./gpu-engine-log.js'?logger:download));await app.evaluate();
const api=app.namespace, shard=[new Blob(['shard'])], projector=new Blob(['projector']);
await api.loadLocalModel(shard,null);
let info=api.getLoadedContextInfo();
assert.equal(info.model_buffers,undefined);assert.equal(info.webgpu_initialized,undefined);assert.equal(info.backend_fallback_reason,undefined);
const gpu=instances.at(-1);
gpu.logger.debug('load_tensors:       WebGPU model buffer size =  2400.25 MiB');
gpu.logger.debug('load_tensors:          CPU model buffer size =    90.00 MiB');
gpu.logger.debug('load_tensors: offloaded 35/35 layers to GPU');
gpu.logger.debug('ggml_webgpu: adapter_info: vendor_id: 4318 | vendor: nvidia | architecture: blackwell | device_id: 1 | name: GPU | device_desc: RTX');
info=api.getLoadedContextInfo();
assert.equal(info.webgpu_initialized,true);assert.equal(info.gpu_layers_offloaded,35);
assert.equal(info.model_buffers.length,2);assert.equal(info.model_buffers[0].backend,'WebGPU');assert.equal(info.model_buffers[0].mib,2400.25);
assert(!JSON.stringify(info).includes('RTX'));assert(!JSON.stringify(info).includes('vendor'));
info.model_buffers[0].mib=0;assert.equal(api.getLoadedContextInfo().model_buffers[0].mib,2400.25);
// Reinitialization gets a distinct collector; old/late logs are not carried.
await api.setLocalProjector(projector);await api.ensureVision();
assert.notEqual(instances.at(-1),gpu);assert.equal(api.getLoadedContextInfo().model_buffers,undefined);
gpu.logger.debug('load_tensors:       WebGPU model buffer size =  1000.00 MiB');
assert.equal(api.getLoadedContextInfo().model_buffers,undefined);
await api.unloadModel();assert.equal(api.getLoadedContextInfo(),null);
// Adapter unavailable versus failed GPU init are different safe enum reasons.
navigator.gpu={requestAdapter:async()=>null};await api.loadLocalModel(shard,null);
assert.equal(api.getModelState().fallbackReason,'adapter-unavailable');assert.equal(api.getLoadedContextInfo().backend_fallback_reason,'adapter-unavailable');
await api.setLocalProjector(projector);await api.ensureVision();assert.equal(api.getModelState().fallbackReason,'adapter-unavailable');
await api.unloadModel();assert.equal(api.getModelState().fallbackReason,null);
navigator.gpu={requestAdapter:async()=>({})};nextFailure='private error text';failuresRemaining=6;await api.loadLocalModel(shard,null);
assert.equal(api.getModelState().fallbackReason,'gpu-init-failed');assert.equal(api.getLoadedContextInfo().backend_fallback_reason,'gpu-init-failed');
assert(!JSON.stringify(api.getLoadedContextInfo()).includes('private error text'));
await api.unloadModel();
console.log('PASS active engine GPU evidence, isolation, redaction and safe fallback reasons');
