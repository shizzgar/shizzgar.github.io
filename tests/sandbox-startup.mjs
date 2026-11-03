import assert from 'node:assert/strict';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {makeSandboxDocument, validateScene, releaseScene} from '../sandbox-runner.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const CDN = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/0.160.0/three.module.min.js';
const LOCAL = new URL('../vendor/three-r160.module.min.js', import.meta.url).href;
const original = `<html><script type="module">import * as THREE from "${CDN}"; const extra = import('${CDN}');</script></html>`;
const runtime = makeSandboxDocument(original, 'runtime');
assert.ok(runtime.includes(`from "${LOCAL}"`));
assert.ok(runtime.includes(`import('${LOCAL}')`));
assert.ok(original.includes(`from "${CDN}"`), 'the generated/exported string is untouched');
assert.doesNotMatch(runtime, /navigate-to/, 'unsupported CSP directive is removed');

function bridgeEnvironment() {
  let time = 0, nextTimer = 1;
  const timers = new Map(), hooks = new Map(), messages = [], canvases = [];
  const sandboxWindow = {};
  const parent = {postMessage(data) { messages.push(data); }};
  const document = {readyState:'loading', querySelectorAll(selector) { assert.equal(selector,'canvas'); return canvases; }};
  let lost = false;
  const gl = {
    drawArrays() {}, drawElements() {}, isContextLost() { return lost; },
    getExtension(name) { return name === 'WEBGL_lose_context' ? {loseContext() {lost = true;}} : null; },
  };
  class Canvas {
    width = 800; height = 600; isConnected = true;
    getBoundingClientRect() { return {width:800,height:600}; }
    getContext() { return gl; }
    addEventListener() {}
  }
  const setTimeout = (callback, delay = 0) => { const id = nextTimer++; timers.set(id,{callback,at:time + delay}); return id; };
  const clearTimeout = id => timers.delete(id);
  const sandbox = {parent,window:sandboxWindow,document,HTMLCanvasElement:Canvas,console:{error(){}},performance:{now:()=>time},setTimeout,clearTimeout,
    addEventListener(type,callback) { if (!hooks.has(type)) hooks.set(type,[]); hooks.get(type).push(callback); },
  };
  vm.runInNewContext(makeSandboxDocument('<html></html>','bridge',250).match(/<script>([\s\S]*?)<\/script>/)[1],sandbox);
  const emit = (type,event = {}) => { for (const callback of hooks.get(type) || []) callback(event); };
  const advance = ms => {
    const end = time + ms; let count = 0;
    while (true) {
      const next = [...timers].filter(([,task])=>task.at <= end).sort((a,b)=>a[1].at - b[1].at)[0];
      if (!next) break;
      assert.ok(++count < 1000, 'polling must remain bounded');
      timers.delete(next[0]); time = next[1].at; next[1].callback();
    }
    time = end;
  };
  return {messages,canvases,document,Canvas,gl,parent,sandboxWindow,timers,emit,advance};
}

const pending = bridgeEnvironment();
assert.equal(pending.messages[0].type,'boot');
pending.advance(5000);
assert.ok(pending.messages.some(x=>x.type==='progress'));
assert.ok(!pending.messages.some(x=>x.type==='ready'), 'empty DOM is not a final failure while imports/load are pending');
const canvas = new pending.Canvas(); pending.canvases.push(canvas); canvas.getContext('webgl').drawArrays();
pending.advance(500);
const drawn = pending.messages.find(x=>x.type==='ready');
assert.ok(drawn, 'real observed draws can finish startup without waiting for load');
assert.equal(drawn.payload.webglContexts,1);
assert.equal(drawn.payload.loadPending,true);
assert.equal(pending.timers.size,0, 'success stops polling');
pending.emit('error',{target:pending.sandboxWindow,message:'late real failure',error:{stack:'late real failure stack'},filename:'about:srcdoc',lineno:200,colno:10});
assert.ok(pending.messages.some(x=>x.type==='error' && x.payload.message.includes('late real failure')), 'later exceptions remain observed');

