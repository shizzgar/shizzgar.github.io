import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {runAgent} from '../agent-loop.js';
import {planValidationRecovery} from '../recovery-policy.js';

const source = await readFile('./app.js','utf8');
const helpers = source.slice(source.indexOf('async function waitForVisibleDocument('), source.indexOf('\nasync function discardCandidate('));
const validator = source.slice(source.indexOf('function agentValidator('), source.indexOf('\nfunction queueLateRepair'));
const original = '<html><body><canvas></canvas><script type="module">/* full scene */</script></body></html>';
const repaired = original.replace('full scene','repaired scene');
const evidence = {canvasCount:1,visibleCanvasCount:1,webglContexts:1,drawCalls:0,drawObservationAvailable:true,
  scheduler:{requested:2,callbacks:0,pending:2,documentVisibility:'visible'}};
const noDraw = () => ({ok:false,retryable:true,errors:['WebGL-контекст есть, но вызовы отрисовки не обнаружены; сцена может быть пустой.'],diagnostics:[],evidence});
const success = () => ({ok:true,errors:[],warnings:[],diagnostics:[],evidence:{...evidence,drawCalls:5,scheduler:{requested:4,callbacks:3,pending:1,documentVisibility:'visible'}}});
const infra = () => ({ok:false,retryable:false,errors:['module failed'],infrastructureFailure:'module-load',infrastructureErrorOther:true,diagnostics:[{kind:'module-load',message:'module failed'}]});

function make(outcomes,{hidden=false,abortOnPresentation=false}={}) {
  const frames=[],calls=[],traces=[],retained=[],inputs=[],listeners=new Set();
  let loaded=true;
  const controller=new AbortController(),selected={frame:null},status={};
  const accepted={source:'previous accepted HTML'},draft='keep my draft';
  const stage={appendChild(frame){frame.parentElement=stage;frame.connected=true;frames.push(frame)}};
  const ui={'preview-frame':{parentElement:stage},'preview-status':{},'prompt-input':{value:draft},'download-html':{disabled:true}};
  const document={hidden,visibilityState:hidden?'hidden':'visible',
    addEventListener(type,fn){if(type==='visibilitychange')listeners.add(fn)},
    removeEventListener(type,fn){if(type==='visibilitychange')listeners.delete(fn)},
    createElement(tag){assert.equal(tag,'iframe');return {style:{},attrs:{},setAttribute(k,v){this.attrs[k]=v}}},
  };
  const context=vm.createContext({document,DOMException,planValidationRecovery,ui,activeScene:null,
    translateShell:x=>x,setShellText(node,text){node.textContent=text},
    trace:{toolStart(name,input){traces.push({name,input});return traces.length},toolFinish(id,result){traces.push({id,result})},stage(name,detail){traces.push({name,detail});if(abortOnPresentation&&name==='Восстановление первого кадра')controller.abort()}},
    async pauseModel(){loaded=false;calls.push('pause')},
    setWorkspaceView(view){calls.push(`view:${view}`)},closeModelSettings(){calls.push('close-settings')},
    async discardCandidate(frame){frame.connected=false;calls.push('discard')},
    retainUnverified(html){retained.push(html)},error(){},queueLateRepair(){},
    async validateScene({iframe,html,signal}){
      assert.equal(loaded,false,'model is stopped before validation');
      assert.equal(document.hidden,false,'background documents never start validation');
      assert.equal(signal.aborted,false);assert.equal(iframe.style.opacity,'1');assert.equal(iframe.style.pointerEvents,'none');
      assert.equal(iframe.attrs['aria-hidden'],'true','preview stays unaccepted and noninteractive');
      assert.ok(frames.slice(0,-1).every(x=>!x.connected),'failed contexts are removed before a restart');
      assert.match(ui['preview-status'].textContent,/предварительный результат/);
      calls.push('validate');const result=outcomes.shift();assert.ok(result,'restart count is bounded');return result;
    },
  });
  vm.runInContext(`${helpers}\n${validator}\nthis.makeValidator=agentValidator;`,context);
  const validate=context.makeValidator({status,session:{prompt:'original cabin request'},selected});
  return {frames,calls,traces,retained,inputs,listeners,controller,selected,ui,document,accepted,
    visibility(value){document.hidden=value==='hidden';document.visibilityState=value;for(const fn of [...listeners])fn()},
    run:()=>runAgent({prompt:'original cabin request',generate:async args=>{assert.ok(frames.every(x=>!x.connected),'no scene exists when model resumes');loaded=true;inputs.push(args);return inputs.length===1?original:repaired},validate,signal:controller.signal,maxAttempts:3}),
    check:()=>validate(original,{signal:controller.signal}),
  };
}

