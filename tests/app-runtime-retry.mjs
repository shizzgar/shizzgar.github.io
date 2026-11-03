import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {runAgent} from '../agent-loop.js';
import {planValidationRecovery} from '../recovery-policy.js';

// Execute the production app validator with lifecycle adapters. The agent loop
// is real: a runtime retry must not consume a model repair or overlap its GPU.
const source = await readFile('./app.js', 'utf8');
const validatorSource = source.slice(source.indexOf('function agentValidator('), source.indexOf('\nfunction queueLateRepair'));
assert.ok(validatorSource.startsWith('function agentValidator('));
const original = '<html><body><canvas></canvas><script type="module">/* original */</script></body></html>';
const repaired = original.replace('original', 'repaired');
const evidence = {canvasCount:1, visibleCanvasCount:1, webglContexts:1, drawCalls:4, drawObservationAvailable:true};
const success = () => ({ok:true,errors:[],warnings:[],evidence});
const infra = kind => ({ok:false,errors:[`${kind} failed`],retryable:false,infrastructureFailure:kind,infrastructureErrorOther:true,contextLost:false,evidence:null,phase:'dom-ready',diagnostics:[{kind,message:`${kind} failed`,source:'https://example.test/three.js'}]});
const codeError = () => ({ok:false,errors:['TypeError: bad material'],retryable:true,infrastructureErrorOther:false,contextLost:false,evidence});

function harness(outcomes, {abortOnRetry = false} = {}) {
  const calls = [], frames = [], traces = [], retained = [], generated = [];
  const selected = {frame:null}, session = {}, status = {}, controller = new AbortController();
  let loaded = true;
  const sandbox = vm.createContext({
    DOMException, planValidationRecovery,
    waitForVisibleDocument:async()=>{}, closeModelSettings(){}, setWorkspaceView(){},
    trace:{
      toolStart(name, input) { traces.push({type:'tool-start',name,input}); return traces.length; },
      toolFinish(id, result) { traces.push({type:'tool-finish',id,result}); },
      stage(name, detail) { traces.push({type:'stage',name,detail}); if (abortOnRetry && name === 'Повторная проверка') controller.abort(); },
    },
    createCandidate() { assert.equal(loaded,false,'the model is suspended before creating a scene'); assert.ok(frames.every(frame => !frame.connected),'a failed frame is removed before another is created'); const frame={connected:true}; frames.push(frame);calls.push('create');return frame; },
    async discardCandidate(frame) { frame.connected=false;calls.push('discard'); },
    async pauseModel() { loaded=false;calls.push('pause'); },
    retainUnverified(html) { retained.push(html); },
    async validateScene({iframe,html,signal}) {
      assert.equal(loaded,false,'runtime checks never reload the model');
      assert.equal(signal.aborted,false);
      calls.push('validate');
      const next=outcomes.shift(); assert.ok(next,'no unbounded validation retries');
      assert.equal(html,next.html || (generated.length <= 1 ? original : repaired));
      if (next.runtimeError) throw next.runtimeError;
      return next;
    },
    async probeWebGLRecovery() { calls.push('webgl-probe');return {state:'unavailable'}; },
    activeScene:null,ui:{'preview-frame':null,'preview-status':{}},setShellText(node,text) { node.textContent=text; },error() {},queueLateRepair() {},
  });
  vm.runInContext(`${validatorSource}\nthis.makeValidator = agentValidator;`,sandbox);
  const validate=sandbox.makeValidator({status,session,selected});
  return {
    calls,frames,traces,retained,generated,selected,status,controller,
    run:() => runAgent({prompt:'A forest cabin',signal:controller.signal,maxAttempts:3,validate,generate:async ({previousCode}) => {
      assert.ok(frames.every(frame=>!frame.connected),'all failed scenes are released before model generation');
      loaded=true;calls.push('generate');generated.push(previousCode);return generated.length===1 ? original : repaired;
    }}),
    check:() => validate(original,{signal:controller.signal}),
  };
}

for (const kind of ['module-load','resource','startup-timeout']) {
  const h=harness([infra(kind),success()]);
  const r=await h.run();
  assert.equal(r.ok,true);assert.equal(r.attempts,1);
  assert.equal(h.generated.length,1,'same HTML retry never invokes generation');
  assert.deepEqual(h.calls,['generate','pause','create','validate','discard','create','validate']);
  assert.equal(h.frames[0].connected,false);assert.equal(h.selected.frame,h.frames[1]);
  assert.deepEqual(h.retained,[original]);
  assert.equal(h.traces.filter(x=>x.type==='stage'&&x.name==='Повторная проверка').length,1);
  assert.equal(h.traces.filter(x=>x.type==='tool-start').length,2,'both actual runtime checks are recorded');
  const failure=h.traces.find(x=>x.type==='tool-finish'&&x.result.error).result;
  assert.equal(failure.output.infrastructureFailure,kind);
  assert.equal(failure.output.phase,'dom-ready');assert.equal(failure.output.diagnostics[0].kind,kind,'structured diagnostics are retained alongside the human error');
}

// A repeat infrastructure failure stops the loop with the original candidate.
{
  const h=harness([infra('module-load'),{...infra('resource'),retryable:true}]);
  const r=await h.run();assert.equal(r.ok,false);assert.equal(r.reason,'validation_unavailable');
  assert.equal(r.lastHtml,original);assert.equal(h.generated.length,1);assert.equal(h.frames.length,2);
  assert.ok(h.frames.every(frame=>!frame.connected));assert.equal(h.selected.frame,null);
}

// A real code error discovered after infrastructure recovers still gets repair.
{
  const h=harness([infra('startup-timeout'),codeError(),success()]);
  const r=await h.run();assert.equal(r.ok,true);assert.equal(r.attempts,2);assert.equal(h.generated.length,2);
  assert.equal(h.generated[1],original,'code repair retains the full original document');
  assert.equal(h.calls.filter(x=>x==='pause').length,2,'one model suspension per generated candidate');
}

// Generic failures and WebGL unavailability/loss do not use the network retry.
for (const failed of [
  {ok:false,errors:['generic startup error'],retryable:false},
  {ok:false,errors:['WebGL unavailable'],retryable:false,infrastructureErrorOther:true},
  {...infra('resource'),contextLost:true,infrastructureErrorOther:false},
]) {
  const h=harness([failed]);const r=await h.check();assert.equal(r.ok,false);
  assert.equal(h.frames.length,1,'no same-HTML retry for non-resource WebGL failures');
  assert.equal(h.traces.filter(x=>x.type==='stage'&&x.name==='Повторная проверка').length,0);
}

// Stop between the two attempts does not create a second iframe or run a model.
{
  const h=harness([infra('resource')],{abortOnRetry:true});
  await assert.rejects(h.run(),error=>error.name==='AbortError');
  assert.equal(h.frames.length,1);assert.equal(h.frames[0].connected,false);assert.equal(h.generated.length,1);
  assert.deepEqual(h.retained,[original]);
}

// Thrown runner errors remain actionable and cannot accidentally become retries.
{
  const h=harness([{runtimeError:new Error('runner failed')}]);
  await assert.rejects(h.check(),/runner failed/);assert.equal(h.frames.length,1);assert.equal(h.frames[0].connected,false);
}
console.log('PASS bounded same-HTML infrastructure retry, no model reload, retained HTML, code repair and cancellation');