const load = bridgeEnvironment();
load.advance(0); load.document.readyState = 'interactive'; load.emit('DOMContentLoaded');
load.advance(250); assert.equal(load.messages.at(-1).payload.phase,'dom-ready');
load.document.readyState = 'complete'; load.emit('load'); load.advance(250);
assert.ok(load.messages.some(x=>x.type==='ready'), 'settled load still reports a definitive empty scene');

const moduleFailure = bridgeEnvironment();
moduleFailure.emit('error',{target:{tagName:'SCRIPT',type:'module',src:'',textContent:`import * as THREE from "${LOCAL}";`}});
const moduleError = moduleFailure.messages.find(x=>x.type==='error').payload;
assert.equal(moduleError.kind,'module-load');
assert.equal(moduleError.source,LOCAL);
assert.match(moduleError.message,/модульный скрипт/);
assert.notEqual(moduleError.message,'Ошибка выполнения');
moduleFailure.emit('error',{target:{tagName:'SCRIPT',type:'module',src:'',textContent:'import "unknown";'}});
assert.equal(moduleFailure.messages.filter(x=>x.type==='error').at(-1).payload.kind,'module-load', 'unknown inline-module failures are not misrepresented as code exceptions');
moduleFailure.emit('error',{target:moduleFailure.sandboxWindow,message:'SyntaxError: broken scene',error:{stack:'SyntaxError stack'},filename:'about:srcdoc',lineno:220,colno:4});
assert.equal(moduleFailure.messages.filter(x=>x.type==='error').at(-1).payload.kind,'script', 'actual script exceptions remain repairable diagnostics');
moduleFailure.emit('message',{source:moduleFailure.parent,data:{channel:'forma-runner-v1',nonce:'bridge',type:'release'}});
assert.equal(moduleFailure.timers.size,0, 'release cancels startup timers');

const policyFailure = bridgeEnvironment();
policyFailure.emit('securitypolicyviolation',{effectiveDirective:'connect-src',blockedURI:'https://example.invalid/image'});
policyFailure.emit('securitypolicyviolation',{effectiveDirective:'script-src-elem',blockedURI:'https://example.invalid/report-only.js',disposition:'report'});
assert.ok(!policyFailure.messages.some(x=>x.type==='error'), 'only enforced script violations are code failures');
policyFailure.emit('securitypolicyviolation',{effectiveDirective:'script-src-elem',blockedURI:'https://example.invalid/disallowed.js',disposition:'enforce',lineNumber:30,columnNumber:5});
const policyError = policyFailure.messages.find(x=>x.type==='error').payload;
assert.equal(policyError.kind,'policy');
assert.equal(policyError.source,'https://example.invalid/disallowed.js');
assert.match(policyError.message,/Three\.js core/);
assert.match(policyError.message,/не используй другие импорты/);
policyFailure.emit('error',{target:{tagName:'SCRIPT',type:'module',src:'',textContent:'import "https://example.invalid/disallowed.js";'}});
assert.equal(policyFailure.messages.filter(x=>x.type==='error').at(-1).payload.kind,'module-load');
policyFailure.emit('securitypolicyviolation',{effectiveDirective:'script-src',blockedURI:'eval',disposition:'enforce'});
assert.equal(policyFailure.messages.filter(x=>x.type==='error').at(-1).payload.kind,'policy', 'eval violations are repairable too');
policyFailure.emit('pagehide');
assert.equal(policyFailure.timers.size,0);

const bounded = bridgeEnvironment(); bounded.advance(100000);
assert.equal(bounded.messages.filter(x=>x.type==='progress').length,240);
assert.equal(bounded.timers.size,0);
const hidden = bridgeEnvironment(); hidden.emit('pagehide'); assert.equal(hidden.timers.size,0);

