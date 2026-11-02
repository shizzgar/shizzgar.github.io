import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source = await readFile(new URL('../inference.js', import.meta.url),'utf8');
const loggerSource = await readFile(new URL('../gpu-engine-log.js', import.meta.url),'utf8');
const events=[]; const instances=[];
let failNext=false;
let failureQueue=[];
const navigator={hardwareConcurrency:4};
const context=vm.createContext({navigator,isSecureContext:true,crossOriginIsolated:false,console,Blob,URL,ArrayBuffer,Uint8Array,DOMException,AbortController,Promise,Math,setTimeout,clearTimeout});
async function synth(exports) {const m=new vm.SyntheticModule(Object.keys(exports),function(){for(const [k,v] of Object.entries(exports))this.setExport(k,v)},{context});await m.link(()=>{});await m.evaluate();return m;}
class Wllama {
  constructor(){instances.push(this);events.push('make');}
  setCompat(){}
  async loadModel(files,options){events.push('load');this.options={...options};this.files=files;if(failNext){failNext=false;throw Error('initialization failed')}if(failureQueue.length){const next=failureQueue.shift();if(next)throw next}}
  async exit(){events.push('exit')}
  supportInputModality(){return this.files.length>1}
  getLoadedContextInfo(){return {n_ctx:8192,n_batch:2048,n_ubatch:512}}
  getNumThreads(){return 1}
}
const w=await synth({Wllama});
const local=await synth({prepareLocalModel:async(shards,projector)=>{events.push('validate');return {shards,projector,files:projector?[...shards,projector]:shards}},validateProjectorFile:async x=>x});
const download=await synth({downloadFiles:async()=>{events.push('download');return [new Blob(['x'])]},modelShardUrls:()=>['test']});
const logs=new vm.SourceTextModule(loggerSource,{context});
const module=new vm.SourceTextModule(source,{context,importModuleDynamically:async()=>w});
await module.link(spec=>spec==='./local-model.js'?local:spec==='./gpu-engine-log.js'?logs:download);await module.evaluate();
const api=module.namespace;
const shard=[new Blob(['shard'])], projector=new Blob(['projector']);
const statuses=[];
for (const [description,gpu,expected] of [
  ['adapter available',{requestAdapter:async()=>{events.push('probe');return {}}},99999],
  ['adapter is null',{requestAdapter:async()=>{events.push('probe');return null}},0],
  ['adapter throws',{requestAdapter:async()=>{events.push('probe');throw Error('denied')}},0],
  ['API absent',undefined,0],
]) {
  navigator.gpu=gpu; events.length=0; statuses.length=0;
  await api.loadLocalModel(shard,null,{onStatus:s=>statuses.push(s)});
  assert.equal(instances.at(-1).options.n_gpu_layers,expected,description);
  assert.equal(api.getModelState().backend,expected===0?'cpu':'gpu-requested');
  assert.equal(api.getLoadedContextInfo().requested_gpu_layers,expected);
  if(gpu)assert(events.indexOf('probe')<events.indexOf('validate'),'probe occurs before file processing');
  if(expected===0) assert(statuses.some(s=>s.includes('CPU')));
  await api.setLocalProjector(projector);await api.ensureVision();
  assert.equal(instances.at(-1).options.n_gpu_layers,expected,'vision preserves backend');
  assert.equal(api.getModelState().backend,expected===0?'cpu':'gpu-requested');
  const baseline=api.getLoadedContextInfo();
  await api.prepareBenchmark({n_batch:256,n_ubatch:128});
  assert.equal(instances.at(-1).options.n_gpu_layers,expected,'benchmark preserves backend');
  await api.restoreBenchmark(baseline);
  assert.equal(instances.at(-1).options.n_gpu_layers,expected,'restore preserves backend');
  await api.unloadModel();
  assert.equal(api.getModelState().backend,null);
}
navigator.gpu={requestAdapter:async()=>{events.push('probe');return null}};
events.length=0;
await api.loadModel({modelUrl:'https://example.test/model.gguf'});
assert(events.indexOf('probe')<events.indexOf('download'),'probe occurs before remote download');
assert.equal(instances.at(-1).options.n_gpu_layers,0);
await api.unloadModel();
context.isSecureContext=false;
await assert.rejects(api.loadModel({modelUrl:'https://example.test/model.gguf'}),/HTTPS/);
assert.equal(api.getModelState().loading,false);
context.isSecureContext=true;
let release;
navigator.gpu={requestAdapter:()=>new Promise(resolve=>{release=resolve})};
const pending=api.loadLocalModel(shard,null);
await assert.rejects(api.loadLocalModel(shard,null),/занята/);
release(null);await pending;await api.unloadModel();
// A stalled driver probe falls back without claiming the adapter is absent.
let fireTimeout;
context.setTimeout=callback=>{fireTimeout=callback;return 9};context.clearTimeout=()=>{};
navigator.gpu={requestAdapter:()=>new Promise(()=>{})};
const stalled=api.loadLocalModel(shard,null);fireTimeout();await stalled;
assert.equal(api.getModelState().backend,'cpu');await api.unloadModel();
context.setTimeout=setTimeout;context.clearTimeout=clearTimeout;
// Failed vision initialization must not expose a retired backend as running.
navigator.gpu={requestAdapter:async()=>null};
await api.loadLocalModel(shard,null);await api.setLocalProjector(projector);failNext=true;
await assert.rejects(api.ensureVision(),/инициализ|initialization/i);
assert.equal(api.getModelState().loaded,false);assert.equal(api.getModelState().backend,null);
await api.loadLocalModel(shard,null);const baseline=api.getLoadedContextInfo();failNext=true;
await assert.rejects(api.prepareBenchmark({n_batch:256,n_ubatch:128}),/initialization/);
assert.equal(api.getModelState().backend,null);
await api.restoreBenchmark(baseline);assert.equal(api.getModelState().backend,'cpu');
assert.equal(instances.at(-1).options.n_gpu_layers,0);await api.unloadModel();
// An adapter can disappear between probing and worker initialization. Retry
// only initialization, on the same downloaded blobs, once with a new worker.
navigator.gpu={requestAdapter:async()=>({})};events.length=0;statuses.length=0;
failureQueue=[Error('GPU failed'),null];
const before=instances.length;
await api.loadModel({modelUrl:'https://example.test/model.gguf',onStatus:s=>statuses.push(s)});
assert.equal(instances.length,before+2);assert.equal(events.filter(x=>x==='download').length,1);
assert.equal(instances.at(-2).options.n_gpu_layers,99999);assert.equal(instances.at(-1).options.n_gpu_layers,0);
assert.equal(instances.at(-2).files,instances.at(-1).files);assert.equal(api.getModelState().backend,'cpu');
assert(statuses.some(s=>s.includes('Пробуем CPU')));await api.unloadModel();
// If neither backend initializes, show both errors and leave no active engine.
failureQueue=[Error('GPU failed'),Error('CPU failed')];
await assert.rejects(api.loadLocalModel(shard,null),/GPU failed.*CPU failed/);
assert.equal(api.getModelState().backend,null);assert.equal(api.getModelState().loading,false);
// An aborted GPU attempt is not converted into an unsolicited CPU retry.
failureQueue=[new DOMException('cancelled','AbortError')];
const beforeAbort=instances.length;
await assert.rejects(api.loadLocalModel(shard,null),{name:'AbortError'});
assert.equal(instances.length,beforeAbort+1);
// Vision reinitialization can independently fail after the text GPU loaded.
failureQueue=[];await api.loadLocalModel(shard,null);await api.setLocalProjector(projector);
failureQueue=[Error('vision GPU failed'),null];await api.ensureVision();
assert.equal(api.getModelState().backend,'cpu');assert.equal(api.getModelState().vision,true);
assert.equal(instances.at(-1).options.n_gpu_layers,0);await api.unloadModel();
console.log('PASS adapter availability, secure context, pre-download probe, CPU/GPU mode, vision and worker reinitialization');