// The attached failure has live GL, a valid render loop, pending RAF and no
// exception. Retry presentation without throwing away the generated scene.
{
  const h=make([noDraw(),success()]);const r=await h.run();
  assert.equal(r.ok,true);assert.equal(r.attempts,1);assert.equal(h.inputs.length,1);
  assert.equal(h.frames.length,2);assert.equal(h.calls.filter(x=>x==='pause').length,1);
  assert.equal(h.selected.frame,h.frames[1]);assert.equal(h.frames[0].connected,false);
  assert.equal(h.ui['prompt-input'].value,'keep my draft');assert.equal(h.accepted.source,'previous accepted HTML');
  assert.equal(h.ui['download-html'].disabled,true,'displaying a candidate cannot mark it accepted');
  assert.deepEqual(h.retained,[original]);
}
// Combined resource + presentation recovery still uses the same code and model
// suspension, with only two allowed restarts in either order.
for(const outcomes of [[infra(),noDraw(),success()],[noDraw(),infra(),success()]]){
  const h=make(outcomes);const r=await h.run();assert.equal(r.ok,true);assert.equal(h.inputs.length,1);
  assert.equal(h.frames.length,3);assert.equal(h.calls.filter(x=>x==='pause').length,1);
}
// An exhausted first-frame recovery gives the model a focused diagnosis and
// complete original code. It does not simplify the request or disable thinking.
{
  const h=make([noDraw(),noDraw(),success()]);const r=await h.run();
  assert.equal(r.ok,true);assert.equal(h.inputs.length,2);assert.equal(h.inputs[1].previousCode,original);
  assert.match(h.inputs[1].prompt,/original cabin request/);assert.match(h.inputs[1].prompt,/requestAnimationFrame|первый кадр|первого кадра/);
  assert.doesNotMatch(h.inputs[1].prompt,/simplif|disable thinking/i);
}
// A background tab keeps the source but creates no GPU context or timeout.
{
  const h=make([success()],{hidden:true});const pending=h.check();
  for(let i=0;i<5&&!h.listeners.size;i++)await Promise.resolve();
  assert.equal(h.listeners.size,1);assert.equal(h.frames.length,0);assert.deepEqual(h.calls,['pause']);
  h.visibility('visible');assert.equal((await pending).ok,true);assert.equal(h.listeners.size,0);assert.equal(h.frames.length,1);
}
// Stop also works while waiting for a foreground tab, and keeps accepted source
// and draft available to the caller's usual rollback path.
{
  const h=make([success()],{hidden:true});const pending=h.check();
  for(let i=0;i<5&&!h.listeners.size;i++)await Promise.resolve();
  h.controller.abort();await assert.rejects(pending,e=>e.name==='AbortError');
  assert.equal(h.listeners.size,0);assert.equal(h.frames.length,0);assert.deepEqual(h.retained,[original]);
  assert.equal(h.accepted.source,'previous accepted HTML');assert.equal(h.ui['prompt-input'].value,'keep my draft');
}
{
  const h=make([noDraw()],{abortOnPresentation:true});await assert.rejects(h.run(),e=>e.name==='AbortError');
  assert.equal(h.frames.length,1);assert.equal(h.frames[0].connected,false);assert.equal(h.inputs.length,1);
}
console.log('PASS visible first-frame recovery, shared restart bound, code repair, background wait and cancellation');
