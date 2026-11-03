import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {runAgent} from '../agent-loop.js';

const source=await readFile('./app.js','utf8');
const section=source.slice(source.indexOf('function normalizeLateIssue('),source.indexOf("\nui['load-model'].addEventListener"));
assert.ok(section.includes('async function runLateRepair'));
const html='<html><body>accepted source</body></html>',repaired='<html><body>repaired source</body></html>';
const ok=()=>({ok:true,warnings:[],diagnostics:[],evidence:{webglContexts:1,drawCalls:3}});
const code=()=>({ok:false,errors:['TypeError: fresh runtime failure'],retryable:true,diagnostics:[{kind:'script',source:'about:srcdoc',message:'TypeError: fresh runtime failure'}]});
const infra=()=>({ok:false,errors:['WebGL unavailable after recovery probe'],retryable:false,contextLost:true,infrastructureErrorOther:true,diagnostics:[{kind:'webgl-context-lost'}]});

function make(outcomes,{abortAtCheck=false,staleAtCheck=false}={}){
  const events=[],calls=[],inputs=[],timers=[],retained=[];let nextFrame=1,restoreCount=0,clears=0;
  const old={id:'initial',connected:true},session={prompt:'original forest request',reference:null,frame:old,pendingError:null,lateRepairStarted:false,scheduled:false};
  const ui={'preview-frame':old,'preview-status':{},'prompt-input':{value:'unrelated draft'},'stop-agent':{hidden:true},'download-html':{disabled:false}};
  let modelLoaded=false;
  const sandbox={DOMException,AbortController,ui,busy:false,activeScene:session,scene:html,agentController:null,
    trace:{begin(){events.push({type:'begin'})},stage(name,detail){events.push({type:'stage',name,detail})},toolStart(name,input){events.push({type:'tool-start',name,input});return events.length},toolFinish(id,result){events.push({type:'tool-finish',id,result})},finish(label,state){events.push({type:'finish',label,state})}},
    appendMessage(){return {}},setShellText(node,text){node.textContent=text},redact:x=>x,error(message){sandbox.errorText=message},setBusy(value){sandbox.busy=value},syncMobileStop(){},
    setTimeout(fn){timers.push(fn)},
    async parkScene(){calls.push('park');assert.equal(sandbox.activeScene,session);session.frame.connected=false;const placeholder={id:'placeholder',connected:true};session.frame=placeholder;ui['preview-frame']=placeholder;session.parked=true},
    agentValidator({selected,retainOnFailure=true}){return async(candidate,{signal})=>{
      calls.push('validate');assert.equal(candidate,inputs.length?repaired:html);modelLoaded=false;
      assert.equal(retainOnFailure,inputs.length?true:false,'first runtime replay cannot overwrite an unrelated unverified candidate');
      if(abortAtCheck)sandbox.agentController.abort();
      if(signal.aborted)throw new DOMException('cancel','AbortError');
      const result=outcomes.shift();assert.ok(result,'late recovery is bounded');
      if(result.ok)selected.frame={id:nextFrame++,connected:true};
      if(staleAtCheck)sandbox.activeScene={frame:{id:'different'}};
      return result;
    }},
    runAgent,agentGenerate(){return async args=>{calls.push('generate');assert.ok(session.parked,'old GPU scene released before model initialization');assert.equal(old.connected,false);modelLoaded=true;inputs.push(args);return repaired}},
    agentEvents(){return ()=>{}},getModelState:()=>({loaded:modelLoaded,suspended:true}),
    adoptCandidate(frame,source){assert.equal(sandbox.activeScene,session);ui['preview-frame']=frame;sandbox.scene=source;calls.push('adopt')},
    clearUnverified(){clears++},retainUnverified(value){retained.push(value)},
    async discardCandidate(frame){if(frame)frame.connected=false;calls.push('discard')},
    async restorePreviousScene(){restoreCount++;calls.push('restore');session.parked=false;session.frame={id:'restored'};ui['preview-frame']=session.frame},
  };
  const context=vm.createContext(sandbox);vm.runInContext(section,context);
  return {context,session,ui,events,calls,inputs,retained,timers,old,get restoreCount(){return restoreCount},get clears(){return clears},
    queue:detail=>context.queueLateRepair(session,detail),run:()=>context.runLateRepair(session)};
}

