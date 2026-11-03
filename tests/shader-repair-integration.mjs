import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {validateScene, releaseScene} from '../sandbox-runner.js';
import {runAgent} from '../agent-loop.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const listeners = new Set();
globalThis.window = {
  addEventListener(type, fn) { if (type === 'message') listeners.add(fn); },
  removeEventListener(type, fn) { if (type === 'message') listeners.delete(fn); },
};
const dispatch = (source, data) => { for (const fn of [...listeners]) fn({source, data}); };
const CDN = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/0.160.0/three.module.min.js';
const shaderError = 'THREE.WebGLProgram: Shader Error 0 - VALIDATE_STATUS false\nProgram Info Log: FRAGMENT varying vFogDepth does not match any VERTEX varying';
const runtimeError = "Uncaught TypeError: Cannot read properties of undefined (reading 'value')\n    at Object.refreshFogUniforms (" + CDN + ':6:421981)';
const brokenHtml = '<html><body><script type="module">/* generated ocean shader */</script></body></html>';
const repairedHtml = '<html><body><script type="module">/* fixed fog */</script></body></html>';
const events = [];

// Frames exercise the real sandbox message handling and cleanup. A successful
// release simulates the bridge acknowledgement; an intentional loss does not
// create an error event. This does not emulate a browser or GPU.
function frameFor(errors = []) {
  let nonce;
  const target = {postMessage(data) {
    events.push('release');
    queueMicrotask(() => dispatch(target, {...data, type:'released', payload:{contexts:1,requested:1,unsupported:0,failed:0}}));
  }};
  return {isConnected:true, contentWindow:target, setAttribute() {}, set srcdoc(value) {
    if (!value) {events.push('clear'); return;}
    nonce = value.match(/const nonce = "([0-9a-f]+)"/)?.[1];
    assert.ok(nonce);
    queueMicrotask(() => {
      for (const payload of errors) dispatch(target, {channel:'forma-runner-v1',nonce,type:'error',payload});
      dispatch(target, {channel:'forma-runner-v1',nonce,type:'ready',payload:{canvasCount:1,visibleCanvasCount:1,webglContexts:1,drawCalls:1,drawObservationAvailable:true}});
    });
  }};
}

async function scenario(firstErrors, expectedCalls) {
  const inputs = [], trace = []; let n = 0;
  const result = await runAgent({
    prompt:'Создай маяк с морем',
    generate:async input => { events.push('generate'); inputs.push(input); return inputs.length === 1 ? brokenHtml : repairedHtml; },
    validate:async (html,{signal}) => {
      const frame = frameFor(n++ === 0 ? firstErrors : []);
      const validation = await validateScene({iframe:frame, html, signal});
      if (validation.ok) await releaseScene(frame,{timeoutMs:100});
      return validation;
    },
    onEvent:event => trace.push(event),
  });
  assert.equal(inputs.length, expectedCalls);
  assert.equal(listeners.size, 0, 'all message listeners are cleaned up');
  return {result,inputs,trace};
}

const runtime = await scenario([
  {kind:'console', message:shaderError},
  {kind:'script', message:runtimeError, source:CDN},
], 2);
assert.equal(runtime.result.ok, true);
assert.equal(runtime.inputs[1].previousCode, brokenHtml, 'repair receives the original generated HTML');
assert.match(runtime.inputs[1].prompt, /Создай маяк с морем/);
assert.match(runtime.inputs[1].prompt, /vFogDepth/);
assert.match(runtime.inputs[1].prompt, /refreshFogUniforms/);
assert.equal(runtime.inputs[1].thinking, undefined, 'the user reasoning setting is not overridden');
assert(runtime.trace.some(x=>x.type==='repairing'));
assert(events.indexOf('release') < events.lastIndexOf('generate'), 'candidate is released before repair');

const gpuLost = await scenario([
  {kind:'console', message:shaderError},
  {kind:'script', message:runtimeError, source:CDN},
  {kind:'webgl-context-lost', message:'Потерян контекст WebGL'},
], 2);
assert.equal(gpuLost.result.ok, true, 'one bounded repair is allowed after a real loss without a separate resource error');
assert.match(gpuLost.inputs[1].prompt, /vFogDepth/);
assert.match(gpuLost.inputs[1].prompt, /Потерян контекст WebGL/);

const unavailable = await scenario([
  {kind:'resource', message:'Не удалось загрузить Three.js', source:CDN},
], 1);
assert.equal(unavailable.result.ok, false);
assert.equal(unavailable.result.reason, 'validation_unavailable');
assert.equal(unavailable.result.lastHtml, brokenHtml);
assert(!unavailable.trace.some(x=>x.type==='repairing'), 'a missing CDN must not be misrepresented as repairable scene code');

console.log('PASS shader/runtime errors reach model repair; missing library stops without repair');
