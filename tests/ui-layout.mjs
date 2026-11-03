import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {uiMessages} from '../ui-messages.js';

const html = await readFile(new URL('../index.html', import.meta.url),'utf8');
const css = await readFile(new URL('../styles.css', import.meta.url),'utf8');
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);
assert.equal(ids.length,new Set(ids).size,'DOM IDs must be unique');
for (const id of ['load-model','open-local','model-status','progress-wrap','chat-log','prompt-form','prompt-input','trace-mount','preview-frame','preview-empty','partial-preview','error-panel','download-html','copy-html','reset-scene','hf-token','hf-token-form','model-files','projector-file','load-local','download-bundle','cancel-bundle','download-files','retry-unverified','download-unverified']) {
  assert(ids.includes(id),'preserve functional id '+id);
}
for (const m of html.matchAll(/\bdata-i18n(?:-[a-z-]+)?="([^"]+)"/g)) {
  assert.equal(typeof uiMessages.ru[m[1]],'string','Russian static copy: '+m[1]);
  assert.equal(typeof uiMessages.en[m[1]],'string','English static copy: '+m[1]);
}
assert.match(html,/<dialog[^>]+id="model-settings-panel"/,'settings are a native modal outside the work panels');
assert(html.indexOf('</main>')<html.indexOf('<dialog'),'settings do not consume workspace space');
const scrollStart=html.indexOf('id="conversation-scroll"');
const trace=html.indexOf('id="trace-mount"');
const composer=html.indexOf('id="prompt-form"');
assert(scrollStart<trace && trace<composer,'trace and history precede fixed composer');
for (const id of ['language-select','mobile-chat-tab','mobile-scene-tab','mobile-stop-agent','model-settings-toggle','model-settings-close']) assert(ids.includes(id),id);
assert.match(css,/\.conversation-body\{[^}]*min-height:0[^}]*overflow:auto/,'the shared transcript can scroll within the viewport');
assert.match(css,/\.workspace\[data-view=chat\] \.stage\{display:none\}/,'mobile scene selection');
assert.match(css,/\.workspace\[data-view=scene\] \.conversation\{display:none\}/,'mobile chat selection');
assert.match(css,/\[hidden\]\{display:none!important\}/,'hidden result and modal states remain hidden');
console.log('PASS compact workspace structure, preserved controls, mobile navigation and complete static RU/EN copy');

