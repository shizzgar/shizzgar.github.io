import assert from 'node:assert/strict';
import {translateShell, createShellTextManager} from '../app-language.js';
import {setLanguage} from '../i18n.js?v=20261103-recovery-5';
import {planValidationRecovery} from '../recovery-policy.js';

setLanguage('en', {persist:false});
assert.equal(translateShell('Модель не загружена'), 'Model not loaded');
assert.equal(translateShell('Модель: текст · GPU запрошен'), 'Model: text · GPU requested');
assert.equal(translateShell('Пишу код · попытка 2/3 · 1234 символов'), 'Writing code · attempt 2/3 · 1234 characters');
assert.equal(translateShell('Инициализация: GPU запрошен, контекст 262 144 токенов…'), 'Initializing: GPU requested, context 262 144 tokens…');
assert.match(translateShell('Окно браузера: адаптер доступен; shader-f16: доступен.'), /^Browser window: adapter available; shader-f16: available\.$/);
const driver = 'TypeError: userShader.value is undefined\n    at render (about:srcdoc:123:4)';
assert.equal(translateShell(driver), driver, 'raw model/browser error remains unchanged');
const prompt = 'Построй дом с надписью «Модель не загружена»';
assert.equal(translateShell(prompt), prompt, 'unknown user text is not translated');
const code = 'const label = "Модель не загружена";\nconsole.log(label);';
assert.equal(translateShell(code), code, 'generated source is not translated');
assert.equal(translateShell('Браузер или устройство потеряло контекст WebGL: Driver-X'), 'The browser or device lost its WebGL context: Driver-X');
assert.equal(translateShell('Ожидаю активную вкладку'), 'Waiting for the active tab');
assert.equal(translateShell('Проверяю сцену · предварительный результат'), 'Checking the scene · preliminary result');
assert.equal(translateShell('Сцена восстановлена повторным запуском без новой генерации.'), 'The scene was restored by restarting, without model generation.');
assert.equal(translateShell('WebGL: INVALID_OPERATION (1282). Ошибка зафиксирована после запуска сцены.'), 'WebGL: INVALID_OPERATION (1282). The error was observed after scene startup.');
const unrecognizedGl = 'WebGL: custom application payload';
assert.equal(translateShell(unrecognizedGl), unrecognizedGl, 'unknown WebGL output is not rewritten');
assert.equal(translateShell('Сцена восстановлена повторным запуском без новой генерации. Замечание проверки: TypeError: rawValue'), 'The scene was restored by restarting, without model generation. Validation note: TypeError: rawValue');
const noFrame={ok:false,evidence:{visibleCanvasCount:1,webglContexts:1,drawCalls:0,drawObservationAvailable:true}};
for (const scheduler of [undefined,{requested:1,callbacks:0,pending:1},{requested:2,callbacks:1,pending:1},{requested:1,callbacks:0,pending:1,documentVisibility:'hidden'}]) {
  const diagnosis=planValidationRecovery({...noFrame,evidence:{...noFrame.evidence,scheduler}},{presentationRetries:1}).diagnosis;
  assert.equal(typeof diagnosis,'string');
  assert.doesNotMatch(translateShell(diagnosis),/[А-Яа-я]/,'known recovery diagnostics are translated');
  assert.equal(translateShell(diagnosis,'ru'),diagnosis,'the original recovery diagnostic is preserved in Russian');
}

const node = {textContent:'', attrs:{}, setAttribute(name,value) {this.attrs[name]=value;}};
const manager = createShellTextManager();
manager.set(node, 'Предыдущая сцена восстановлена');
assert.equal(node.textContent, 'Previous scene restored');
assert.equal(manager.source(node), 'Предыдущая сцена восстановлена');
manager.attribute(node, 'title', 'Проверка 3D-сцены');
assert.equal(node.attrs.title, '3D scene check');
setLanguage('ru', {persist:false}); manager.refresh();
assert.equal(node.textContent, 'Предыдущая сцена восстановлена');
assert.equal(node.attrs.title, 'Проверка 3D-сцены');
assert.equal(translateShell(driver), driver);
console.log('PASS shell localization, raw data preservation and live status refresh');
