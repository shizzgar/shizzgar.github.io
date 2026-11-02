import assert from 'node:assert/strict';
import { runAgent } from '../agent-loop.js';
const html = '<!doctype html><html><body><canvas></canvas></body></html>';
const failHtml = '<html><body><script>bad()</script></body></html>';
const events=[]; const inputs=[];
let attempt=0;
const success = await runAgent({
 prompt:'Создай дом', image:{id:1}, previousCode:'<html>old scene</html>',
 generate:async x=>{ inputs.push(x); attempt++; x.onToken('x','abc'); return attempt===1?failHtml:`\`\`\`html\n${html}\n\`\`\``;},
 validate:async source=>source===failHtml?{ok:false,errors:['ReferenceError: bad is not defined']}:{ok:true,evidence:{drawCalls:1}},
 onEvent:e=>events.push(e),
});
assert.equal(success.ok,true); assert.equal(success.html,html); assert.equal(success.attempts,2);
assert.equal(inputs[0].previousCode,'<html>old scene</html>');
assert.equal(inputs[1].previousCode,failHtml); assert.match(inputs[1].prompt,/ReferenceError/); assert.match(inputs[1].prompt,/Создай дом/); assert.equal(inputs[1].image.id,1);
assert(events.some(e=>e.type==='repairing')); assert(events.some(e=>e.type==='validating'));
let calls=0;
const incomplete=await runAgent({prompt:'x',generate:async x=>{calls++;return calls===1?'<html><body>unfinished':html},validate:async()=>({ok:true})});
assert.equal(incomplete.ok,true); assert.equal(calls,2);
const failed=await runAgent({prompt:'x',previousCode:'old',maxAttempts:2,generate:async()=>failHtml,validate:async()=>({ok:false,errors:['runtime err']})});
assert.equal(failed.ok,false); assert.equal(failed.reason,'attempts_exhausted'); assert.equal(failed.attempts,2); assert.equal(failed.html,null); assert.equal(failed.lastHtml,failHtml); assert.match(failed.errors[0],/runtime err/);
calls=0;
const unavailable=await runAgent({prompt:'x',generate:async()=>{calls++;return html},validate:async()=>({ok:false,retryable:false,errors:['No WebGL']})});
assert.equal(calls,1); assert.equal(unavailable.reason,'validation_unavailable');
const invalid=await runAgent({prompt:'x',generate:async()=>html,validate:async()=>({})}); assert.equal(invalid.reason,'validation_unavailable');
const largeInputs=[];
const largeScene='<html>'+('a'.repeat(48001))+'</html>';
const largeRetry=await runAgent({prompt:'x',generate:async input=>{largeInputs.push(input);return largeInputs.length===1?largeScene:html},validate:async source=>source===largeScene?{ok:false,errors:['runtime']}:{ok:true}});
assert.equal(largeRetry.ok,true);assert.equal(largeInputs[1].previousCode,largeScene,'large scene is passed intact without a character-based context guess');
const fatal=await runAgent({prompt:'x',generate:async()=>{throw Error('GPU lost')},validate:async()=>({ok:true})}); assert.equal(fatal.reason,'generation_error');
const ac = new AbortController(); ac.abort(); await assert.rejects(()=>runAgent({prompt:'x',signal:ac.signal,generate:async()=>html,validate:async()=>({ok:true})}),{name:'AbortError'});
const ac2 = new AbortController(); await assert.rejects(()=>runAgent({prompt:'x',signal:ac2.signal,generate:async()=>{ac2.abort();return html},validate:async()=>({ok:true})}),{name:'AbortError'});
console.log('PASS bounded agent loop: repair, malformed output, validation unavailable, failure preservation, abort and limits');
const lateInputs=[];
const late = await runAgent({prompt:'Создай дом',previousCode:failHtml,initialErrors:['TypeError: поздняя ошибка'],generate:async x=>{lateInputs.push(x);return html},validate:async()=>({ok:true})});
assert.equal(late.ok,true); assert.equal(lateInputs[0].previousCode,failHtml); assert.match(lateInputs[0].prompt,/TypeError: поздняя ошибка/); assert.match(lateInputs[0].prompt,/Создай дом/);
const largeRepairCode='a'.repeat(40001), largeRepairInputs=[];
const largeRepair=await runAgent({prompt:'x',previousCode:largeRepairCode,initialErrors:['late'],generate:async input=>{largeRepairInputs.push(input);return html},validate:async()=>({ok:true})});
assert.equal(largeRepair.ok,true);assert.equal(largeRepairInputs[0].previousCode,largeRepairCode,'late repair code must not be cut off by old character limit');
console.log('PASS late errors repair and context boundary');

