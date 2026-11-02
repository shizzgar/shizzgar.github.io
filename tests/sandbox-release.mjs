import assert from 'node:assert/strict';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {makeSandboxDocument, validateScene, releaseScene, disposeScene} from '../sandbox-runner.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const listeners = new Set();
globalThis.window = {
  addEventListener(type, fn) { if (type === 'message') listeners.add(fn); },
  removeEventListener(type, fn) { if (type === 'message') listeners.delete(fn); },
};
const dispatch = (source, data) => { for (const fn of [...listeners]) fn({source, data}); };

// The actual bridge intercepts contexts; deliberate loss must not report an
// infrastructure failure and must respond only to the parent's valid nonce.
const parent = {messages:[], postMessage(msg) { this.messages.push(msg); }};
const bridgeListeners = new Map();
let losses = 0, lostCallback;
const ext = {loseContext() { losses++; lostCallback(); }};
const gl = {getExtension(name) { return name === 'WEBGL_lose_context' ? ext : null; }, isContextLost() {return false;}};
class Canvas {
  getContext() {return gl;}
  addEventListener(type, callback) {if (type === 'webglcontextlost') lostCallback = callback;}
}
const sandbox = {parent, HTMLCanvasElement:Canvas, console, addEventListener(type, fn) {bridgeListeners.set(type, fn);}, setTimeout};
const html = makeSandboxDocument('<html><body></body></html>', 'abc');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
vm.runInNewContext(script, sandbox);
new Canvas().getContext('webgl');
const message = bridgeListeners.get('message');
message({source:parent, data:{channel:'forma-runner-v1', nonce:'wrong', type:'release'}});
message({source:{}, data:{channel:'forma-runner-v1', nonce:'abc', type:'release'}});
assert.equal(losses, 0);
message({source:parent, data:{channel:'forma-runner-v1', nonce:'abc', type:'release'}});
assert.equal(losses, 1);
assert.equal(parent.messages.length, 1);
assert.equal(parent.messages[0].type, 'released');
assert.equal(parent.messages[0].payload.requested, 1);

function frameFor(mode) {
  let nonce;
  const target = {postMessage(data) {
    if (mode === 'silent') return;
    // A wrong nonce/source cannot settle release; the authentic ack can.
    dispatch(target, {...data, nonce:'wrong', type:'released', payload:{contexts:1,requested:1,unsupported:0,failed:0}});
    dispatch({}, {...data, type:'released', payload:{contexts:1,requested:1,unsupported:0,failed:0}});
    queueMicrotask(() => dispatch(target, {...data, type:'released', payload:{contexts:1,requested:1,unsupported:0,failed:0}}));
  }};
  return {isConnected:true, contentWindow:target, setAttribute() {}, set srcdoc(value) {
    if (!value) return;
    nonce = value.match(/const nonce = "([0-9a-f]+)"/)[1];
    queueMicrotask(() => dispatch(target, {channel:'forma-runner-v1',nonce,type:'ready',payload:{canvasCount:1,visibleCanvasCount:1,webglContexts:1,drawCalls:1,drawObservationAvailable:true}}));
  }};
}

const frame = frameFor('ack');
assert.equal((await validateScene({iframe:frame, html:'<html></html>'})).ok, true);
const released = await releaseScene(frame, {timeoutMs:100});
assert.deepEqual(released, {acknowledged:true,contexts:1,requested:1,unsupported:0,failed:0});
assert.deepEqual(await releaseScene(frame), {acknowledged:false});
assert.equal(listeners.size, 0);

const silent = frameFor('silent');
assert.equal((await validateScene({iframe:silent, html:'<html></html>'})).ok, true);
assert.deepEqual(await releaseScene(silent, {timeoutMs:100}), {acknowledged:false});
assert.equal(listeners.size, 0);
assert.deepEqual(await releaseScene({}), {acknowledged:false});

// A failed validation must request WebGL release before clearing its iframe and
// before returning the failure to the model's repair loop.
const sequence = [];
let failedNonce;
const failedTarget = {postMessage(data) {
  sequence.push('release');
  queueMicrotask(() => {
    sequence.push('ack');
    dispatch(failedTarget, {...data, type:'released', payload:{contexts:1,requested:1,unsupported:0,failed:0}});
  });
}};
const failedFrame = {isConnected:true, contentWindow:failedTarget, setAttribute(){}, set srcdoc(value) {
  if (!value) {sequence.push('clear'); return;}
  failedNonce = value.match(/const nonce = "([0-9a-f]+)"/)[1];
  queueMicrotask(() => {
    dispatch(failedTarget, {channel:'forma-runner-v1',nonce:failedNonce,type:'error',payload:{message:'ошибка сцены',kind:'script'}});
    dispatch(failedTarget, {channel:'forma-runner-v1',nonce:failedNonce,type:'ready',payload:{canvasCount:1,visibleCanvasCount:1,webglContexts:1,drawCalls:1,drawObservationAvailable:true}});
  });
}};
const failure = await validateScene({iframe:failedFrame, html:'<html></html>'});
sequence.push('resolved');
assert.equal(failure.ok, false);
assert.deepEqual(sequence, ['release','ack','clear','resolved']);
assert.equal(listeners.size, 0);

