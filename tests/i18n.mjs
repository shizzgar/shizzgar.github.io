import assert from 'node:assert/strict';
import {createI18n, detectLanguage, LANGUAGE_STORAGE_KEY} from '../i18n.js';

assert.equal(detectLanguage(['fr-CA','ru-RU','en-US']), 'ru');
assert.equal(detectLanguage(['en-US','ru']), 'en');
assert.equal(detectLanguage(['de','fr']), 'en');
assert.equal(detectLanguage('ru_RU'), 'ru');
assert.equal(detectLanguage(null), 'en');

function storage(initial = {}) {
  const data = new Map(Object.entries(initial)), writes = [];
  return {data,writes,getItem:key => data.get(key) ?? null,setItem(key,value) {data.set(key,value);writes.push(['set',key,value]);},removeItem(key) {data.delete(key);writes.push(['remove',key]);}};
}
function target() {
  const listeners = new Map();
  return {listeners,addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:(name,fn)=>{if(listeners.get(name)===fn)listeners.delete(name);},dispatch:name=>listeners.get(name)?.()};
}

let browserLanguages = ['ru-RU','en-US'];
const saved = storage(), events = target();
const i18n = createI18n({languages:()=>browserLanguages,storage:saved,eventTarget:events});
assert.equal(i18n.getLanguage(), 'ru');
assert.equal(i18n.getLanguagePreference(), 'auto');
assert.equal(saved.writes.length, 0, 'autodetection does not create an explicit preference');
const changes = [];
i18n.onLanguageChange(()=>{throw new Error('a failed subscriber');});
const unsubscribe = i18n.onLanguageChange((language,previous,detail)=>changes.push({language,previous,...detail}));
i18n.setLanguage('en');
assert.equal(saved.data.get(LANGUAGE_STORAGE_KEY),'en');
assert.equal(i18n.getLanguageMode(),'en');
browserLanguages=['ru'];events.dispatch('languagechange');
assert.equal(i18n.getLanguage(),'en','explicit preference is not overwritten by browser change');
i18n.setLanguage('auto');
assert.equal(i18n.getLanguage(),'ru');
assert.equal(i18n.getLanguagePreference(),'auto');
assert.equal(saved.data.has(LANGUAGE_STORAGE_KEY),false);
browserLanguages=['en-GB'];events.dispatch('languagechange');
assert.equal(i18n.getLanguage(),'en');
assert.equal(changes.length,3);
i18n.setLanguage('en');
assert.equal(changes.length,4,'changing auto mode to an explicit matching language notifies the selector');
unsubscribe();i18n.setLanguage('ru');assert.equal(changes.length,4);
assert.throws(()=>i18n.setLanguage('de'),RangeError);
i18n.destroy();assert.equal(events.listeners.size,0);

const persisted = createI18n({languages:['ru'],storage:storage({[LANGUAGE_STORAGE_KEY]:'en'}),eventTarget:null});
assert.equal(persisted.getLanguage(),'en');
const malformed=storage({[LANGUAGE_STORAGE_KEY]:'<script>ru</script>'});
assert.equal(createI18n({languages:['ru'],storage:malformed,eventTarget:null}).getLanguagePreference(),'auto');
const denied = {getItem(){throw new Error('denied');},setItem(){throw new Error('denied');},removeItem(){throw new Error('denied');}};
const privacy=createI18n({languages:['ru'],storage:denied,eventTarget:null});
assert.equal(privacy.getLanguage(),'ru');
assert.equal(privacy.setLanguage('en'),'en');
assert.equal(privacy.setLanguage('auto'),'ru');

const ui=createI18n({languages:['en'],storage:null,eventTarget:null});
ui.registerMessages({ru:{hello:'Привет, {name}',hint:'Описание',onlyRu:'Резерв',prompt:'Создай маяк'},en:{hello:'Hello, {name}',hint:'Description',prompt:'Create a lighthouse'}});
assert.equal(ui.t('hello',{name:'<img src=x>'}),'Hello, <img src=x>');
assert.equal(ui.t('onlyRu'),'Резерв');
assert.equal(ui.t('missing.key'),'missing.key');
assert.equal(ui.t('hello'),'Hello, {name}');
assert.equal(ui.formatNumber(1234.5),'1,234.5');
assert.equal(ui.formatBytes(1536),'1.5 KiB');
assert.equal(ui.formatBytes(-1),'0 B');
assert.equal(ui.formatBytes(0.5),'1 B');
assert.equal(ui.formatDateTime('bad'),'—');
assert.match(ui.formatDateTime('2026-11-03T00:00:00Z',{year:'numeric',timeZone:'UTC'}),/2026/);

const doc={documentElement:{lang:''}};
const attrs=new Map([['data-i18n','hello'],['data-i18n-args',JSON.stringify({name:'<img src=x>'})],['data-i18n-title','hint'],['data-i18n-placeholder','hint'],['data-i18n-aria-label','hint'],['data-i18n-alt','hint'],['data-i18n-prompt','prompt']]);
const element={ownerDocument:doc,textContent:'',getAttribute:key=>attrs.get(key)??null,setAttribute:(key,value)=>attrs.set(key,value)};
const root={documentElement:doc.documentElement,querySelectorAll:()=>[element]};
ui.applyTranslations(root);
assert.equal(element.textContent,'Hello, <img src=x>','interpolation is text, never interpreted as markup');
for(const name of ['title','placeholder','aria-label','alt']) assert.equal(attrs.get(name),'Description');
assert.equal(attrs.get('data-prompt'),'Create a lighthouse');
assert.equal(doc.documentElement.lang,'en');
const metaAttrs=new Map([['data-i18n-content','hint']]);
const meta={ownerDocument:doc,getAttribute:key=>metaAttrs.get(key)??null,setAttribute:(key,value)=>metaAttrs.set(key,value)};
ui.applyTranslations({querySelectorAll:()=>[meta]});assert.equal(metaAttrs.get('content'),'Description');
ui.setLanguage('ru');ui.applyTranslations(root);
assert.equal(element.textContent,'Привет, <img src=x>');
assert.equal(doc.documentElement.lang,'ru');
assert.equal(ui.formatBytes(1536),'1,5 КиБ');
assert.match(ui.formatNumber(1234.5),/^1\s234,5$/u);
assert.doesNotThrow(()=>ui.applyTranslations(null));
assert.doesNotThrow(()=>ui.applyTranslations({querySelectorAll:()=>[]}));
ui.registerMessages({en:{guide:'Use <code>{command}</code>.'},ru:{guide:'Команда <code>{command}</code>.'}});
ui.setLanguage('en');
const htmlAttrs=new Map([['data-i18n-html','guide'],['data-i18n-args',JSON.stringify({command:'<img src=x onerror="bad">'})]]);
const rich={ownerDocument:doc,innerHTML:'',textContent:'',getAttribute:key=>htmlAttrs.get(key)??null,setAttribute(){}};
ui.applyTranslations({querySelectorAll:()=>[rich]});
assert.equal(rich.innerHTML,'Use <code>&lt;img src=x onerror=&quot;bad&quot;&gt;</code>.');
htmlAttrs.set('data-i18n-html','<img src=x>');rich.innerHTML='';ui.applyTranslations({querySelectorAll:()=>[rich]});
assert.equal(rich.innerHTML,'','unknown HTML keys are not interpreted as markup');assert.equal(rich.textContent,'<img src=x>');
console.log('PASS language autodetection, explicit/auto preferences, denied storage, live updates, safe DOM translations and formatting');