const draft = '<html><body>DRAFT</body></html>';
const finalDoc = '<!DOCTYPE html><html><body>FINAL</body></html>';
async function resultFor(output) {
  const validated=[];
  const result=await runAgent({prompt:'test',maxAttempts:1,generate:async()=>output,validate:async html=>{validated.push(html);return {ok:true}}});
  return {result,validated};
}
for (const output of [
  `<think>Раздумья: ${draft}</think>\n${finalDoc}`,
  `Скрытый черновик ${draft}</think>\n\`\`\`html\n${finalDoc}\n\`\`\``,
  `\`\`\`html\n${draft}\n\`\`\`\nФинал:\n\`\`\`html\n${finalDoc}\n\`\`\``,
  `\`\`\`javascript\n${draft}\n\`\`\`\n${finalDoc}`,
]) {
  const {result,validated}=await resultFor(output);
  assert.equal(result.ok,true);assert.deepEqual(validated,[finalDoc]);
}
for (const output of [
  `<think>Черновик: ${draft}</think>Никакого итогового HTML`,
  `<think>Черновик: ${draft}`,
  `${draft}\n<html><body>незавершённый финал`,
  `\`\`\`javascript\n${draft}\n\`\`\``,
]) {
  const {result,validated}=await resultFor(output);
  assert.equal(result.ok,false);assert.deepEqual(validated,[]);
}
const containsThink = '<html><body><script>const s="<think>literally kept</think>";</script></body></html>';
assert.equal((await resultFor(containsThink)).result.html,containsThink);
const truncatedInputs=[], truncatedEvents=[];
const partial='<think>still reasoning';
const stopped=await runAgent({prompt:'Построй маяк', previousCode:html, initialErrors:['сломался рендер'], onEvent:event=>truncatedEvents.push(event), generate:async input=>{truncatedInputs.push(input);return {text:partial,finishReason:'length'}}, validate:async()=>{throw Error('incomplete HTML must not run')}});
assert.equal(stopped.ok,false);assert.equal(stopped.reason,'output_limit');assert.equal(stopped.attempts,1);assert.equal(stopped.lastOutput,partial,'keep the partial response for inspection');
assert.equal(truncatedInputs.length,1,'do not repeat a generation under the same exhausted budget');
assert.equal(truncatedInputs[0].thinking,undefined,'preserve the user thinking preference');
assert.equal(truncatedInputs[0].previousCode,html,'the prior working scene is preserved');
assert.match(truncatedInputs[0].prompt,/Построй маяк/);assert.match(truncatedInputs[0].prompt,/сломался рендер/);
assert(!truncatedEvents.some(e=>e.type==='retry_without_thinking'||e.type==='repairing'),'no forced thinking change or unchanged-budget retry');
assert(truncatedEvents.some(e=>e.type==='failed'&&e.reason==='output_limit'));
assert(!stopped.errors[0].includes('компактн'),'do not ask for a simpler scene');

const empty=await runAgent({prompt:'x',generate:async()=>({text:'',finishReason:'length'}),validate:async()=>{throw Error('empty response must not run')}});
assert.equal(empty.reason,'output_limit');assert.equal(empty.lastOutput,'');
const incompleteInputs=[];
await runAgent({prompt:'x',generate:async input=>{incompleteInputs.push(input);return incompleteInputs.length===1?{text:'<html>incomplete',finishReason:null}:html},validate:async()=>({ok:true})});
assert.equal(incompleteInputs.length,2,'unknown finish reason still permits correction');
assert.equal(incompleteInputs[1].thinking,undefined);
const fullLengthInputs=[];
const fullLength=await runAgent({prompt:'x',generate:async input=>{fullLengthInputs.push(input);return {text:html,finishReason:'length'}},validate:async()=>({ok:true})});
assert.equal(fullLength.ok,true,'a complete HTML at length limit is validated');assert.equal(fullLengthInputs.length,1);
const engineContextError=Object.assign(new Error('kv cache is full'),{type:'kv_cache_full'});
const contextFull=await runAgent({prompt:'x',generate:async()=>{throw engineContextError},validate:async()=>({ok:true})});
assert.equal(contextFull.reason,'context_limit');assert.match(contextFull.errors[0],/контекст модели заполнен/);
console.log('PASS length limit is reported without reducing thinking or request, no guessed character limit');

