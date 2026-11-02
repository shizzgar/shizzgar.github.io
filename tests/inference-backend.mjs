import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source = await readFile(new URL('../inference.js', import.meta.url),'utf8');
const loggerSource = await readFile(new URL('../gpu-engine-log.js', import.meta.url),'utf8');
const events=[]; const instances=[];
let failNext=false;
let failExit=false;
let rejectImageModality=false;
let failureQueue=[];
let loadGate=null, onLoad=null;
let lastCompletion;
const navigator={hardwareConcurrency:4};
const context=vm.createContext({navigator,isSecureContext:true,crossOriginIsolated:false,console,Blob,URL,ArrayBuffer,Uint8Array,DOMException,AbortController,Promise,Math,setTimeout,clearTimeout});
async function synth(exports) {const m=new vm.SyntheticModule(Object.keys(exports),function(){for(const [k,v] of Object.entries(exports))this.setExport(k,v)},{context});await m.link(()=>{});await m.evaluate();return m;}
class Wllama {
  constructor(){instances.push(this);events.push('make');}
  setCompat(){}
  async loadModel(files,options){events.push('load');this.options={...options};this.files=files;if(onLoad)onLoad();if(loadGate)await loadGate;if(failNext){failNext=false;throw Error('initialization failed')}if(failureQueue.length){const next=failureQueue.shift();if(next)throw next}}
  async exit(){events.push('exit');if(failExit){failExit=false;throw Error('worker exit failed')}}
  supportInputModality(){return !rejectImageModality&&this.files.length>1}
  getLoadedContextInfo(){return {n_ctx:this.options.n_ctx,n_ctx_train:32768,n_batch:2048,n_ubatch:512}}
  getNumThreads(){return 1}
  async createChatCompletion(options){lastCompletion=options;return (async function*(){yield {choices:[{delta:{content:'ok'},finish_reason:'stop'}]};yield {choices:[],usage:{prompt_tokens:20,completion_tokens:2,total_tokens:22}}})()}
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
await api.loadLocalModel(shard,null);await api.setLocalProjector(projector);failureQueue=[Error('unsupported architecture')];
await assert.rejects(api.ensureVision(),/unsupported architecture/i);
assert.equal(api.getModelState().loaded,false);assert.equal(api.getModelState().backend,null);
assert.equal(api.getModelState().suspended,true,'text files remain recoverable after vision load fails');
assert.equal(api.getModelState().vision,false,'failed vision load does not claim projector is active');
await api.resumeModel();assert.equal(api.getModelState().loaded,true);
assert.equal(instances.at(-1).files[0],shard[0],'restore uses original text shards');
assert.equal(instances.at(-1).files.length,1,'restore does not use failed projector configuration');
await api.ensureVision();assert.equal(api.getModelState().vision,true,'selected local projector survives failed vision attempt');
await api.unloadModel();
// A rejected text worker shutdown must remain available for a retry before a
// new worker starts, just as in explicit suspension.
await api.loadLocalModel(shard,null);await api.setLocalProjector(projector);failExit=true;
await assert.rejects(api.ensureVision(),/worker exit failed/);
assert.equal(api.getModelState().suspended,true);assert.equal(api.getModelState().loaded,false);
assert.equal(api.getModelState().retiring,true);
const exitsBeforeVisionRecovery=events.filter(x=>x==='exit').length;
await api.resumeModel();assert.equal(events.filter(x=>x==='exit').length,exitsBeforeVisionRecovery+1);
assert.equal(api.getModelState().retiring,false);
assert.equal(instances.at(-1).files[0],shard[0]);assert.equal(api.getModelState().vision,false);
await api.ensureVision();assert.equal(api.getModelState().vision,true);await api.unloadModel();
await api.loadLocalModel(shard,null);const baseline=api.getLoadedContextInfo();failNext=true;
await assert.rejects(api.prepareBenchmark({n_batch:256,n_ubatch:128}),/initialization/);
assert.equal(api.getModelState().backend,null);
await api.restoreBenchmark(baseline);assert.equal(api.getModelState().backend,'cpu');
assert.equal(instances.at(-1).options.n_gpu_layers,0);await api.unloadModel();
// An adapter can disappear between probing and worker initialization. Retry
// each GPU context before falling back, reusing the same downloaded blobs.
navigator.gpu={requestAdapter:async()=>({})};events.length=0;statuses.length=0;
failureQueue=[...Array.from({length:6},()=>Error('GPU failed')),null];
const before=instances.length;
await api.loadModel({modelUrl:'https://example.test/model.gguf',onStatus:s=>statuses.push(s)});
assert.equal(instances.length,before+7);assert.equal(events.filter(x=>x==='download').length,1);
assert.equal(instances.at(-2).options.n_gpu_layers,99999);assert.equal(instances.at(-1).options.n_gpu_layers,0);
assert.equal(instances.at(-2).files,instances.at(-1).files);assert.equal(api.getModelState().backend,'cpu');
assert(statuses.some(s=>s.includes('Пробуем CPU')));await api.unloadModel();
// Larger contexts are tried first on GPU, and the actual runtime/train window
// determines generation, including the final usage-only streaming event.
failureQueue=[Error('initialization failed'),null];const first=instances.length;
await api.loadLocalModel(shard,null);
assert.equal(instances[first].options.n_ctx,262144);
assert.equal(instances[first+1].options.n_ctx,131072);
assert.equal(instances[first+1].options.n_gpu_layers,99999);
assert.equal(instances[first+1].options.ctx_shift,false);
assert.equal(api.getLoadedContextInfo().n_ctx,131072);
assert.equal(api.getLoadedContextInfo().n_ctx_train,32768);
assert.equal(api.getLoadedContextInfo().output_token_limit,32768);
const metrics=[];
assert.equal(await api.generate({prompt:'test',thinking:true,onMetrics:m=>metrics.push(m)}),'ok');
assert.equal(lastCompletion.max_tokens,32768);assert.equal(lastCompletion.stream_options.include_usage,true);
assert.equal(lastCompletion.chat_template_kwargs.enable_thinking,true);
assert.equal(metrics.at(-1).maxTokens,32768);assert.equal(metrics.at(-1).usage.completion_tokens,2);
await api.setLocalProjector(projector);await api.ensureVision();
assert.equal(instances.at(-1).options.n_ctx,131072,'vision retains selected context');
await api.unloadModel();
// Context reductions after a vision reload stay on GPU before CPU fallback.
failureQueue=[Error('initialization failed'),null];await api.loadLocalModel(shard,null);
await api.setLocalProjector(projector);const visionStart=instances.length;
failureQueue=[...Array.from({length:5},()=>Error('vision GPU failed')),null];await api.ensureVision();
assert.equal(instances[visionStart].options.n_ctx,131072);
assert.equal(instances[visionStart+4].options.n_ctx,8192);
assert.equal(instances[visionStart+5].options.n_ctx,131072);
assert.equal(instances[visionStart+5].options.n_gpu_layers,0);
await api.unloadModel();
// A clear format error is not disguised as a GPU or memory failure.
failureQueue=[Error('invalid GGUF')];const invalidStart=instances.length;
await assert.rejects(api.loadLocalModel(shard,null),/invalid GGUF/);
assert.equal(instances.length,invalidStart+1);
// If neither backend initializes, show both errors and leave no active engine.
failureQueue=[...Array.from({length:6},()=>Error('GPU failed')),...Array.from({length:6},()=>Error('CPU failed'))];
await assert.rejects(api.loadLocalModel(shard,null),/GPU failed.*CPU failed/);
assert.equal(api.getModelState().backend,null);assert.equal(api.getModelState().loading,false);
// An aborted GPU attempt is not converted into an unsolicited CPU retry.
failureQueue=[new DOMException('cancelled','AbortError')];
const beforeAbort=instances.length;
await assert.rejects(api.loadLocalModel(shard,null),{name:'AbortError'});
assert.equal(instances.length,beforeAbort+1);
// Vision reinitialization can independently fail after the text GPU loaded.
failureQueue=[];await api.loadLocalModel(shard,null);await api.setLocalProjector(projector);
failureQueue=[...Array.from({length:6},()=>Error('vision GPU failed')),null];await api.ensureVision();
assert.equal(api.getModelState().backend,'cpu');assert.equal(api.getModelState().vision,true);
assert.equal(instances.at(-1).options.n_gpu_layers,0);await api.unloadModel();
// Suspension frees the worker, preserves local files/vision/config, and is
// idempotent. A failed or cancelled restoration can be attempted again.
failureQueue=[];navigator.gpu={requestAdapter:async()=>({})};
await api.loadLocalModel(shard,projector);
const retained=instances.at(-1).files, selectedCtx=instances.at(-1).options.n_ctx;
const exitCount=events.filter(x=>x==='exit').length;
await api.suspendModel();await api.suspendModel();
assert.equal(events.filter(x=>x==='exit').length,exitCount+1);
assert.equal(api.getModelState().loaded,false);assert.equal(api.getModelState().suspended,true);
const downloadCount=events.filter(x=>x==='download').length;
failureQueue=[Error('unsupported architecture')];
await assert.rejects(api.resumeModel(),/unsupported architecture/);
assert.equal(api.getModelState().suspended,true);assert.equal(api.getModelState().loaded,false);
await api.resumeModel();
assert.equal(api.getModelState().suspended,false);assert.equal(api.getModelState().vision,true);
assert.equal(instances.at(-1).files[0],retained[0]);assert.equal(instances.at(-1).files[1],retained[1]);
assert.equal(instances.at(-1).options.n_ctx,selectedCtx);assert.equal(events.filter(x=>x==='download').length,downloadCount);
await api.suspendModel();
const cancelled=new AbortController();cancelled.abort();
await assert.rejects(api.resumeModel({signal:cancelled.signal}),{name:'AbortError'});
assert.equal(api.getModelState().suspended,true);
let releaseLoad, loadStarted;
loadGate=new Promise(resolve=>{releaseLoad=resolve});
const entered=new Promise(resolve=>{loadStarted=resolve});onLoad=loadStarted;
const pendingController=new AbortController();
const resumePending=api.resumeModel({signal:pendingController.signal});
await entered;pendingController.abort();releaseLoad();
await assert.rejects(resumePending,{name:'AbortError'});
loadGate=null;onLoad=null;
assert.equal(api.getModelState().suspended,true);assert.equal(api.getModelState().loaded,false);
await api.resumeModel();await api.unloadModel();assert.equal(api.getModelState().suspended,false);
// A local replacement may fail while suspended without destroying the old
// inputs; recovery still restores the original model.
await api.loadLocalModel(shard,null);await api.suspendModel();
failureQueue=[Error('invalid GGUF')];
await assert.rejects(api.loadLocalModel([new Blob(['replacement'])],null),/invalid GGUF/);
assert.equal(api.getModelState().suspended,true);
await api.resumeModel();assert.equal(instances.at(-1).files[0],shard[0]);await api.unloadModel();
// Replacing a live model retains the previous configuration both when the
// old worker cannot exit and when the new projector is not recognized.
await api.loadLocalModel(shard,projector);failExit=true;
const replacement=[new Blob(['replacement'])];
await assert.rejects(api.loadLocalModel(replacement,projector),/worker exit failed/);
assert.equal(api.getModelState().suspended,true);assert.equal(api.getModelState().retiring,true);
await api.resumeModel();assert.equal(api.getModelState().retiring,false);
assert.equal(instances.at(-1).files[0],shard[0]);assert.equal(api.getModelState().vision,true);
rejectImageModality=true;
await assert.rejects(api.loadLocalModel(replacement,projector),/не распознал компонент/);
assert.equal(api.getModelState().suspended,true);assert.equal(api.getModelState().retiring,false);
assert.equal(api.getModelState().vision,true,'the old model retains vision availability');
rejectImageModality=false;await api.resumeModel();
assert.equal(instances.at(-1).files[0],shard[0]);assert.equal(instances.at(-1).files[1],projector);
assert.equal(api.getModelState().vision,true);await api.unloadModel();
// Probe again on resume: GPU may become usable after a CPU-only launch.
navigator.gpu={requestAdapter:async()=>null};await api.loadLocalModel(shard,null);await api.suspendModel();
navigator.gpu={requestAdapter:async()=>({})};await api.resumeModel();
assert.equal(instances.at(-1).options.n_gpu_layers,99999);await api.unloadModel();
// A rejected worker shutdown must not silently start another worker while the
// old one might still hold GPU resources. Resume retries the cleanup first.
await api.loadLocalModel(shard,null);failExit=true;
await assert.rejects(api.suspendModel(),/worker exit failed/);
assert.equal(api.getModelState().suspended,true);
assert.equal(api.getModelState().retiring,true);
await assert.rejects(api.loadLocalModel(shard,null),/остановить предыдущий движок/);
const exitsBeforeRetry=events.filter(x=>x==='exit').length;
await api.resumeModel();assert.equal(events.filter(x=>x==='exit').length,exitsBeforeRetry+1);
assert.equal(api.getModelState().retiring,false);
await api.unloadModel();
// Remote restoration likewise reuses the same downloaded file-backed blob.
await api.loadModel({modelUrl:'https://example.test/model.gguf'});
const remoteFile=instances.at(-1).files[0], downloadsBeforeRestore=events.filter(x=>x==='download').length;
await api.suspendModel();await api.resumeModel();
assert.equal(instances.at(-1).files[0],remoteFile);
assert.equal(events.filter(x=>x==='download').length,downloadsBeforeRestore);
await api.unloadModel();
console.log('PASS adapter availability, secure context, pre-download probe, CPU/GPU mode, vision and worker reinitialization');
