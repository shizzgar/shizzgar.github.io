import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { validateScene } from '../sandbox-runner.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const listeners = new Set();
globalThis.window = {
  addEventListener(type, fn) { if (type === 'message') listeners.add(fn); },
  removeEventListener(type, fn) { if (type === 'message') listeners.delete(fn); },
};

async function run(errors) {
  const frame = {
    isConnected: true,
    contentWindow: {},
    setAttribute() {},
    set srcdoc(value) {
      if (!value) return;
      const nonce = value.match(/const nonce = "([0-9a-f]+)"/)?.[1];
      assert.ok(nonce);
      const send = (type, payload) => {
        for (const listener of listeners) listener({source:frame.contentWindow, data:{channel:'forma-runner-v1', nonce, type, payload}});
      };
      queueMicrotask(() => {
        for (const error of errors) send('error', error);
        send('ready', {canvasCount:1, visibleCanvasCount:1, webglContexts:0, drawCalls:0, drawObservationAvailable:false});
      });
    },
  };
  return validateScene({iframe:frame, html:'<html><body></body></html>'});
}

const lost = await run([{kind:'webgl-context-lost', message:'Потерян контекст WebGL; устройство или браузер не смогли продолжить отрисовку.'}]);
assert.equal(lost.ok, false);
assert.equal(lost.retryable, false);
assert.equal(lost.contextLost, true);
assert.equal(lost.infrastructureErrorOther, false);
assert.match(lost.errors.join(' '), /Потерян контекст WebGL/);
assert.doesNotMatch(lost.errors.join(' '), /не создала|не обнаружен/);

const missing = await run([]);
assert.equal(missing.ok, false);
assert.equal(missing.retryable, true);
assert.equal(missing.contextLost, false);
assert.equal(missing.infrastructureErrorOther, false);
assert.match(missing.errors.join(' '), /Активный WebGL-контекст не обнаружен/);

const mixed = await run([
  {kind:'webgl-context-lost', message:'Потерян контекст WebGL'},
  {kind:'resource', message:'Не удалось загрузить Three.js', source:'https://cdnjs.cloudflare.com/ajax/libs/three.js/0.160.0/three.module.min.js'},
]);
assert.equal(mixed.contextLost, true);
assert.equal(mixed.infrastructureErrorOther, true);
assert.equal(mixed.retryable, false);

const missingLibrary = await run([{kind:'resource', message:'Не удалось загрузить Three.js', source:'https://cdnjs.cloudflare.com/ajax/libs/three.js/0.160.0/three.module.min.js'}]);
assert.equal(missingLibrary.contextLost, false);
assert.equal(missingLibrary.infrastructureErrorOther, true);
assert.equal(missingLibrary.retryable, false);

const saturated = await run([
  ...Array.from({length:12}, (_,i) => ({kind:'console', message:`ошибка шейдера ${i}`})),
  {kind:'webgl-context-lost', message:'Потерян контекст WebGL'},
]);
assert.equal(saturated.contextLost, true, 'a burst of earlier errors must not hide context loss');
assert.equal(saturated.retryable, false);
assert.equal(saturated.errors.length, 13, 'reports remain bounded with one reserved loss signal');
console.log('PASS distinguishes lost WebGL context from no active context without changing retry policy');
