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
const limit=await runAgent({prompt:'x',generate:async()=>'<html>'+('a'.repeat(48001))+'</html>',validate:async()=>({ok:false})}); assert.equal(limit.reason,'context_limit');
const fatal=await runAgent({prompt:'x',generate:async()=>{throw Error('GPU lost')},validate:async()=>({ok:true})}); assert.equal(fatal.reason,'generation_error');
const ac = new AbortController(); ac.abort(); await assert.rejects(()=>runAgent({prompt:'x',signal:ac.signal,generate:async()=>html,validate:async()=>({ok:true})}),{name:'AbortError'});
const ac2 = new AbortController(); await assert.rejects(()=>runAgent({prompt:'x',signal:ac2.signal,generate:async()=>{ac2.abort();return html},validate:async()=>({ok:true})}),{name:'AbortError'});
console.log('PASS bounded agent loop: repair, malformed output, validation unavailable, failure preservation, abort and limits');
const lateInputs=[];
const late = await runAgent({prompt:'Создай дом',previousCode:failHtml,initialErrors:['TypeError: поздняя ошибка'],generate:async x=>{lateInputs.push(x);return html},validate:async()=>({ok:true})});
assert.equal(late.ok,true); assert.equal(lateInputs[0].previousCode,failHtml); assert.match(lateInputs[0].prompt,/TypeError: поздняя ошибка/); assert.match(lateInputs[0].prompt,/Создай дом/);
let shouldNotRun=false;
const tooBig=await runAgent({prompt:'x',previousCode:'a'.repeat(20001),initialErrors:['late'],generate:async()=>{shouldNotRun=true;return html},validate:async()=>({ok:true})}); assert.equal(tooBig.reason,'context_limit');assert.equal(shouldNotRun,false);
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
const truncatedInputs=[];
const recovered=await runAgent({prompt:'Сложный город',generate:async input=>{truncatedInputs.push(input);return truncatedInputs.length===1?{text:'<html>'+('x'.repeat(25000)),finishReason:'length'}:{text:finalDoc,finishReason:'stop'}},validate:async()=>({ok:true})});
assert.equal(recovered.ok,true);assert.equal(truncatedInputs.length,2);assert.equal(truncatedInputs[1].previousCode,'');assert.match(truncatedInputs[1].prompt,/лимиту генерации или контекста/);assert.match(truncatedInputs[1].prompt,/более компактную сцену/);
const edits=[];
await runAgent({prompt:'Сделай крышу красной',previousCode:html,generate:async input=>{edits.push(input);return edits.length===1?{text:'<html>truncated',finishReason:'length'}:finalDoc},validate:async()=>({ok:true})});
assert.equal(edits[1].previousCode,html);
console.log('PASS final answer extraction and truncated generation recovery');

const retryInputs=[], retryEvents=[];
const retry=await runAgent({prompt:'Построй маяк', previousCode:html, initialErrors:['сломался рендер'], onEvent:event=>retryEvents.push(event), generate:async input=>{
  retryInputs.push(input);
  return retryInputs.length===1 ? {text:'<think>still reasoning',finishReason:'length'}
    : retryInputs.length===2 ? {text:'',finishReason:'length'} : {text:finalDoc,finishReason:'stop'};
}, validate:async()=>({ok:true})});
assert.equal(retry.ok,true);
assert.equal(retryInputs[0].thinking,undefined,'first attempt preserves caller preference');
assert.equal(retryInputs[1].thinking,false,'truncated thinking is disabled for retry');
assert.equal(retryInputs[2].thinking,false,'subsequent retries retain the disabled override');
assert.equal(retryInputs[1].previousCode,html,'prior working scene survives truncated generation');
assert.match(retryInputs[1].prompt,/Построй маяк/);
assert.match(retryInputs[1].prompt,/сломался рендер/,'late repair diagnostic survives truncated answer');
assert(!retryInputs[1].prompt.includes('still reasoning'),'partial output is not repeated');
assert.deepEqual(retryEvents.filter(event=>event.type==='retry_without_thinking').map(event=>event.attempt),[2]);

const incompleteInputs=[];
await runAgent({prompt:'x',generate:async input=>{incompleteInputs.push(input);return incompleteInputs.length===1?{text:'<html>incomplete',finishReason:null}:html},validate:async()=>({ok:true})});
assert.equal(incompleteInputs[1].thinking,undefined,'unknown finish reason must not trigger an override');
const fullLengthInputs=[];
const fullLength=await runAgent({prompt:'x',generate:async input=>{fullLengthInputs.push(input);return {text:html,finishReason:'length'}},validate:async()=>({ok:true})});
assert.equal(fullLength.ok,true,'a complete HTML at length limit is validated');
assert.equal(fullLengthInputs.length,1);
const exhaustedEvents=[];
await runAgent({prompt:'x',maxAttempts:1,onEvent:e=>exhaustedEvents.push(e),generate:async()=>({text:'',finishReason:'length'}),validate:async()=>({ok:true})});
assert(!exhaustedEvents.some(event=>event.type==='retry_without_thinking'),'no retry event after last attempt');
console.log('PASS adaptive reasoning override, bounded retries and truthful events');