// Preflight must reject structural/classic-script syntax problems before a
// renderer or GPU context is created, then feed diagnostics to the repair.
const preflightInputs=[], preflightEvents=[]; let preflightValidations=0;
const badClassic='<html><body><script>const x = ;</script></body></html>';
const preflightRepair=await runAgent({prompt:'scene',generate:async input=>{preflightInputs.push(input); return preflightInputs.length===1?badClassic:html;},validate:async()=>{preflightValidations++;return {ok:true}},onEvent:e=>preflightEvents.push(e)});
assert.equal(preflightRepair.ok,true);
assert.equal(preflightValidations,1,'invalid syntax never reaches renderer');
assert.equal(preflightInputs[1].previousCode,badClassic);
assert.match(preflightInputs[1].prompt,/Синтаксическая ошибка JavaScript/);
assert(preflightEvents.some(e=>e.type==='preflight'));
let unclosedValidated=false;
const unclosed=await runAgent({prompt:'scene',maxAttempts:1,generate:async()=>'<html><body><script>const x = 1;</body></html>',validate:async()=>{unclosedValidated=true;return {ok:true}}});
assert.equal(unclosed.ok,false);assert.equal(unclosedValidated,false);assert.match(unclosed.errors[0],/закрывающий тег/);
// Compilation never runs the code; module scripts are left to the browser.
globalThis.__preflightExecuted=false;
const safeClassic='<html><script>globalThis.__preflightExecuted=true;</script></html>';
assert.equal((await resultFor(safeClassic)).result.ok,true);
assert.equal(globalThis.__preflightExecuted,false);
delete globalThis.__preflightExecuted;
const moduleDoc='<html><body><script type="module">import * as T from "https://example.test/x.js"; await 1;</script></body></html>';
assert.equal((await resultFor(moduleDoc)).result.ok,true,'module syntax is not compiled as a classic script');
const inertData='<html><body><script type="application/ld+json">{ "not javascript": true }</script></body></html>';
assert.equal((await resultFor(inertData)).result.ok,true);
const quotedTag='<html><body><div title="literal <script> text"></div><!-- <script> --><script>const x = 1;</script></body></html>';
assert.equal((await resultFor(quotedTag)).result.ok,true,'quoted attributes and comments do not become scripts');
const rawText='<html><body><textarea><script>not code</textarea><title><script></title><script>const x = 1;</script></body></html>';
assert.equal((await resultFor(rawText)).result.ok,true,'inert raw text is not mistaken for a script');
const inertTemplate='<html><body><template><template><script>const x = ;</script></template></template><script>const y = 1;</script></body></html>';
assert.equal((await resultFor(inertTemplate)).result.ok,true,'inert template contents are not rejected as executable scripts');
console.log('PASS non-executing preflight, repair, modules and quoted HTML');

// A known WebGL loss can receive one repair, never an unbounded loop or an
// inferred recovery from a different infrastructure problem.
const contextLostResult={ok:false,retryable:false,contextLost:true,infrastructureErrorOther:false,errors:['Потерян контекст WebGL']};
const lossInputs=[],lossEvents=[];let lossChecks=0;
const recoveredLoss=await runAgent({prompt:'маяк',image:{id:3},generate:async input=>{lossInputs.push(input);return html},validate:async()=>++lossChecks===1?contextLostResult:{ok:true},onEvent:e=>lossEvents.push(e)});
assert.equal(recoveredLoss.ok,true);assert.equal(lossChecks,2);assert.equal(lossInputs.length,2);
assert.equal(lossInputs[1].previousCode,html);assert.match(lossInputs[1].prompt,/Потерян контекст WebGL/);assert.match(lossInputs[1].prompt,/маяк/);
assert.equal(lossInputs[1].image.id,3);assert.equal(lossInputs[1].thinking,undefined,'reasoning preference is not overridden');
assert(!/compact|simplif/i.test(lossInputs[1].prompt),'retry must not demand a simplified scene');
assert.equal(lossEvents.filter(e=>e.type==='context_loss_repair').length,1);
let repeatedCalls=0;
const repeatedLoss=await runAgent({prompt:'маяк',generate:async()=>{repeatedCalls++;return html},validate:async()=>contextLostResult});
assert.equal(repeatedCalls,2);assert.equal(repeatedLoss.reason,'validation_unavailable');assert.equal(repeatedLoss.attempts,2);
for (const result of [
  {ok:false,retryable:false,contextLost:true,infrastructureErrorOther:true,errors:['Потерян контекст WebGL','Ошибка CDN']},
  {ok:false,retryable:false,contextLost:true,errors:['Потерян контекст WebGL']},
  {ok:false,retryable:false,contextLost:false,infrastructureErrorOther:true,errors:['Ошибка сети']},
]) {
  let count=0;
  const mixed=await runAgent({prompt:'маяк',generate:async()=>{count++;return html},validate:async()=>result});
  assert.equal(count,1,'a mixed, unclassified or non-WebGL infrastructure problem must not be retried');
  assert.equal(mixed.reason,'validation_unavailable');
}
let sequenceChecks=0;const sequenceEvents=[];
const mixedRuntime=await runAgent({prompt:'маяк',generate:async()=>html,validate:async()=>{
  sequenceChecks++;
  return sequenceChecks===1?{ok:false,errors:['ошибка кода']} : sequenceChecks===2?contextLostResult:{ok:true};
},onEvent:e=>sequenceEvents.push(e)});
assert.equal(mixedRuntime.ok,true);assert.equal(sequenceChecks,3,'a regular code repair followed by one context-loss repair is permitted');
assert.equal(sequenceEvents.filter(e=>e.type==='context_loss_repair').length,1);
console.log('PASS one bounded WebGL loss repair and mixed infrastructure failures');
