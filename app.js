import { loadModel, loadLocalModel, setLocalProjector, ensureVision, generate, getModelState } from './inference.js';
import { checkConnectivity } from './diagnostics.js';

const $ = (id) => document.getElementById(id);
const ui = Object.fromEntries(['load-model','model-status','model-progress','chat-log','prompt-form','prompt-input','image-input','image-chip','image-preview','image-name','remove-image','generate-button','preview-frame','preview-empty','preview-status','error-panel','error-text','download-html','copy-html','reset-scene','model-files','projector-file','load-local','check-connectivity','connectivity-result'].map(id => [id, $(id)]));
let scene = '';
let image = null;
let imageUrl = null;
let busy = false;

function error(message) {
  ui['error-text'].textContent = message;
  ui['error-panel'].hidden = !message;
}
function appendMessage(label, message) {
  const wrap = document.createElement('div');
  wrap.className = 'welcome-message';
  const avatar = document.createElement('span'); avatar.className = 'message-avatar'; avatar.textContent = label === 'ТЫ' ? '↗' : '✳';
  const content = document.createElement('div');
  const heading = document.createElement('div'); heading.className = 'message-label'; heading.textContent = label;
  const body = document.createElement('p'); body.textContent = message;
  content.append(heading, body); wrap.append(avatar, content); ui['chat-log'].append(wrap);
  ui['chat-log'].scrollTop = ui['chat-log'].scrollHeight;
  return body;
}
function setBusy(value) {
  busy = value;
  ui['generate-button'].disabled = value;
  ui['load-model'].disabled = value || getModelState().loaded;
  ui['load-local'].disabled = value;
  ui['model-files'].disabled = value;
  ui['projector-file'].disabled = value;
  ui['image-input'].disabled = value;
}
function updateProgress({loaded, total}) {
  if (total > 0) ui['model-progress'].value = Math.min(100, loaded / total * 100);
  else ui['model-progress'].removeAttribute('value');
}
function extractHTML(output) {
  const match = output.match(/<!doctype\s+html[\s\S]*?<\/html\s*>/i) || output.match(/<html(?:\s[^>]*)?>[\s\S]*?<\/html\s*>/i);
  if (!match) throw new Error('Модель не вернула полный HTML-документ. Попробуй ещё раз с более простым запросом.');
  return match[0];
}
function showScene(html) {
  // Insert restrictions before the document is parsed in the sandbox.
  const policy = "default-src 'none'; script-src 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none';";
  const bridge = `addEventListener('error', e => parent.postMessage({type:'forma-preview-error', message:String(e.message || 'Ошибка загрузки сцены').slice(0,500)}, '*')); addEventListener('unhandledrejection', e => parent.postMessage({type:'forma-preview-error', message:String(e.reason?.message || e.reason).slice(0,500)}, '*'));`;
  const prefix = `<meta http-equiv="Content-Security-Policy" content="${policy}"><script>${bridge}<\/script>`;
  ui['preview-frame'].srcdoc = '<!doctype html>' + prefix + html.replace(/^\s*<!doctype\s+html[^>]*>/i, '');
  ui['preview-frame'].hidden = false;
  ui['preview-empty'].hidden = true;
  ui['preview-status'].textContent = 'Сцена загружена · можно вращать';
  ui['download-html'].disabled = false; ui['copy-html'].disabled = false;
}
window.addEventListener('message', event => {
  if (event.source !== ui['preview-frame'].contentWindow || !event.data || event.data.type !== 'forma-preview-error' || typeof event.data.message !== 'string') return;
  ui['preview-status'].textContent = 'Ошибка в коде сцены';
  error(`Ошибка сцены: ${event.data.message.slice(0, 500)}. Попроси модель исправить её следующим сообщением.`);
});
ui['load-model'].addEventListener('click', async () => {
  if (busy) return;
  setBusy(true); error(''); ui['model-progress'].hidden = false;
  ui['model-progress'].removeAttribute('value');
  try {
    await loadModel({
      onStatus: text => { ui['model-status'].textContent = text; },
      onProgress: updateProgress,
    });
    ui['model-status'].textContent = 'Готова для текста';
    ui['load-model'].textContent = 'Готово ✓';
    ui['model-progress'].value = 100;
    appendMessage('FORMA · МОДЕЛЬ ГОТОВА', 'Опиши сцену. Для первого запроса с картинкой понадобится дополнительная загрузка.');
  } catch (e) {
    ui['model-status'].textContent = 'Не удалось загрузить модель';
    ui['model-progress'].hidden = true;
    error(e?.message || String(e));
  } finally { setBusy(false); }
});
ui['check-connectivity'].addEventListener('click', async () => {
  const button = ui['check-connectivity'];
  const output = ui['connectivity-result'];
  button.disabled = true; output.hidden = false; output.textContent = 'Проверяем доступ с твоего устройства…';
  try {
    const results = await checkConnectivity();
    output.textContent = results.map(item => `${item.label}: ${item.status === 'ok' ? 'доступен' : 'не удалось проверить'} — ${item.detail}`).join('\n') + '\nЭто проверка соединения, а не гарантия полной загрузки.';
  } catch (e) { output.textContent = `Не удалось выполнить проверку: ${e?.message || String(e)}`; }
  finally { button.disabled = false; }
});
ui['load-local'].addEventListener('click', async () => {
  if (busy) return;
  setBusy(true); error('');
  ui['model-progress'].hidden = false; ui['model-progress'].removeAttribute('value');
  try {
    const result = await loadLocalModel(ui['model-files'].files, ui['projector-file'].files?.[0] || null, {
      onStatus: text => { ui['model-status'].textContent = text; },
    });
    ui['model-progress'].hidden = true;
    ui['load-model'].textContent = 'Готово ✓';
    ui['model-status'].textContent = result.vision ? 'Локальная модель: текст и картинки' : 'Локальная модель: текст';
    appendMessage('FORMA · ЛОКАЛЬНАЯ МОДЕЛЬ', result.vision ? 'Можно описать сцену или приложить картинку.' : 'Можно создавать сцены по тексту. Для картинки выбери файл mmproj в разделе своих файлов.');
  } catch (e) {
    ui['model-progress'].hidden = true;
    if (!getModelState().loaded) { ui['model-status'].textContent = 'Модель не загружена'; ui['load-model'].textContent = 'Загрузить ↗'; }
    else { ui['model-status'].textContent = getModelState().vision ? 'Готова для текста и картинок' : 'Готова для текста'; }
    error(e?.message || String(e));
  } finally { setBusy(false); }
});
ui['prompt-form'].addEventListener('submit', async event => {
  event.preventDefault();
  if (busy) return;
  const prompt = ui['prompt-input'].value.trim();
  if (!prompt) return;
  if (!getModelState().loaded) { error('Сначала загрузи модель кнопкой выше.'); return; }
  error(''); setBusy(true); appendMessage('ТЫ', prompt + (image ? ' · с референсом' : ''));
  const status = appendMessage('FORMA · СОЗДАЮ', 'Готовлю сцену…');
  ui['preview-status'].textContent = 'Генерирую сцену…';
  try {
    if (image && !getModelState().vision) {
      if (getModelState().mode === 'local') {
        const projector = ui['projector-file'].files?.[0];
        if (!projector) throw new Error('Для картинки выбери файл mmproj в разделе «Свои файлы модели».');
        await setLocalProjector(projector);
      }
      status.textContent = 'Загружаю компонент для картинок и перезапускаю модель…';
      ui['model-progress'].hidden = false;
      ui['model-progress'].removeAttribute('value');
      await ensureVision({onStatus: text => { ui['model-status'].textContent = text; }, onProgress: updateProgress});
      ui['model-progress'].value = 100;
    }
    const output = await generate({prompt, image, previousCode: scene,
      onToken: (_delta, full) => { status.textContent = `Генерирую код сцены… ${full.length} символов`; },
    });
    const html = extractHTML(output);
    scene = html; showScene(scene);
    status.textContent = 'Готово! Можешь попросить изменить сцену или скачать HTML.';
    ui['prompt-input'].value = '';
    clearImage();
  } catch (e) {
    status.textContent = 'Не получилось создать сцену.';
    ui['preview-status'].textContent = scene ? 'Предыдущая сцена сохранена' : 'Сцена пока не создана';
    ui['model-progress'].hidden = true;
    if (!getModelState().loaded) {
      ui['model-status'].textContent = 'Модель не загружена';
      ui['load-model'].textContent = 'Загрузить ↗';
    } else {
      ui['model-status'].textContent = getModelState().vision ? 'Готова для текста и картинок' : 'Готова для текста';
    }
    error(e?.message || String(e));
  } finally { setBusy(false); }
});
function clearImage() {
  image = null; ui['image-input'].value = ''; ui['image-chip'].hidden = true;
  if (imageUrl) URL.revokeObjectURL(imageUrl); imageUrl = null;
  ui['image-preview'].removeAttribute('src');
}
ui['image-input'].addEventListener('change', event => {
  const file = event.target.files?.[0]; if (!file) return;
  if (!['image/jpeg','image/png','image/webp'].includes(file.type)) { clearImage(); error('Поддерживаются JPG, PNG и WEBP.'); return; }
  if (file.size > 10 * 1024 * 1024) { clearImage(); error('Изображение должно быть не больше 10 МБ.'); return; }
  error(''); if (imageUrl) URL.revokeObjectURL(imageUrl);
  image = file; imageUrl = URL.createObjectURL(file);
  ui['image-preview'].src = imageUrl; ui['image-name'].textContent = file.name; ui['image-chip'].hidden = false;
});
ui['remove-image'].addEventListener('click', clearImage);
document.querySelectorAll('[data-prompt]').forEach(button => button.addEventListener('click', () => { ui['prompt-input'].value = button.dataset.prompt; ui['prompt-input'].focus(); }));
ui['reset-scene'].addEventListener('click', () => {
  scene = ''; ui['preview-frame'].srcdoc = ''; ui['preview-frame'].hidden = true; ui['preview-empty'].hidden = false;
  ui['preview-status'].textContent = 'Твоя сцена появится здесь'; ui['download-html'].disabled = true; ui['copy-html'].disabled = true; error('');
});
ui['download-html'].addEventListener('click', () => {
  if (!scene) return;
  const url = URL.createObjectURL(new Blob([scene], {type: 'text/html;charset=utf-8'}));
  const a = document.createElement('a'); a.href = url; a.download = 'forma-scene.html'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
ui['copy-html'].addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(scene); ui['copy-html'].textContent = 'Скопировано ✓'; setTimeout(() => { ui['copy-html'].textContent = 'Копировать'; }, 2000); }
  catch { error('Не удалось скопировать код. Используй кнопку HTML для скачивания.'); }
});
