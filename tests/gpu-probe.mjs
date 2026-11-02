import assert from 'node:assert/strict';
import {profileDevice} from '../benchmark.js';
let disposed = 0;
const debug = {UNMASKED_RENDERER_WEBGL:0x9246, UNMASKED_VENDOR_WEBGL:0x9245};
const context = {
  getExtension: name => name === 'WEBGL_debug_renderer_info' ? debug : name === 'WEBGL_lose_context' ? {loseContext(){disposed++}} : null,
  getParameter: name => name === debug.UNMASKED_RENDERER_WEBGL ? 'ANGLE (NVIDIA, NVIDIA RTX)' : 'NVIDIA',
};
const doc = {createElement:name => {assert.equal(name,'canvas');return {getContext:name => name === 'webgl2' ? context : null}}};
const gpu = {requestAdapter:async()=>({info:{description:'Different WebGPU adapter'},limits:{}})};
const result=await profileDevice({nav:{gpu},doc,isolated:false});
assert.equal(result.webglRenderer,'ANGLE (NVIDIA, NVIDIA RTX)');
assert.equal(result.webglVendor,'NVIDIA');
assert.equal(result.adapter,'Different WebGPU adapter');
assert.equal(result.webglAvailable,true);
assert.equal(disposed,1,'temporary context released');
// WebGL identity remains available even when WebGPU is unavailable.
assert.equal((await profileDevice({nav:{},doc,isolated:false})).webglRenderer,'ANGLE (NVIDIA, NVIDIA RTX)');
// Privacy restrictions or disabled debug extension do not invent a GPU name.
const privateContext = {...context,getExtension:name => name === 'WEBGL_lose_context' ? {loseContext(){disposed++}} : null};
const privateDoc={createElement:()=>({getContext:()=>privateContext})};
const hidden=await profileDevice({nav:{},doc:privateDoc,isolated:false});
assert.equal(hidden.webglAvailable,true);assert.equal(hidden.webglDebugAvailable,false);assert.equal(hidden.webglRenderer,null);
// Null or broken contexts degrade gracefully; cleanup still runs after errors.
const brokenDoc={createElement:()=>({getContext:()=>({...context,getParameter(){throw Error('privacy')}})})};
const before=disposed;const broken=await profileDevice({nav:{},doc:brokenDoc,isolated:false});
assert.equal(broken.webglRenderer,null);assert.equal(disposed,before+1);
const unavailable=await profileDevice({nav:{},doc:{createElement(){throw Error('blocked')}},isolated:false});
assert.equal(unavailable.webglAvailable,false);assert.equal(unavailable.webglRenderer,null);
console.log('PASS WebGL probe, separate WebGPU identity, privacy, cleanup and unsupported browsers');
