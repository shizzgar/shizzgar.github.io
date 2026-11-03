import assert from 'node:assert/strict';
import {createTracePanel} from '../trace-panel.js';

class TextNode {
  constructor(value='') {this.data=value;this.parent=null;}
  appendData(value) {this.data+=value;}
  get textContent() {return this.data;}
  set textContent(value) {this.data=String(value);}
  remove() {if(this.parent)this.parent.children=this.parent.children.filter(x=>x!==this);this.parent=null;}
}
class Element {
  constructor(tag) {this.tag=tag;this.children=[];this.parent=null;this.attrs={};this.style={};this.dataset={};this.className='';this.open=false;this.scrollTop=0;this.clientHeight=100;this.scrollHeight=100;}
  append(...items) {for(const item of items){if(item.parent)item.remove();item.parent=this;this.children.push(item);}}
  replaceChildren() {for(const child of this.children)child.parent=null;this.children=[];}
  remove() {if(this.parent)this.parent.children=this.parent.children.filter(x=>x!==this);this.parent=null;}
  setAttribute(name,value) {this.attrs[name]=String(value);}
  get firstElementChild() {return this.children.find(x=>x instanceof Element);}
  get isConnected() {return Boolean(this.parent);}
  set textContent(value) {this.replaceChildren();this.append(new TextNode(String(value)));}
  get textContent() {return this.children.map(x=>x.textContent).join('');}
  click() {}
}
globalThis.document={documentElement:{lang:'en',dataset:{appVersion:'test-export-1'}},createElement:tag=>new Element(tag),createTextNode:value=>new TextNode(value)};
let secret='hf_abcdefghijklmnopqrstuvwx';
const mount=new Element('div');
const panel=createTracePanel(mount,{language:'ru',getSecret:()=>secret,redact:value=>String(value).split(secret || '\0').join('[hidden]'),translate:(value,lang)=>lang==='en' && value==='Режим модели'?'Model mode':value});
assert.equal(panel.hasTrace(),false);
panel.begin();
panel.stage('Режим модели','GPU requested');
panel.event({type:'generating',attempt:1,maxAttempts:3});
panel.event({type:'reasoning',attempt:1,maxAttempts:3,delta:'Русский вывод не переводится. '+secret.slice(0,9)});
// Exporting in the middle of a token must neither expose its pending prefix
// nor mutate the stream's pending state.
const mid=panel.exportTrace({format:'json'}).content;
assert(!mid.includes(secret.slice(0,9)));
panel.event({type:'reasoning',attempt:1,maxAttempts:3,delta:secret.slice(9)+' after'});
const longOutput='A'.repeat(250000)+'THE_END';
panel.event({type:'token',attempt:1,maxAttempts:3,delta:longOutput.slice(0,125000)});
panel.event({type:'token',attempt:1,maxAttempts:3,delta:longOutput.slice(125000)});
const file=new Blob(['PRIVATE_FILE_BYTES'],{type:'image/png'});file.name='reference.png';
const fullCode='<html>'+('source '.repeat(20000))+'</html>';
const tool=panel.toolStart('Генерация модели',{prompt:'Original request '+secret,previousCode:fullCode,file});
const failure=new Error('refreshFogUniforms '+secret);failure.stack='TypeError '+secret+' at generated scene';
panel.toolFinish(tool,{error:failure});
const outputTool=panel.toolStart('Code',{input:'source'});
panel.toolFinish(outputTool,{output:fullCode+' '+secret});
const detail='D'.repeat(4500)+'DETAIL_END';
panel.stage('Full detail',detail);
for(let i=0;i<140;i++)panel.stage('Stage '+i,'Details '+i);
panel.setDevice({gpu:'adapter',modelBuffers:'WebGPU: 100 MiB'});
panel.setMetrics({ttftMs:250,tokensPerSecond:42,generatedTokens:270000});
panel.finish('Готово');
secret='';
panel.begin({preserve:true});
panel.stage('New turn','The old token has been removed from the field.');
panel.setLanguage('en');
assert.match(mount.textContent,/Agent activity/);
assert.match(mount.textContent,/NEW TURN/);
// The UI prunes and truncates, while the archive keeps full earlier records.
const data=panel.getExportData();
assert.equal(data.schema,'forma.agent-trace');
assert.equal(data.appVersion,'test-export-1');
assert.equal(data.uiLanguage,'en');
assert.equal(data.complete,true);
assert.equal(data.archiveTruncated,false);
assert(data.events.some(x=>x.type==='stage'&&x.label==='Stage 0'));
assert(data.events.some(x=>x.type==='stage'&&x.detail===detail));
const content=data.events.find(x=>x.type==='model_stream'&&x.kind==='content');
assert.equal(content.text,longOutput);
assert.equal(content.chunks,2);
assert.equal(content.receivedChars,longOutput.length);
const reasoning=data.events.find(x=>x.type==='model_stream'&&x.kind==='reasoning');
assert.match(reasoning.text,/Русский вывод не переводится/);
assert.match(reasoning.text,/after/);
assert(!JSON.stringify(data).includes('hf_abcdefghijklmnopqrstuvwx'),'old secret is masked after the input is cleared');
const start=data.events.find(x=>x.type==='tool_start'&&x.input?.file);
assert.equal(start.input.previousCode,fullCode);
assert.deepEqual({...start.input.file},{kind:'file',name:'reference.png',type:'image/png',size:file.size,binaryIncluded:false});
assert(!JSON.stringify(data).includes('PRIVATE_FILE_BYTES'));
const error=data.events.find(x=>x.type==='tool_finish'&&x.status==='error');
assert.equal(error.error.name,'Error');assert.match(error.error.stack,/TypeError/);
assert(!error.error.stack.includes('hf_'));
assert(data.events.some(x=>x.type==='tool_finish'&&x.output?.startsWith(fullCode)));
assert(data.events.some(x=>x.type==='metrics'&&x.metrics.generatedTokens===270000));
const json=panel.exportTrace({format:'json'});assert.equal(JSON.parse(json.content).events.length,data.events.length);assert.match(json.filename,/\.json$/);
const text=panel.exportTrace({format:'text'});assert.match(text.content,/THE_END/);assert.match(text.content,/DETAIL_END/);assert.match(text.filename,/\.txt$/);
assert(!text.content.includes('hf_abcdefghijklmnopqrstuvwx'));
// A token learned later is also scrubbed from earlier archived values.
panel.stage('Earlier','private-later-value');secret='private-later-value';
assert(!panel.exportTrace().content.includes('private-later-value'));
panel.begin({preserve:false});
assert.equal(panel.getExportData().events.length,1);
assert.equal(panel.getExportData().events[0].type,'begin');
assert.throws(()=>panel.exportTrace({format:'invalid'}),/Unsupported/);
console.log('PASS full trace archive, split/old secret redaction, complete streams/tool IO, metadata and language switch');