// If a newer validation takes over the same frame before an old ack arrives,
// cleanup of the old request must not erase or dispose the new scene.
let currentNonce, pendingOldAck, clears = 0, count = 0;
const reusedTarget = {postMessage(data) {
  if (!pendingOldAck) pendingOldAck = () => dispatch(reusedTarget, {...data, type:'released', payload:{contexts:1,requested:1,unsupported:0,failed:0}});
  else queueMicrotask(() => dispatch(reusedTarget, {...data, type:'released', payload:{contexts:1,requested:1,unsupported:0,failed:0}}));
}};
const reused = {isConnected:true,contentWindow:reusedTarget,setAttribute(){},set srcdoc(value){
  if (!value) {clears++;return;}
  currentNonce = value.match(/const nonce = "([0-9a-f]+)"/)[1];
  const nonce = currentNonce;
  const first = count++ === 0;
  queueMicrotask(() => {
    if (first) dispatch(reusedTarget, {channel:'forma-runner-v1',nonce,type:'error',payload:{message:'ошибка сцены'}});
    dispatch(reusedTarget, {channel:'forma-runner-v1',nonce,type:'ready',payload:{canvasCount:1,visibleCanvasCount:1,webglContexts:1,drawCalls:1,drawObservationAvailable:true}});
  });
}};
const oldResult = validateScene({iframe:reused,html:'<html></html>'});
await new Promise(resolve => setTimeout(resolve, 0));
assert.ok(pendingOldAck);
assert.equal((await validateScene({iframe:reused,html:'<html></html>'})).ok, true);
// Even if that newer session is disposed, its document remains newer and must
// not be cleared by the delayed old failure's cleanup.
disposeScene(reused);
pendingOldAck();
assert.equal((await oldResult).ok, false);
assert.equal(clears, 0);
assert.equal((await releaseScene(reused, {timeoutMs:100})).acknowledged, false);
assert.equal(listeners.size, 0);

// Abort also releases before rejection, preserving the AbortError contract.
const abortSequence = [];
const abortTarget = {postMessage(data) {
  abortSequence.push('release');
  queueMicrotask(() => {
    abortSequence.push('ack');
    dispatch(abortTarget, {...data,type:'released',payload:{contexts:1,requested:1,unsupported:0,failed:0}});
  });
}};
const abortFrame = {isConnected:true,contentWindow:abortTarget,setAttribute(){},set srcdoc(value){if (!value) abortSequence.push('clear');}};
const controller = new AbortController();
const aborted = validateScene({iframe:abortFrame,html:'<html></html>',signal:controller.signal});
controller.abort();
await assert.rejects(aborted, err => err.name === 'AbortError');
abortSequence.push('rejected');
assert.deepEqual(abortSequence, ['release','ack','clear','rejected']);
assert.equal(listeners.size, 0);

// The delayed abort cleanup from a previous validation must not clear the
// newly navigated iframe and its new validation session.
let oldAbortAck, newAbortNonce, navigations = 0, abortClears = 0;
const abortRaceTarget = {postMessage(data) {
  if (!oldAbortAck) oldAbortAck = () => dispatch(abortRaceTarget,{...data,type:'released',payload:{contexts:1,requested:1,unsupported:0,failed:0}});
  else queueMicrotask(() => dispatch(abortRaceTarget,{...data,type:'released',payload:{contexts:1,requested:1,unsupported:0,failed:0}}));
}};
const abortRaceFrame = {isConnected:true,contentWindow:abortRaceTarget,setAttribute(){},set srcdoc(value){
  if (!value) {abortClears++;return;}
  newAbortNonce = value.match(/const nonce = "([0-9a-f]+)"/)[1];
  if (navigations++ > 0) {const nonce = newAbortNonce; queueMicrotask(() => dispatch(abortRaceTarget,{channel:'forma-runner-v1',nonce,type:'ready',payload:{canvasCount:1,visibleCanvasCount:1,webglContexts:1,drawCalls:1,drawObservationAvailable:true}}));}
}};
const raceController = new AbortController();
const oldAbort = validateScene({iframe:abortRaceFrame,html:'<html></html>',signal:raceController.signal});
raceController.abort();
assert.ok(oldAbortAck);
assert.equal((await validateScene({iframe:abortRaceFrame,html:'<html></html>'})).ok, true);
oldAbortAck();
await assert.rejects(oldAbort, err => err.name === 'AbortError');
assert.equal(abortClears, 0);
assert.equal((await releaseScene(abortRaceFrame,{timeoutMs:100})).acknowledged, true);
assert.equal(listeners.size, 0);
console.log('PASS release request uses nonce, suppresses deliberate context loss, bounds timeout and cleans listeners');
