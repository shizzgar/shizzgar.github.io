import assert from 'node:assert/strict';
import {createTracePanel} from '../trace-panel.js';

class TextNode {
  constructor(value=''){this.data=value;this.parent=null;}
  appendData(value){this.data+=value;}
  get textContent(){return this.data;}
  set textContent(value){this.data=String(value);}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(x=>x!==this);this.parent=null;}
}
const visibleSize = node => {
  if(node instanceof TextNode)return node.data.length;
  const children=node.tag==='details'&&!node.open?node.children.slice(0,1):node.children;
  return children.reduce((sum,child)=>sum+visibleSize(child),0)+8;
};
class Element {
  constructor(tag){this.tag=tag;this.children=[];this.parent=null;this.attrs={};this.style={};this.dataset={};this.className='';this.open=false;this.scrollTop=0;this.clientHeight=100;}
  append(...items){for(const item of items){if(item.parent)item.remove();item.parent=this;this.children.push(item);}}
  replaceChildren(){for(const child of this.children)child.parent=null;this.children=[];}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(x=>x!==this);this.parent=null;}
  setAttribute(name,value){this.attrs[name]=String(value);}
  get firstElementChild(){return this.children.find(x=>x instanceof Element);}
  get isConnected(){return Boolean(this.parent);}
  set textContent(value){this.replaceChildren();this.append(new TextNode(String(value)));}
  get textContent(){return this.children.map(x=>x.textContent).join('');}
  get scrollHeight(){return 400+visibleSize(this);}
  closest(selector){if(selector!=='.conversation-body')return null;for(let node=this;node;node=node.parent)if(node.className==='conversation-body')return node;return null;}
}
globalThis.document={documentElement:{lang:'en'},createElement:tag=>new Element(tag),createTextNode:value=>new TextNode(value)};

for(const explicit of [true,false]){
  const container=new Element('div');container.className='conversation-body';
  const mount=new Element('div');container.append(mount);
  const panel=createTracePanel(mount,explicit?{scrollContainer:container}:{});
  container.scrollTop=container.scrollHeight-container.clientHeight;
  panel.begin();
  assert.equal(container.scrollTop,container.scrollHeight-container.clientHeight,'opening the trace follows only a reader who was at the end');
  panel.event({type:'generating',attempt:1,maxAttempts:3});
  panel.stage('New stage','Details that extend the conversation');
  assert.equal(container.scrollTop,container.scrollHeight-container.clientHeight,'new events follow the external conversation');
  container.scrollTop=0;
  panel.stage('Later stage','More content');
  assert.equal(container.scrollTop,0,'a reader above the end is not moved by an event');
  container.scrollTop=container.scrollHeight-container.clientHeight;
  panel.event({type:'token',attempt:1,maxAttempts:3,delta:'First streamed chunk'});
  assert.equal(container.scrollTop,container.scrollHeight-container.clientHeight,'stream growth follows the outer scroll');
  container.scrollTop=0;
  panel.event({type:'token',attempt:1,maxAttempts:3,delta:'A later streamed chunk'});
  assert.equal(container.scrollTop,0,'streaming does not steal the reader position');
  panel.begin({preserve:true});
  assert.equal(container.scrollTop,0,'a new run does not move a reader reviewing prior output');
}
console.log('PASS trace follows the external conversation only near its end');
