import assert from 'node:assert/strict';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {makeSandboxDocument, validateScene} from '../sandbox-runner.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const listeners = new Set();
globalThis.window = {
  addEventListener(type, fn) { if (type === 'message') listeners.add(fn); },
  removeEventListener(type, fn) { if (type === 'message') listeners.delete(fn); },
};
const dispatch = (source, data) => { for (const fn of [...listeners]) fn({source, data}); };
const norm = text => text.replace(/\r\n?/g, '\n');
function location(text, marker) {
  const s = norm(text);
  const index = s.indexOf(marker);
  assert.notEqual(index, -1);
  const before = s.slice(0,index);
  return {line:before.split('\n').length, column:before.length - before.lastIndexOf('\n')};
}
function frameFor(payloads) {
  const target = {postMessage(data) {
    queueMicrotask(() => dispatch(target, {...data, type:'released', payload:{contexts:1,requested:1,unsupported:0,failed:0}}));
  }};
  return {isConnected:true, contentWindow:target, setAttribute(){}, set srcdoc(srcdoc) {
    if (!srcdoc) return;
    const nonce = srcdoc.match(/const nonce = "([0-9a-f]+)"/)?.[1];
    assert.ok(nonce);
    queueMicrotask(() => {
      for (const item of payloads(srcdoc)) dispatch(target, {channel:'forma-runner-v1',nonce,type:'error',payload:item});
      dispatch(target, {channel:'forma-runner-v1',nonce,type:'ready',payload:{canvasCount:1,visibleCanvasCount:1,webglContexts:1,drawCalls:1,drawObservationAvailable:true}});
    });
  }};
}
async function validate(html, payloads) {
  const result = await validateScene({iframe:frameFor(payloads),html});
  assert.equal(listeners.size,0);
  return result;
}

for (const html of [
  '<!doctype html>\n<html>\n<body>\n<script>\nthrow new Error("SOURCE_MARKER");\n</script>\n</body></html>',
  '\r\n<!DOCTYPE\r\n html>\r\n<html>\r\n<body>\r\n<script>\r\nthrow new Error("SOURCE_MARKER");\r\n</script>\r\n</body></html>',
  '<html>\r<body>\r<script>\rthrow new Error("SOURCE_MARKER");\r</script>\r</body></html>',
  '<!doctype html><html><body><script>throw new Error("SOURCE_MARKER");</script></body></html>',
]) {
  const original = location(html,'SOURCE_MARKER');
  const result = await validate(html, srcdoc => {
    const here = location(srcdoc,'SOURCE_MARKER');
    return [{kind:'script',source:'about:srcdoc',line:here.line,column:here.column,message:`Error: broken\n    at run (about:srcdoc:${here.line}:${here.column})`}];
  });
  assert.equal(result.ok,false);
  const diagnostic = result.errors.join('\n');
  assert.match(diagnostic,new RegExp(`Исходный HTML, строка ${original.line}\\b`));
  assert.match(diagnostic,/SOURCE_MARKER/);
  assert.match(diagnostic,/Error: broken\n    at run \(about:srcdoc:/, 'original stack is preserved');
}

const html = '<!doctype html>\n<html>\n<script>\nconst SOURCE_MARKER = 1;\n</script>\n</html>';
const library = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/0.160.0/three.module.min.js';
const fromLibrary = await validate(html, srcdoc => {
  const here = location(srcdoc,'SOURCE_MARKER');
  return [{kind:'script',source:library,message:`TypeError\n    at lib (${library}:6:12)\n    at run (about:srcdoc:${here.line}:${here.column})`}];
});
assert.equal(fromLibrary.retryable,true);
assert.match(fromLibrary.errors.join('\n'),/Исходный HTML, строка 4/);
assert.match(fromLibrary.errors.join('\n'),/three\.module\.min\.js:6:12/);

const longLine = '<!doctype html><html><body><script>/*' + 'x'.repeat(500) + '*/const SOURCE_MARKER = 1;</script></body></html>';
const longLineResult = await validate(longLine, srcdoc => {
  const here = location(srcdoc,'SOURCE_MARKER');
  return [{kind:'script',source:'about:srcdoc',line:here.line,column:here.column,message:`Error (about:srcdoc:${here.line}:${here.column})`}];
});
assert.match(longLineResult.errors.join('\n'),/> 1 \| ….*SOURCE_MARKER/, 'long one-line source is cropped around the reported column');

const invalid = await validate(html, () => [
  {kind:'script',source:library,message:'external only https://cdnjs.cloudflare.com/example.js:8:1'},
  {kind:'script',source:'about:srcdoc',line:1,column:1,message:'bridge failure about:srcdoc:1:1'},
  {kind:'script',source:'about:srcdoc',line:999999999,column:3,message:'out of range about:srcdoc:999999999:3'},
]);
assert.equal(invalid.errors.length,3);
assert.doesNotMatch(invalid.errors.join('\n'),/Исходный HTML/);

const errors = await validate(html, srcdoc => {
  const here = location(srcdoc,'SOURCE_MARKER');
  return [
    ...Array.from({length:30},()=>({kind:'console',message:'same shader failure'})),
    ...Array.from({length:15},(_,i)=>({kind:'console',message:`another shader ${i}`})),
    {kind:'script',source:'about:srcdoc',line:here.line,column:here.column,message:`TypeError: SOURCE_MARKER (about:srcdoc:${here.line}:${here.column})`},
    {kind:'webgl-context-lost',message:'Потерян контекст WebGL'},
  ];
});
assert.equal(errors.errors.filter(x=>x==='same shader failure').length,1);
assert.ok(errors.errors.some(x=>/TypeError: SOURCE_MARKER/.test(x)), 'console spam cannot hide script exception');
assert.ok(errors.errors.some(x=>/Исходный HTML, строка 4/.test(x)));
assert.equal(errors.contextLost,true);
assert.ok(errors.errors.length<=13);

// Test the injected bridge itself, not only the parent-side message receiver.
const parent = {messages:[],postMessage(value){this.messages.push(value);}};
const hooks = new Map();
const sandboxWindow = {};
let contextLost;
const gl = {isContextLost:()=>false,getExtension:()=>null};
class Canvas {getContext(){return gl;} addEventListener(type,fn){if(type==='webglcontextlost')contextLost=fn;}}
const consoleStub = {error(){}};
const sandbox = {parent,window:sandboxWindow,console:consoleStub,HTMLCanvasElement:Canvas,addEventListener(type,fn){hooks.set(type,fn);},setTimeout};
const doc = makeSandboxDocument('<html></html>', 'bridge-test');
const bridgeScript = doc.match(/<script>([\s\S]*?)<\/script>/)[1];
vm.runInNewContext(bridgeScript,sandbox);
new Canvas().getContext('webgl');
for (let i=0;i<30;i++) consoleStub.error('same shader failure');
for (let i=0;i<15;i++) consoleStub.error(`another shader ${i}`);
hooks.get('error')({target:sandboxWindow, message:'TypeError', filename:'about:srcdoc', lineno:150, colno:5, error:{stack:'TypeError stack'}});
contextLost();
const reported = parent.messages.filter(x=>x.type==='error').map(x=>x.payload);
assert.equal(reported.filter(x=>x.message==='same shader failure').length,1);
assert.ok(reported.some(x=>x.kind==='script' && x.message.includes('TypeError') && x.line===150));
assert.ok(reported.some(x=>x.kind==='webgl-context-lost'));
assert.ok(reported.length<=13);
console.log('PASS original HTML line mapping, stack preservation, external errors, newline variants and bounded deduplication');
