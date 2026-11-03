import assert from 'node:assert/strict';
import {planValidationRecovery, MAX_RUNTIME_RETRIES, MAX_PRESENTATION_RETRIES, MAX_RECOVERY_RESTARTS} from '../recovery-policy.js';

const evidence = {canvasCount:1, visibleCanvasCount:1, webglContexts:1, drawCalls:0, drawObservationAvailable:true};
const noDraw = extra => ({ok:false,errors:['No draw calls'],retryable:true,contextLost:false,infrastructureErrorOther:false,diagnostics:[],evidence:{...evidence,...extra}});
const sourceError = kind => ({...noDraw(),diagnostics:[{kind,message:'Actual source failure'}]});
const runtime = kind => ({ok:false,retryable:false,infrastructureFailure:kind,infrastructureErrorOther:true,diagnostics:[],evidence:null});

assert.equal(MAX_RUNTIME_RETRIES,1);
assert.equal(MAX_PRESENTATION_RETRIES,1);
assert.equal(MAX_RECOVERY_RESTARTS,2);
assert.equal(planValidationRecovery(null).action,'stop');
assert.equal(planValidationRecovery({}).action,'stop');
assert.deepEqual(planValidationRecovery({ok:true}),{action:'accept',reason:'validated'});
for (const kind of ['module-load','resource','startup-timeout']) {
  assert.equal(planValidationRecovery(runtime(kind)).action,'retry-runtime');
  assert.equal(planValidationRecovery(runtime(kind),{runtimeRetries:1}).action,'stop','repeated runtime failure never requests regeneration');
  assert.equal(planValidationRecovery(runtime(kind),{presentationRetries:1,restarts:1}).action,'retry-runtime','one different recovery remains available');
  assert.equal(planValidationRecovery(runtime(kind),{restarts:2}).action,'stop','shared budget bounds all infrastructure restarts');
}

// The actual exported failure: a live context but no draw calls and no source
// diagnostic must get one presentation recovery before spending a model turn.
assert.equal(planValidationRecovery(noDraw()).action,'retry-presentation');
assert.equal(planValidationRecovery(noDraw(),{presentationRetries:1}).action,'repair-code');
assert.match(planValidationRecovery(noDraw(),{presentationRetries:1}).diagnosis,/renderer\.render\(scene, camera\)/);
assert.doesNotMatch(planValidationRecovery(noDraw(),{presentationRetries:1}).diagnosis,/VRAM|памят|упрост|simplif|compact/i);
assert.equal(planValidationRecovery(noDraw(),{runtimeRetries:1,restarts:1}).action,'retry-presentation');
assert.equal(planValidationRecovery(noDraw(),{restarts:2}).action,'repair-code','exhausted presentation recovery does not abandon a repairable scene');
assert.equal(planValidationRecovery(noDraw(),{runtimeRetries:1,presentationRetries:1,restarts:0}).action,'repair-code','a stale aggregate cannot reopen consumed budgets');

// Scheduler telemetry changes the diagnosis rather than inventing a driver or
// memory cause. A hidden document must never trigger source-code regeneration.
const starved = noDraw({scheduler:{requested:1,callbacks:0,pending:1,lastCallbackAtMs:null,documentVisibility:'visible'}});
assert.equal(planValidationRecovery(starved).reason,'animation-frame-starved');
assert.match(planValidationRecovery(starved,{presentationRetries:1}).diagnosis,/requestAnimationFrame/);
const delivered = noDraw({scheduler:{requested:8,callbacks:7,pending:1,lastCallbackAtMs:2000,documentVisibility:'visible'}});
assert.equal(planValidationRecovery(delivered).action,'retry-presentation');
assert.match(planValidationRecovery(delivered,{presentationRetries:1}).diagnosis,/Callback анимации выполнялся/);
const hidden = noDraw({scheduler:{requested:1,callbacks:0,pending:1,lastCallbackAtMs:null,documentVisibility:'hidden'}});
assert.equal(planValidationRecovery(hidden).action,'retry-presentation');
assert.equal(planValidationRecovery(hidden,{presentationRetries:1}).action,'stop');
assert.equal(planValidationRecovery(hidden,{presentationRetries:1}).reason,'document-hidden');
assert.doesNotMatch(planValidationRecovery(hidden,{presentationRetries:1}).diagnosis,/исправь|renderer\.render/);
const malformedTelemetry = noDraw({scheduler:{requested:'1',callbacks:0,pending:1,documentVisibility:'hidden'}});
assert.equal(planValidationRecovery(malformedTelemetry,{presentationRetries:1}).action,'repair-code','malformed telemetry cannot claim a hidden browser');

for (const kind of ['script','promise','console','policy','webgl-error']) {
  assert.equal(planValidationRecovery(sourceError(kind)).action,'repair-code',`${kind} is a real error, not a reason for a presentation retry`);
}
assert.equal(planValidationRecovery({...runtime('module-load'),diagnostics:[{kind:'policy'}]}).action,'repair-code','a forbidden import is source code to fix');
assert.equal(planValidationRecovery({...runtime('startup-timeout'),diagnostics:[{kind:'script'}]}).action,'repair-code','deadline preserves a concrete source exception');
assert.equal(planValidationRecovery({...noDraw(),contextLost:true}).reason,'webgl-context-lost');
assert.equal(planValidationRecovery({...noDraw(),infrastructureErrorOther:true}).action,'stop','WebGL availability has its existing explicit recovery path');
assert.equal(planValidationRecovery({...noDraw({drawObservationAvailable:false}),retryable:false}).action,'stop','unobserved calls are not evidence of a missing frame');
assert.equal(planValidationRecovery(noDraw({drawObservationAvailable:false})).action,'repair-code','unconfirmed rendering does not get an evidence-free runtime replay');
assert.equal(planValidationRecovery(noDraw({webglContexts:0})).action,'repair-code');
assert.equal(planValidationRecovery(noDraw({visibleCanvasCount:0})).action,'repair-code');
assert.equal(planValidationRecovery({ok:false,retryable:false}).action,'stop');

// Policy is read-only and deterministic: callers retain all actual evidence.
const before = structuredClone(starved);
const state = Object.freeze({runtimeRetries:0,presentationRetries:0,restarts:0});
assert.deepEqual(planValidationRecovery(starved,state),planValidationRecovery(starved,state));
assert.deepEqual(starved,before);
console.log('PASS bounded runtime/presentation recovery matrix, scheduler diagnosis and source-error precedence');