// A context-loss or other late runtime error first replays the saved source.
// A transient condition recovers without loading/generating a model at all.
{
  const h=make([ok()]);const detail={kind:'webgl-context-lost',source:'about:srcdoc',message:'context lost',line:123,column:4};
  h.queue(detail);await h.run();
  assert.deepEqual(h.calls,['park','validate','adopt','discard']);assert.equal(h.inputs.length,0);assert.equal(h.context.scene,html);
  assert.equal(h.ui['prompt-input'].value,'unrelated draft');assert.equal(h.clears,0,'keep an unrelated failed candidate');
  assert.equal(h.session.lateRepairStarted,true);assert.equal(h.session.parked,false);assert.equal(h.context.busy,false);
  const input=h.events.find(e=>e.type==='tool-start').input;
  assert.equal(input.diagnostics[0].kind,'webgl-context-lost');assert.equal(input.diagnostics[0].source,'about:srcdoc');assert.equal(input.diagnostics[0].line,123);
  const frame=h.ui['preview-frame'];h.queue({kind:'script',message:'another error'});assert.equal(h.ui['preview-frame'],frame);assert.equal(h.inputs.length,0);assert.equal(h.session.pendingError,null,'no endless runtime recovery cycle');
}
// Full mapped diagnostic survives the queue; deduped bursts retain the actual
// JavaScript exception after a shader diagnostic, without unbounded storage.
{
  const h=make([code(),ok()]);const mapped='Исходный HTML, строка 124\n> 124 | brokenMaterial.value = 1;\n'+'x'.repeat(1000)+'\nTypeError: mapped material failure';
  h.queue('shader failure');h.queue({kind:'script',source:'about:srcdoc',message:mapped,rawMessage:'raw exception',line:124,column:8});h.queue('shader failure');
  assert.equal(h.session.pendingError.length,2);assert.ok(h.session.pendingError[1].message.length>500);
  await h.run();assert.equal(h.inputs.length,1);assert.equal(h.inputs[0].previousCode,html);assert.match(h.inputs[0].prompt,/original forest request/);
  assert.match(h.inputs[0].prompt,/fresh runtime failure/);assert.match(h.inputs[0].prompt,/mapped material failure/);
  assert.equal(h.context.scene,repaired);assert.equal(h.clears,1);assert.equal(h.restoreCount,0);
  const diagnostics=h.events.find(e=>e.type==='tool-start').input.diagnostics;assert.equal(diagnostics[1].rawMessage,'raw exception');
}
// Persistent infrastructure failure stops before model allocation and is not
// blindly retried yet again by the previous-scene rollback path.
{
  const h=make([infra()]);h.queue({kind:'webgl-context-lost',message:'context lost'});await h.run();
  assert.equal(h.inputs.length,0);assert.equal(h.restoreCount,0);assert.equal(h.context.scene,html);assert.equal(h.session.parked,true);
  assert.equal(h.context.busy,false);assert.match(h.context.errorText,/WebGL unavailable/);
}
// Stop during saved-code replay preserves source/draft and runs the normal
// source rollback, without ever invoking the model.
{
  const h=make([ok()],{abortAtCheck:true});h.queue('late exception');await h.run();
  assert.equal(h.inputs.length,0);assert.equal(h.context.scene,html);assert.equal(h.restoreCount,1);assert.equal(h.ui['prompt-input'].value,'unrelated draft');
  assert.equal(h.context.busy,false);assert.equal(h.ui['stop-agent'].hidden,true);
}
// An asynchronous stale scene cannot adopt its candidate or restore itself
// over the newly selected session.
{
  const h=make([ok()],{staleAtCheck:true});h.queue('late exception');await h.run();
  assert.equal(h.calls.includes('adopt'),false);assert.equal(h.restoreCount,0);assert.equal(h.context.scene,html);assert.equal(h.inputs.length,0);
}
console.log('PASS late runtime replay, full diagnostics, code escalation, bounded context recovery, Stop and stale-session safety');
