import assert from 'node:assert/strict';
import { createTracePanel } from '../trace-panel.js';
class T {constructor(s=''){this.data=s;this.parent=null}appendData(s){this.data+=s}get textContent(){return this.data}set textContent(v){this.data=String(v)}remove(){if(this.parent)this.parent.children=this.parent.children.filter(x=>x!==this);this.parent=null}}
class E {constructor(tag){this.tag=tag;this.children=[];this.parent=null;this.style={};this.dataset={};this.className='';this.attrs={};this.scrollTop=0;this.clientHeight=100;this.scrollHeight=100;this.open=false}append(...a){for(const x of a){if(x.parent)x.remove();x.parent=this;this.children.push(x)}}setAttribute(k,v){this.attrs[k]=v}get isConnected(){return !!this.parent}replaceChildren(){for(const c of this.children)c.parent=null;this.children=[]}get firstElementChild(){return this.children.find(x=>x instanceof E)}remove(){if(this.parent)this.parent.children=this.parent.children.filter(x=>x!==this);this.parent=null}set textContent(t){this.replaceChildren();this.append(new T(String(t)))}get textContent(){return this.children.map(x=>x.textContent).join('')}}
globalThis.document={createElement:t=>new E(t),createTextNode:s=>new T(s)};
const mount=new E('div');const panel=createTracePanel(mount);panel.begin();
panel.event({type:'generating',attempt:1,maxAttempts:3});
panel.event({type:'reasoning',attempt:1,maxAttempts:3,delta:'Думаю над сценой'});
panel.event({type:'token',attempt:1,maxAttempts:3,delta:'<html>unfinished'});
panel.event({type:'validation_failed',attempt:1,maxAttempts:3,errors:['Ответ оборван']});
panel.event({type:'failed',attempt:1,maxAttempts:3,reason:'output_limit',errors:['Ответ оборван']});
const output=mount.textContent;
assert.match(output,/Думаю над сценой/);
assert.match(output,/<html>unfinished/);
assert.match(output,/Достигнут предел генерации/);
assert.doesNotMatch(output,/Повтор без размышлений|Генерация · попытка 2\/3/);
assert.ok(output.indexOf('Ответ оборван') < output.indexOf('Достигнут предел генерации'));
console.log('PASS trace preserves streamed output when output budget is exhausted');