const listeners = new Set();
globalThis.window = {addEventListener(type,fn){if(type==='message')listeners.add(fn);},removeEventListener(type,fn){if(type==='message')listeners.delete(fn);}};
const dispatch = (source,data) => { for (const fn of [...listeners]) fn({source,data}); };
function parentFrame(items) {
  let nonce;
  const target = {postMessage(data) { if(data.type==='release')queueMicrotask(()=>dispatch(target,{...data,type:'released',payload:{contexts:0,requested:0,unsupported:0,failed:0}})); }};
  const frame = {isConnected:true,contentWindow:target,setAttribute(){},set srcdoc(value){
    if (!value) return;
    nonce = value.match(/const nonce = "([0-9a-f]+)"/)[1];
    queueMicrotask(()=>{for (const item of items) dispatch(target,{channel:'forma-runner-v1',nonce,...item});});
  }};
  return {frame,send:(type,payload)=>dispatch(target,{channel:'forma-runner-v1',nonce,type,payload})};
}
const evidence = {canvasCount:1,visibleCanvasCount:1,webglContexts:1,drawCalls:5,drawObservationAvailable:true};
const progress = {type:'progress',payload:{...evidence,phase:'dom-ready',documentReadyState:'interactive',loadPending:true}};
async function timeoutResult(items) {
  const {frame} = parentFrame(items);
  return validateScene({iframe:frame,html:'<html></html>',timeoutMs:1000});
}
const [exceptionTimeout,contextTimeout,moduleTimeout,emptyTimeout,policyTimeout] = await Promise.all([
  timeoutResult([progress,{type:'error',payload:{kind:'script',source:'about:srcdoc',message:'Actual startup exception'}}]),
  timeoutResult([progress,{type:'error',payload:{kind:'webgl-context-lost',message:'Потерян контекст WebGL'}}]),
  timeoutResult([{type:'error',payload:moduleError}]),
  timeoutResult([{type:'boot',payload:{phase:'boot',documentReadyState:'loading'}}]),
  timeoutResult([{type:'error',payload:policyError},{type:'error',payload:moduleError},{type:'error',payload:{kind:'resource',source:LOCAL,message:'module resource failed'}}]),
]);
assert.equal(exceptionTimeout.ok,false);
assert.ok(exceptionTimeout.errors.includes('Actual startup exception'));
assert.equal(exceptionTimeout.diagnostics[0].rawMessage,'Actual startup exception');
assert.deepEqual(exceptionTimeout.evidence,evidence);
assert.equal(exceptionTimeout.phase,'dom-ready');
assert.equal(exceptionTimeout.documentReadyState,'interactive');
assert.equal(exceptionTimeout.retryable,true);
assert.equal(exceptionTimeout.infrastructureFailure,null);
assert.equal(contextTimeout.contextLost,true);
assert.equal(contextTimeout.retryable,false);
assert.equal(contextTimeout.infrastructureFailure,null);
assert.equal(moduleTimeout.infrastructureFailure,'module-load');
assert.equal(moduleTimeout.retryable,false);
assert.equal(emptyTimeout.infrastructureFailure,'startup-timeout');
assert.equal(emptyTimeout.phase,'boot');
assert.equal(emptyTimeout.evidence,null);
assert.equal(policyTimeout.retryable,true, 'policy violation takes precedence over opaque module/resource failures');
assert.equal(policyTimeout.infrastructureFailure,null);
assert.equal(policyTimeout.infrastructureErrorOther,false);
assert.ok(policyTimeout.diagnostics.some(x=>x.kind==='policy'));

const blocked = parentFrame([{type:'error',payload:policyError},{type:'error',payload:moduleError},{type:'ready',payload:{...evidence,webglContexts:0,drawCalls:0}}]);
const blockedResult = await validateScene({iframe:blocked.frame,html:'<html></html>'});
assert.equal(blockedResult.ok,false);
assert.equal(blockedResult.retryable,true, 'disallowed import is eligible for model code repair');
assert.equal(blockedResult.infrastructureFailure,null);
assert.equal(blockedResult.infrastructureErrorOther,false);
assert.ok(!blockedResult.errors.some(x=>/Активный WebGL/.test(x)), 'policy root cause is not obscured by a secondary missing-context diagnosis');

let late;
const good = parentFrame([{type:'ready',payload:{...evidence,loadPending:true,phase:'dom-ready'}}]);
const goodResult = await validateScene({iframe:good.frame,html:'<html></html>',onRuntimeError:value=>late=value});
assert.equal(goodResult.ok,true);
assert.ok(goodResult.warnings.some(x=>/загрузка документа/.test(x)));
good.send('error',{kind:'script',message:'late exception'});
assert.equal(late.message,'late exception');
await releaseScene(good.frame);
assert.equal(listeners.size,0);
console.log('PASS inline-module diagnostics, bounded startup snapshots, pending-load draws and timeout evidence retention');
