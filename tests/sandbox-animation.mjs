import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
import {makeSandboxDocument} from '../sandbox-runner.js';

function clock() {
  let time=0,id=0; const timers=new Map();
  return {timers,now:()=>time,setTimeout(fn,ms=0){const n=++id;timers.set(n,{fn,at:time+ms});return n;},clearTimeout(n){timers.delete(n);},advance(ms){const end=time+ms;let count=0;while(true){const next=[...timers].filter(([,x])=>x.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;assert.ok(++count<1000);timers.delete(next[0]);time=next[1].at;next[1].fn();}time=end;}};
}
function bridgeFixture() {
  const c=clock(),hooks=new Map(),messages=[],rafs=new Map();let nextRaf=0;
  const document={visibilityState:'visible',readyState:'loading',querySelectorAll:()=>[canvas]};
  const gl={drawArrays(){},drawElements(){},isContextLost:()=>false,getExtension:()=>({loseContext(){}})};
  class Canvas{width=800;height=600;isConnected=true;getContext(){return gl;}getBoundingClientRect(){return{width:800,height:600}}addEventListener(){}}
  const canvas=new Canvas();
  const parent={postMessage:x=>messages.push(x)};
  const sandbox={parent,document,HTMLCanvasElement:Canvas,console:{error(){}},performance:{now:c.now},setTimeout:c.setTimeout,clearTimeout:c.clearTimeout,
    requestAnimationFrame(fn){const id=++nextRaf;rafs.set(id,fn);return id;},cancelAnimationFrame(id){rafs.delete(id);},
    addEventListener(type,fn){if(!hooks.has(type))hooks.set(type,[]);hooks.get(type).push(fn);},
  };sandbox.window=sandbox;
  const emit=(type,event={})=>{for(const fn of hooks.get(type)||[])fn(event)};
  vm.runInNewContext(makeSandboxDocument('<html></html>','raf',250).match(/<script>([\s\S]*?)<\/script>/)[1],sandbox);
  return {c,document,gl,canvas,sandbox,parent,messages,rafs,emit,tick(){const callbacks=[...rafs.values()];rafs.clear();for(const fn of callbacks)fn(c.now());}};
}

const f=bridgeFixture();
const gl=f.canvas.getContext('webgl');
f.sandbox.requestAnimationFrame(()=>gl.drawArrays());
const cancelled=f.sandbox.requestAnimationFrame(()=>assert.fail('cancelled frame ran'));
f.sandbox.cancelAnimationFrame(cancelled);
f.document.readyState='complete';f.emit('load');f.c.advance(5000);
assert.ok(!f.messages.some(x=>x.type==='ready'),'load alone cannot reject a live context before its first scheduled frame');
let telemetry=f.messages.at(-1).payload.scheduler;
assert.equal(telemetry.requested,2);assert.equal(telemetry.callbacks,0);assert.equal(telemetry.pending,1);
f.tick();f.c.advance(500);
const ready=f.messages.find(x=>x.type==='ready');assert.ok(ready);
assert.equal(ready.payload.drawCalls,1);assert.equal(ready.payload.scheduler.callbacks,1);assert.equal(ready.payload.scheduler.pending,0);
assert.equal(f.c.timers.size,0);
f.sandbox.requestAnimationFrame(()=>assert.fail('released frame ran'));
f.emit('message',{source:f.parent,data:{channel:'forma-runner-v1',nonce:'raf',type:'release'}});
assert.equal(f.rafs.size,0,'scene release cancels pending native animation callbacks');

const hidden=bridgeFixture();hidden.document.visibilityState='hidden';hidden.canvas.getContext('webgl');
hidden.sandbox.requestAnimationFrame(()=>hidden.gl.drawArrays());hidden.emit('load');hidden.c.advance(60000);
assert.ok(!hidden.messages.some(x=>x.type==='ready'));assert.equal(hidden.c.timers.size,0,'background startup sleeps until visibility changes');
hidden.document.visibilityState='visible';hidden.emit('visibilitychange');hidden.tick();hidden.c.advance(500);
assert.ok(hidden.messages.some(x=>x.type==='ready'),'foreground event resumes real frame observation');

const invalidDraw=bridgeFixture();let samples=0;
invalidDraw.gl.getError=()=>++samples===1 ? 1282 : 0;
invalidDraw.canvas.getContext('webgl').drawArrays();invalidDraw.emit('load');invalidDraw.c.advance(500);
const failedDraw=invalidDraw.messages.find(x=>x.type==='ready');
assert.ok(failedDraw.payload.errors.some(x=>x.kind==='webgl-error' && /INVALID_OPERATION \(1282\)/.test(x.message)), 'native WebGL error state is not mistaken for a successful render');
assert.equal(samples,2,'error sampling is bounded and happens at the final observation');

// Use the production parent runner with a deterministic active-time deadline.
const c=clock(),windowListeners=new Set(),visibilityListeners=new Set();
const document={visibilityState:'visible',addEventListener(t,fn){if(t==='visibilitychange')visibilityListeners.add(fn)},removeEventListener(t,fn){if(t==='visibilitychange')visibilityListeners.delete(fn)}};
const sandbox=vm.createContext({URL,Map,Set,WeakMap,Uint8Array,crypto:webcrypto,DOMException,performance:{now:c.now},setTimeout:c.setTimeout,clearTimeout:c.clearTimeout,document,window:{addEventListener(t,fn){if(t==='message')windowListeners.add(fn)},removeEventListener(t,fn){if(t==='message')windowListeners.delete(fn)}}});
const mod=new vm.SourceTextModule(await readFile('sandbox-runner.js','utf8'),{context:sandbox,initializeImportMeta(meta){meta.url=new URL('../sandbox-runner.js',import.meta.url).href;}});await mod.link(()=>assert.fail('unexpected dependency'));await mod.evaluate();
const send=(source,data)=>{for(const fn of [...windowListeners])fn({source,data})};
function frame(){let nonce;const target={postMessage(data){if(data.type==='release')queueMicrotask(()=>send(target,{...data,type:'released',payload:{contexts:1,requested:1,failed:0,unsupported:0}}));}};return {isConnected:true,contentWindow:target,setAttribute(){},set srcdoc(s){if(!s)return;nonce=s.match(/const nonce = "([a-f0-9]+)"/)[1];send(target,{channel:'forma-runner-v1',nonce,type:'progress',payload:{canvasCount:1,visibleCanvasCount:1,webglContexts:1,drawCalls:0,drawObservationAvailable:true,phase:'loaded',scheduler:{requested:1,callbacks:0,pending:1,lastCallbackAtMs:null,documentVisibility:'visible'}}});}};}
let settled=false;
const pending=mod.namespace.validateScene({iframe:frame(),html:'<html></html>',timeoutMs:1000}).then(r=>{settled=true;return r});
c.advance(400);document.visibilityState='hidden';for(const fn of visibilityListeners)fn();c.advance(60000);await Promise.resolve();assert.equal(settled,false,'background time does not consume startup allowance');
document.visibilityState='visible';for(const fn of visibilityListeners)fn();c.advance(599);await Promise.resolve();assert.equal(settled,false);c.advance(1);
const r=await pending;
assert.equal(r.infrastructureFailure,null,'a live context awaiting its first frame is not a library timeout');assert.equal(r.retryable,true);assert.equal(r.evidence.scheduler.pending,1);assert.match(r.errors.join('\n'),/вызовы отрисовки/);assert.equal(r.activeValidationMs,1000);assert.equal(r.wallValidationMs,61000);
assert.equal(windowListeners.size,0);assert.equal(visibilityListeners.size,0);
document.visibilityState='hidden';const controller=new AbortController();const stopped=mod.namespace.validateScene({iframe:frame(),html:'<html></html>',signal:controller.signal});controller.abort();await assert.rejects(stopped,e=>e.name==='AbortError');assert.equal(windowListeners.size,0);assert.equal(visibilityListeners.size,0);assert.equal(c.timers.size,0);
console.log('PASS delayed native frames, scheduler evidence, visibility-aware deadlines and cancellation cleanup');
