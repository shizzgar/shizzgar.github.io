import { loadModel, loadLocalModel, setLocalProjector, ensureVision, generate, suspendModel, resumeModel, getModelState, getLoadedContextInfo } from './inference.js?v=20261103-recovery-5';
import { checkConnectivity, checkWebGPU } from './diagnostics.js?v=20261103-recovery-5';
import { probeInferenceWebGPU } from './webgpu-inference-probe.js?v=20261103-recovery-5';
import { createBundle } from './bundle-download.js?v=20261103-recovery-5';
import { runAgent } from './agent-loop.js?v=20261103-recovery-5';
import { planValidationRecovery } from './recovery-policy.js?v=20261103-recovery-5';
import { validateScene, disposeScene, releaseScene } from './sandbox-runner.js?v=20261103-recovery-5';
import { probeWebGLRecovery } from './webgl-recovery.js?v=20261103-recovery-5';
import { createTracePanel } from './trace-panel.js?v=20261103-recovery-5';
import { createProfiler } from './profiling-ui.js?v=20261103-recovery-5';
import { getLanguage, getLanguageMode, setLanguage, onLanguageChange, registerMessages, applyTranslations } from './i18n.js?v=20261103-recovery-5';
import { uiMessages } from './ui-messages.js?v=20261103-recovery-5';
import { translateShell, createShellTextManager } from './app-language.js?v=20261103-recovery-5';

registerMessages(uiMessages);
applyTranslations();
const shellText = createShellTextManager();
const setShellText = (node, value) => shellText.set(node, value);

const $ = (id) => document.getElementById(id);
const ui = Object.fromEntries(['load-model','open-local','local-files','hf-token','model-status','model-progress','progress-wrap','progress-track','model-progress-detail','chat-log','prompt-form','prompt-input','image-input','image-chip','image-preview','image-name','remove-image','generate-button','stop-agent','agent-thinking','trace-mount','preview-frame','preview-empty','partial-preview','preview-status','error-panel','error-text','download-html','download-unverified','retry-unverified','unverified-note','copy-html','reset-scene','model-files','projector-file','load-local','check-connectivity','connectivity-result','download-bundle','cancel-bundle','bundle-result','download-files'].map(id => [id, $(id)]));
// The token is never stored by the app; discard any value restored by the browser.
ui['hf-token'].value = '';
// The form is present for browser password-field semantics, not submission.
$('hf-token-form').addEventListener('submit', event => event.preventDefault());
const secret = () => ui['hf-token'].value.trim();
const redact = value => { const text = String(value ?? ''); const token = secret(); return token ? text.split(token).join('[скрыто]') : text; };
const trace = createTracePanel(ui['trace-mount'], {redact, getSecret:secret, language:getLanguage(), translate:translateShell, scrollContainer:$('conversation-scroll')});
const profiler = createProfiler(trace);
// Probe browser capabilities before the user commits to downloading the model.
// This only reads local WebGPU/WebGL information; a failure must not prevent
// loading or using the application.
void profiler.run().catch(() => {});
let scene = '';
// Separate from the last accepted scene: a complete model response can be
// useful to the user even if execution checks fail or a later repair aborts.
let unverifiedHtml = '';
let unverifiedContext = null;
let image = null;
let imageUrl = null;
let busy = false;
let agentController = null;
let activeScene = null;
let lastProgress = null;
let bundleActive = false;
let bundleStage = '';

function setWorkspaceView(view) {
  const workspace = $('workspace');
  if (workspace) workspace.dataset.view = view === 'scene' ? 'scene' : 'chat';
  for (const [id, value] of [['mobile-chat-tab','chat'], ['mobile-scene-tab','scene']]) {
    const button = $(id);
    if (!button) continue;
    button.setAttribute('aria-selected', String(value === view));
    button.tabIndex = value === view ? 0 : -1;
  }
}
let settingsReturnFocus = null;
function openModelSettings() {
  const panel = $('model-settings-panel');
  if (!panel || panel.open) return;
  settingsReturnFocus = document.activeElement;
  if (typeof panel.showModal === 'function') panel.showModal();
  else panel.open = true;
}
function closeModelSettings() {
  const panel = $('model-settings-panel');
  if (!panel?.open) return;
  if (typeof panel.close === 'function') panel.close();
  else { panel.open = false; settingsReturnFocus?.focus?.(); }
}
function refreshModelControls() {
  const state = getModelState();
  const ready = state.loaded || state.suspended;
  ui['generate-button'].disabled = busy || !ready;
  shellText.attribute(ui['prompt-input'], 'placeholder', ready ? 'Опиши сцену или что изменить…' : 'Загрузи модель, чтобы начать…');
}
function syncMobileStop() {
  const button = $('mobile-stop-agent');
  if (!button) return;
  button.hidden = ui['stop-agent'].hidden;
  button.disabled = ui['stop-agent'].disabled;
  setShellText(button, shellText.source(ui['stop-agent']) || 'Остановить');
}
function refreshLanguage() {
  applyTranslations();
  shellText.refresh();
  trace.setLanguage?.(getLanguage());
  const selector = $('language-select');
  if (selector) selector.value = getLanguageMode();
  if (!busy) updateModelStatus();
  refreshModelControls();
  syncMobileStop();
  if (lastProgress && !ui['progress-wrap'].hidden) updateProgress(lastProgress);
  renderBundleStatus();
  if (ui['preview-frame']) ui['preview-frame'].title = translateShell('Предпросмотр сгенерированной 3D-сцены');
}
$('language-select')?.addEventListener('change', event => setLanguage(event.target.value));
onLanguageChange(refreshLanguage);
$('model-settings-toggle')?.addEventListener('click', openModelSettings);
$('model-settings-close')?.addEventListener('click', closeModelSettings);
$('model-settings-panel')?.addEventListener('close', () => settingsReturnFocus?.focus?.());
$('model-settings-panel')?.addEventListener('click', event => {
  const panel = event.currentTarget;
  if (event.target !== panel || !panel?.open || !panel.getBoundingClientRect) return;
  const bounds = panel.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeModelSettings();
});
for (const [id, view] of [['mobile-chat-tab','chat'], ['mobile-scene-tab','scene']]) {
  $(id)?.addEventListener('click', () => setWorkspaceView(view));
  $(id)?.addEventListener('keydown', event => {
    if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' || event.key === 'ArrowLeft' ? 'chat' : 'scene';
    setWorkspaceView(next);
    $(next === 'chat' ? 'mobile-chat-tab' : 'mobile-scene-tab')?.focus();
  });
}
setWorkspaceView('chat');
setShellText(ui['model-status'], 'Модель не загружена');
setShellText(ui['preview-status'], 'Твоя сцена появится здесь');
setShellText(ui['stop-agent'], 'Остановить');
setShellText(ui['copy-html'], 'Копировать');
refreshLanguage();

function error(message) {
  setShellText(ui['error-text'], redact(message || ''));
  ui['error-panel'].hidden = !message;
}
function appendMessage(label, message, {raw = false, attachment = false} = {}) {
  const scroll = $('conversation-scroll') || ui['chat-log'];
  const follow = label === 'ТЫ' || (scroll.scrollHeight || 0) - (scroll.scrollTop || 0) - (scroll.clientHeight || 0) < 96;
  const wrap = document.createElement('div');
  wrap.className = 'welcome-message';
  const avatar = document.createElement('span'); avatar.className = 'message-avatar'; avatar.textContent = label === 'ТЫ' ? '↗' : '✳';
  const content = document.createElement('div');
  const heading = document.createElement('div'); heading.className = 'message-label'; setShellText(heading, label);
  const body = document.createElement('p');
  if (label === 'ТЫ' || raw) body.textContent = message;
  else setShellText(body, message);
  content.append(heading, body); wrap.append(avatar, content); ui['chat-log'].append(wrap);
  if (attachment) {
    const note = document.createElement('span'); note.className = 'message-attachment';
    setShellText(note, 'Изображение-референс прикреплено'); content.append(note);
  }
  if (follow) scroll.scrollTop = scroll.scrollHeight;
  return body;
}
function setBusy(value) {
  busy = value;
  refreshModelControls();
  ui['load-model'].disabled = value || getModelState().loaded || getModelState().suspended;
  ui['open-local'].disabled = value;
  ui['load-local'].disabled = value;
  ui['download-bundle'].disabled = value;
  ui['model-files'].disabled = value;
  ui['projector-file'].disabled = value;
  ui['hf-token'].disabled = value;
  ui['agent-thinking'].disabled = value;
  ui['image-input'].disabled = value;
  ui['reset-scene'].disabled = value;
  ui['copy-html'].disabled = value || !scene;
  ui['download-html'].disabled = value || !scene;
  ui['download-unverified'].disabled = value || !unverifiedHtml;
  ui['retry-unverified'].disabled = value || !unverifiedHtml;
  ui['unverified-note'].hidden = value || !unverifiedHtml;
  syncMobileStop();
  if (!value) schedulePendingRepair();
}
function retainUnverified(html, session = {}) {
  if (typeof html !== 'string' || !html.trim()) return;
  unverifiedHtml = html;
  unverifiedContext = {prompt:session.prompt || '', reference:session.reference || null};
  ui['unverified-note'].hidden = busy;
  ui['download-unverified'].disabled = busy;
  ui['retry-unverified'].disabled = busy;
}
function clearUnverified() {
  unverifiedHtml = '';
  unverifiedContext = null;
  ui['unverified-note'].hidden = true;
  ui['download-unverified'].disabled = true;
  ui['retry-unverified'].disabled = true;
}
function requestStop() {
  if (!agentController) return;
  agentController.abort();
  ui['stop-agent'].disabled = true;
  setShellText(ui['stop-agent'], 'Останавливаю…');
  syncMobileStop();
  trace.stage('Остановка запрошена', 'Если компонент модели ещё загружается, остановка произойдёт после текущего этапа.');
}
ui['stop-agent'].addEventListener('click', requestStop);
$('mobile-stop-agent')?.addEventListener('click', requestStop);
function openDetailsAncestors(element) {
  for (let parent = element?.parentElement; parent; parent = parent.parentElement) {
    if (parent.tagName?.toLowerCase() === 'details') parent.open = true;
  }
}
ui['open-local'].addEventListener('click', () => {
  if (busy) return;
  openModelSettings();
  openDetailsAncestors(ui['local-files']);
  ui['local-files'].open = true;
  ui['open-local'].setAttribute('aria-expanded', 'true');
  ui['model-files'].focus();
});
ui['local-files'].addEventListener('toggle', () => {
  ui['open-local'].setAttribute('aria-expanded', String(ui['local-files'].open));
});
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return getLanguage() === 'en' ? '0 B' : '0 Б';
  const units = getLanguage() === 'en' ? ['B', 'KiB', 'MiB', 'GiB'] : ['Б', 'КиБ', 'МиБ', 'ГиБ'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / (1024 ** index);
  return `${index === 0 ? Math.floor(value) : value.toFixed(1)} ${units[index]}`;
}
function updateModelStatus() {
  const state = getModelState();
  if (state.retiring) {
    setShellText(ui['model-status'], 'Не удалось завершить движок · повторим остановку');
    return;
  }
  if (state.suspended) {
    setShellText(ui['model-status'], 'Движок модели остановлен · восстановится перед запросом');
    return;
  }
  if (!state.loaded) return;
  const name = state.mode === 'local' ? 'Локальная модель' : 'Модель';
  const modality = state.vision ? 'текст и картинки' : 'текст';
  let backend = state.backend === 'cpu' ? ' · CPU' : state.backend === 'gpu-requested' ? ' · GPU запрошен' : '';
  if (state.backend === 'gpu-requested') {
    const buffers = getLoadedContextInfo()?.model_buffers;
    if (Array.isArray(buffers)) {
      const hasGpu = buffers.some(item => item?.backend === 'WebGPU' && Number.isFinite(item.mib) && item.mib > 0);
      const hasCpu = buffers.some(item => ['CPU', 'CPU_Mapped'].includes(item?.backend) && Number.isFinite(item.mib) && item.mib > 0);
      const gpuWasReported = buffers.some(item => item?.backend === 'WebGPU');
      if (hasGpu) backend = hasCpu ? ' · веса: WebGPU + CPU (по журналу)' : ' · веса: WebGPU (по журналу)';
      else if (hasCpu && !gpuWasReported) backend = ' · веса: CPU (по журналу)';
    }
  }
  setShellText(ui['model-status'], `${name}: ${modality}${backend}`);
}
function startStage(text) {
  lastProgress = null;
  setShellText(ui['model-status'], text);
  ui['progress-wrap'].hidden = false;
  ui['model-progress'].removeAttribute('value');
  ui['progress-track'].classList.add('indeterminate');
  setShellText(ui['model-progress-detail'], text);
}
function updateProgress({loaded, total, cachedBytes = 0}) {
  lastProgress = {loaded, total, cachedBytes};
  const received = Number.isFinite(loaded) && loaded > 0 ? loaded : 0;
  const cached = Number.isFinite(cachedBytes) && cachedBytes > 0 ? ` · сохранено ${formatBytes(cachedBytes)}` : '';
  const known = Number.isFinite(total) && total > 0 && received <= total;
  ui['progress-wrap'].hidden = false;
  if (known) {
    const percent = Math.min(100, received / total * 100);
    ui['model-progress'].value = percent;
    ui['progress-track'].classList.remove('indeterminate');
    setShellText(ui['model-progress-detail'], `${formatBytes(received)} из ${formatBytes(total)} · ${Math.floor(percent)}%${cached}`);
  } else {
    ui['model-progress'].removeAttribute('value');
    ui['progress-track'].classList.add('indeterminate');
    setShellText(ui['model-progress-detail'], received > 0 ? `Получено ${formatBytes(received)} · общий размер неизвестен${cached}` : 'Ожидание данных…');
  }
}
function finishProgress() {
  lastProgress = null;
  ui['progress-wrap'].hidden = true;
  ui['model-progress'].removeAttribute('value');
  ui['progress-track'].classList.add('indeterminate');
  setShellText(ui['model-progress-detail'], '');
  updateModelStatus();
}
function renderBundleStatus() {
  if (!bundleActive) return;
  const detail = shellText.source(ui['model-progress-detail']);
  setShellText(ui['bundle-result'], bundleStage + (detail && detail !== bundleStage ? `\n${detail}` : ''));
  ui['bundle-result'].hidden = false;
}
ui['download-bundle'].addEventListener('click', async () => {
  if (busy) return;
  error('');
  ui['bundle-result'].hidden = true;
  if (typeof window.showSaveFilePicker !== 'function') {
    openModelSettings();
    openDetailsAncestors(ui['download-files']);
    ui['download-files'].open = true;
    error('Этот браузер не поддерживает сохранение большого ZIP напрямую. Попробуй актуальный Chrome или Edge; ниже доступны отдельные файлы.');
    return;
  }
  const token = ui['hf-token'].value.trim();
  const previousStatus = shellText.source(ui['model-status']);
  setBusy(true);
  let controller;
  try {
    // Must run directly in the click handler to preserve browser user activation.
    const handle = await window.showSaveFilePicker({
      suggestedName: 'forma-3d-coder.zip',
      types: [{ description: translateShell('ZIP архив'), accept: { 'application/zip': ['.zip'] } }],
    });
    bundleActive = true;
    bundleStage = 'Подготавливаем комплект…';
    startStage('Подготавливаем комплект…');
    renderBundleStatus();
    const writable = await handle.createWritable();
    controller = new AbortController();
    ui['cancel-bundle'].hidden = false;
    ui['cancel-bundle'].onclick = () => controller.abort();
    await createBundle({
      writable, token, signal: controller.signal,
      onProgress: data => {
        const stage = data.stage ? String(data.stage) : 'Скачиваем комплект…';
        bundleStage = stage;
        if ((!data.loaded && !data.total) || stage.startsWith('Завершаем')) startStage(stage);
        else { setShellText(ui['model-status'], stage); updateProgress(data); }
        renderBundleStatus();
      },
    });
    bundleActive = false;
    setShellText(ui['bundle-result'], 'ZIP сохранён. Распакуй его перед загрузкой частей в Forma.');
    ui['bundle-result'].hidden = false;
  } catch (e) {
    bundleActive = false;
    if (e?.name === 'AbortError' || controller?.signal.aborted) {
      setShellText(ui['bundle-result'], 'Скачивание отменено.');
      ui['bundle-result'].hidden = false;
    } else {
      error(e?.message || String(e));
      setShellText(ui['bundle-result'], e?.message || String(e));
      ui['bundle-result'].hidden = false;
    }
  } finally {
    bundleActive = false;
    ui['cancel-bundle'].hidden = true;
    ui['cancel-bundle'].onclick = null;
    finishProgress();
    setShellText(ui['model-status'], previousStatus);
    setBusy(false);
  }
});
async function waitForVisibleDocument(signal, status) {
  const isHidden = () => document.hidden === true || document.visibilityState === 'hidden';
  if (signal?.aborted) throw new DOMException('Проверка отменена.', 'AbortError');
  if (!isHidden()) return;
  const message = 'Проверка сцены продолжится, когда вкладка снова станет видимой. HTML сохранён, модель остаётся выгруженной.';
  trace.stage('Ожидаю активную вкладку', message);
  setShellText(ui['preview-status'], 'Ожидаю активную вкладку для проверки сцены');
  if (status) setShellText(status, message);
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      document.removeEventListener('visibilitychange', onVisible);
      signal?.removeEventListener('abort', onAbort);
    };
    const onVisible = () => { if (!isHidden()) { cleanup(); resolve(); } };
    const onAbort = () => { cleanup(); reject(new DOMException('Проверка отменена.', 'AbortError')); };
    document.addEventListener('visibilitychange', onVisible);
    signal?.addEventListener('abort', onAbort, {once:true});
    // Cover a visibility/abort transition between the initial check and hooks.
    if (signal?.aborted) onAbort();
    else onVisible();
  });
}
function createCandidate() {
  // Validate in a real, visible viewport. Fully transparent or hidden opaque
  // iframes can suppress animation frames, which is not a generated-code bug.
  // Keep this iframe in place when accepted: moving it may reload its document.
  const frame = document.createElement('iframe');
  frame.title = translateShell('Проверка 3D-сцены');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  frame.style.opacity = '1';
  frame.style.pointerEvents = 'none';
  frame.style.zIndex = '2';
  ui['preview-frame'].parentElement.appendChild(frame);
  return frame;
}
async function discardCandidate(frame) {
  if (!frame) return;
  try {
    await releaseScene(frame);
  } catch (err) {
    trace.stage('Освобождение сцены', `Не удалось подтвердить освобождение ресурсов: ${err?.message || String(err)}`);
  } finally {
    frame.remove();
  }
}
// Keep the accepted source, but destroy its iframe before allocating a model.
// Hiding an iframe is not enough: it continues to retain the WebGL context.
async function parkScene() {
  if (!scene || !activeScene || activeScene.parked) return;
  const old = ui['preview-frame'];
  const placeholder = document.createElement('iframe');
  placeholder.id = 'preview-frame';
  placeholder.title = translateShell('Предпросмотр 3D-сцены');
  placeholder.hidden = true;
  old.parentElement.appendChild(placeholder);
  await discardCandidate(old);
  ui['preview-frame'] = placeholder;
  activeScene.frame = placeholder;
  activeScene.parked = true;
  setShellText(ui['preview-status'], 'Сцена временно приостановлена для модели');
  trace.stage('Освобождаю ресурсы сцены', 'HTML сохранён; предпросмотр будет восстановлен после генерации.');
}

async function activateModel(signal) {
  if (getModelState().loaded) return;
  if (!getModelState().suspended) throw new Error('Сначала загрузи модель кнопкой выше.');
  trace.stage('Восстанавливаю модель', 'Файлы модели используются повторно; для движка может понадобиться доступ к CDN.');
  startStage('Восстанавливаем модель из сохранённых файлов…');
  try {
    await resumeModel({signal, onStatus:text => {startStage(text); trace.stage(text);}});
    profiler.invalidate();
    await profiler.run().catch(() => {});
  } finally {
    finishProgress();
  }
}

async function pauseModel() {
  const state = getModelState();
  if (!state.loaded && !state.suspended) return;
  // A failed worker exit can leave a retiring worker behind even when the
  // state already reads suspended. Retry exit before starting any renderer.
  if (state.suspended) {
    await suspendModel();
    if (state.retiring) {
      profiler.invalidate();
      await profiler.run().catch(() => {});
      updateModelStatus();
    }
    return;
  }
  trace.stage('Освобождаю ресурсы модели', 'Выгружаю модель перед запуском сцены; её файлы сохранены для следующего запроса.');
  await suspendModel();
  profiler.invalidate();
  await profiler.run().catch(() => {});
  updateModelStatus();
}

async function restorePreviousScene() {
  if (!scene || !activeScene?.parked) return true;
  const session = activeScene;
  const selected = {frame:null};
  try {
    await pauseModel();
    const validation = await agentValidator({status:null, session, selected, retainOnFailure:false})(scene, {});
    if (!validation.ok || !selected.frame) {
      const reason = (validation.errors || []).join('; ') || 'предпросмотр не прошёл проверку';
      setShellText(ui['preview-status'], 'Не удалось восстановить предпросмотр; HTML сохранён');
      trace.stage('Не удалось восстановить предыдущую сцену', reason);
      return false;
    }
    adoptCandidate(selected.frame, scene);
    session.frame = selected.frame;
    session.parked = false;
    selected.frame = null;
    setShellText(ui['preview-status'], 'Предыдущая сцена восстановлена');
    trace.stage('Предыдущая сцена восстановлена', 'HTML запущен повторно.');
    return true;
  } catch (err) {
    setShellText(ui['preview-status'], 'Не удалось восстановить предпросмотр; HTML сохранён');
    trace.stage('Не удалось восстановить предыдущую сцену', err?.message || String(err));
    return false;
  } finally {
    await discardCandidate(selected.frame);
  }
}
function clearPartialPreview() {
  ui['partial-preview'].hidden = true;
  ui['partial-preview'].removeAttribute('src');
}

// A failed scene can sometimes draw a frame before reporting an error. Re-run
// it once only when the last check observed a live WebGL draw. The screenshot
// is local, is not sent to a vision model, and never becomes an accepted scene.
async function showPartialPreview(html, previousEvidence, signal) {
  if (scene || !html || signal?.aborted || !previousEvidence?.drawObservationAvailable ||
      !(previousEvidence.visibleCanvasCount > 0 && previousEvidence.webglContexts > 0 && previousEvidence.drawCalls > 0)) return false;
  let frame = null;
  try {
    await pauseModel();
    if (signal?.aborted || scene) return false;
    frame = createCandidate();
    const result = await validateScene({iframe:frame, html, signal, captureImage:true, settleMs:1500, timeoutMs:8000});
    const e = result?.evidence;
    if (signal?.aborted || scene || !e?.drawObservationAvailable ||
        !(e.visibleCanvasCount > 0 && e.webglContexts > 0 && e.drawCalls > 0) ||
        typeof result.screenshot !== 'string' || !result.screenshot.startsWith('data:image/jpeg;base64,')) return false;
    ui['partial-preview'].src = result.screenshot;
    ui['partial-preview'].hidden = false;
    ui['preview-empty'].hidden = true;
    setShellText(ui['preview-status'], 'Частичный кадр · сцена не прошла проверку');
    setWorkspaceView('scene');
    trace.stage('Частичный кадр', 'Показан статичный кадр; проверка сцены не пройдена и визуальное качество не подтверждено.');
    return true;
  } catch (err) {
    if (err?.name !== 'AbortError') trace.stage('Частичный кадр недоступен', 'Не удалось получить кадр из последнего варианта сцены.');
    return false;
  } finally {
    await discardCandidate(frame);
  }
}
function adoptCandidate(frame, html) {
  const old = ui['preview-frame'];
  disposeScene(old);
  old.remove();
  frame.id = 'preview-frame';
  frame.title = translateShell('Предпросмотр сгенерированной 3D-сцены');
  frame.removeAttribute('aria-hidden');
  frame.removeAttribute('tabindex');
  frame.style.opacity = '1';
  frame.style.pointerEvents = '';
  ui['preview-frame'] = frame;
  clearPartialPreview();
  ui['preview-empty'].hidden = true;
  scene = html;
  setShellText(ui['preview-status'], 'Проверен запуск сцены');
  setWorkspaceView('scene');
}
function agentEvents(status, context, session) {
  return event => {
    if (event.type === 'generating') { context.attempt = event.attempt; context.maxAttempts = event.maxAttempts; }
    // Save the complete document before static checking. If that check fails
    // and a later repair is cancelled, the previous candidate is still useful.
    if (event.type === 'preflight' || event.type === 'unchanged') {
      if (!scene) {
        clearPartialPreview();
        ui['preview-empty'].hidden = false;
      }
      retainUnverified(event.html, session);
      context.fallbackHtml = event.html;
      context.fallbackEvidence = context.fallbackHistory?.get(event.html) || null;
    }
    if (event.type === 'validation_failed' && event.evidence && context.fallbackHtml) {
      context.fallbackHistory ||= new Map();
      context.fallbackHistory.set(context.fallbackHtml, event.evidence);
      context.fallbackEvidence = event.evidence;
    }
    trace.event(event);
    const attempt = `${event.attempt}/${event.maxAttempts}`;
    if (event.type === 'generating') setShellText(status, `Создаю сцену · попытка ${attempt}…`);
    if (event.type === 'token') setShellText(status, `Пишу код · попытка ${attempt} · ${event.length} символов`);
    if (event.type === 'preflight') setShellText(status, `Проверяю структуру кода · попытка ${attempt}…`);
    if (event.type === 'validating') setShellText(status, `Запускаю сцену и проверяю ошибки · попытка ${attempt}…`);
    if (event.type === 'repairing') setShellText(status, `Исправляю ошибки · следующая попытка ${event.attempt + 1}/${event.maxAttempts}…`);
    if (event.type === 'validation_failed') {
      const token = ui['hf-token'].value.trim();
      const diagnostic = (event.errors || []).join('; ').slice(0, 500);
      appendMessage('FORMA · ПРОВЕРКА', token ? diagnostic.split(token).join('[скрыто]') : diagnostic, {raw:true});
    }
  };
}
function agentGenerate(context) {
  return async args => {
    await parkScene();
    await activateModel(args.signal);
    const thinking = ui['agent-thinking'].checked;
    const call = trace.toolStart('Генерация модели', {prompt:args.prompt, previousCode:args.previousCode || '', image:args.image, thinking});
    try {
      let finishReason = null;
      const output = await generate({
        ...args, thinking,
        onReasoning: delta => trace.event({type:'reasoning', attempt:context.attempt, maxAttempts:context.maxAttempts, delta}),
        onMetrics: metrics => {
          if (typeof metrics?.finishReason === 'string') finishReason = metrics.finishReason;
          const timing = metrics?.timings || {};
          const usage = metrics?.usage || {};
          trace.setMetrics({tokensPerSecond:timing.predicted_per_second, generatedTokens:usage.completion_tokens ?? timing.predicted_n});
        },
      });
      trace.toolFinish(call, {output});
      if (finishReason === 'length') trace.stage('Достигнут лимит вывода или контекста', 'Запрос, изображения, размышления и ответ занимают общее окно контекста. Часть окна уже занята входными данными.');
      return {text:output, finishReason};
    } catch (err) {
      trace.toolFinish(call, {error:err});
      throw err;
    }
  };
}
function agentValidator({status, session, selected, retainOnFailure = true}) {
  const runCandidate = async (html, signal) => {
    await waitForVisibleDocument(signal, status);
    if (signal?.aborted) throw new DOMException('Проверка отменена.', 'AbortError');
    closeModelSettings();
    setWorkspaceView('scene');
    setShellText(ui['preview-status'], 'Проверяю сцену · предварительный результат');
    const frame = createCandidate();
    const lateIssues = [];
    let contextLost = false;
    const run = trace.toolStart('Запуск и проверка сцены', {html});
    let runFinished = false;
    try {
      const validation = await validateScene({iframe: frame, html, signal, captureImage: false, onRuntimeError: detail => {
        trace.stage('Ошибка во время работы сцены', detail.message);
        if (detail.kind === 'webgl-context-lost') {
          if (activeScene === session && session.frame === frame && ui['preview-frame'] === frame) {
            setShellText(ui['preview-status'], 'Потерян контекст WebGL');
            error(`Браузер или устройство потеряло контекст WebGL: ${detail.message}`);
            queueLateRepair(session, detail);
          } else { contextLost = true; lateIssues.push(detail.message.slice(0, 2000)); }
          return;
        }
        if (activeScene !== session || session.frame !== frame || ui['preview-frame'] !== frame) {
          lateIssues.push(detail.message.slice(0, 2000));
          return;
        }
        queueLateRepair(session, detail);
      }});
      if (lateIssues.length) {
        validation.ok = false;
        // Preserve infrastructure failures detected by the sandbox itself.
        // A loss observed after its initial result is still a context loss;
        // do not invent a value for infrastructureErrorOther if unavailable.
        validation.retryable = validation.retryable !== false && !contextLost;
        if (contextLost) validation.contextLost = true;
        validation.errors = [...(validation.errors || []), ...lateIssues];
      }
      if (!validation.ok) {
        // Release the failed scene before checking whether a fresh graphics
        // context can be created and before considering another model load.
        await discardCandidate(frame);
        if (validation.contextLost && validation.infrastructureErrorOther === false) {
          trace.stage('Проверяю восстановление WebGL', 'Пробую создать небольшой тестовый контекст после освобождения сцены.');
          let recovery;
          try { recovery = await probeWebGLRecovery({signal}); }
          catch (error) {
            if (error?.name === 'AbortError' || signal?.aborted) throw error;
            recovery = {state:'unknown'};
          }
          if (recovery.state === 'unavailable') {
            const message = 'Сейчас не удалось создать тестовый WebGL-контекст. Автоматическое исправление остановлено: повторный запуск сцены пока не подтверждён.';
            validation.infrastructureErrorOther = true;
            validation.retryable = false;
            validation.errors = [...(validation.errors || []), message];
            trace.stage('WebGL пока недоступен', message);
          } else if (recovery.state === 'available') {
            trace.stage('Тестовый WebGL-контекст создан', 'Это не гарантирует запуск сгенерированной сцены.');
          } else {
            trace.stage('Проверка WebGL не дала результата', 'Причина потери контекста остаётся неизвестной.');
          }
        }
      }
      trace.toolFinish(run, {
        output:{evidence:validation.evidence, warnings:validation.warnings, diagnostics:validation.diagnostics,
          phase:validation.phase, infrastructureFailure:validation.infrastructureFailure},
        ...(validation.ok ? {} : {error:(validation.errors || []).join('\n') || 'Проверка не прошла'}),
      });
      runFinished = true;
      if (validation.ok) selected.frame = frame;
      return validation;
    } catch (err) {
      if (!runFinished) trace.toolFinish(run, {error:err});
      await discardCandidate(frame);
      throw err;
    }
  };
  return async (html, {signal} = {}) => {
    // Preserve the complete candidate even when validation is interrupted or
    // a later repair fails; restoring an accepted scene must not overwrite it.
    if (retainOnFailure) retainUnverified(html, session);
    if (signal?.aborted) throw new DOMException('Проверка отменена.', 'AbortError');
    await pauseModel();
    if (signal?.aborted) throw new DOMException('Проверка отменена.', 'AbortError');
    const recovery = {runtimeRetries:0, presentationRetries:0, restarts:0};
    while (true) {
      if (signal?.aborted) throw new DOMException('Проверка отменена.', 'AbortError');
      const validation = await runCandidate(html, signal);
      // The dedicated context-loss branch already probed a fresh context and
      // the agent loop owns its single allowed repair; don't relabel it here.
      if (validation.contextLost) return validation;
      const plan = planValidationRecovery(validation, recovery);
      if (!['retry-runtime','retry-presentation'].includes(plan.action)) {
        // Only code-level failures go back to the model. Expose the evidence
        // for a stalled first frame instead of a vague empty-canvas message.
        if (plan.diagnosis && !validation.ok) validation.errors = [...(validation.errors || []), plan.diagnosis];
        if (plan.action === 'stop') validation.retryable = false;
        trace.stage('Решение восстановления', `${plan.action}: ${plan.reason}`);
        return validation;
      }
      recovery.restarts++;
      if (plan.action === 'retry-runtime') recovery.runtimeRetries++;
      else recovery.presentationRetries++;
      if (signal?.aborted) throw new DOMException('Проверка отменена.', 'AbortError');
      const detail = plan.action === 'retry-presentation'
        ? 'Контекст WebGL создан, но первый кадр не подтверждён. Проверяю тот же HTML в видимой области без новой генерации.'
        : 'Не удалось завершить загрузку сцены. Повторно запускаю тот же HTML без генерации модели.';
      trace.stage(plan.action === 'retry-presentation' ? 'Восстановление первого кадра' : 'Повторная проверка', detail);
      if (status) setShellText(status, detail);
    }
  };
}
function normalizeLateIssue(detail) {
  const input = detail && typeof detail === 'object' ? detail : {message:detail};
  const item = {message:String(input.message || 'Ошибка выполнения сцены.').slice(0, 2000),
    kind:typeof input.kind === 'string' ? input.kind.slice(0, 40) : 'script',
    source:typeof input.source === 'string' ? input.source.slice(0, 500) : ''};
  if (typeof input.rawMessage === 'string') item.rawMessage = input.rawMessage.slice(0, 2000);
  for (const key of ['line','column']) if (Number.isSafeInteger(input[key]) && input[key] > 0) item[key] = input[key];
  return item;
}
function queueLateRepair(session, detail) {
  if (activeScene !== session || session.frame !== ui['preview-frame']) return;
  const issue = normalizeLateIssue(detail);
  if (session.lateRepairStarted) {
    if (!busy && !session.failureReported) {
      session.failureReported = true;
      setShellText(ui['preview-status'], 'Ошибка во время работы сцены');
      error(`Сцена снова сообщила об ошибке после автоматического исправления: ${issue.message}`);
    }
    return;
  }
  const pending = Array.isArray(session.pendingError) ? session.pendingError : session.pendingError ? [normalizeLateIssue(session.pendingError)] : [];
  if (pending.length < 6 && !pending.some(item => item.kind === issue.kind && item.source === issue.source && item.message === issue.message)) pending.push(issue);
  session.pendingError = pending;
  schedulePendingRepair();
}
function schedulePendingRepair() {
  const session = activeScene;
  if (!session || !session.pendingError || session.lateRepairStarted || session.scheduled || busy) return;
  session.scheduled = true;
  setTimeout(() => {
    session.scheduled = false;
    if (busy || activeScene !== session || session.frame !== ui['preview-frame'] || session.lateRepairStarted || !session.pendingError) return;
    void runLateRepair(session);
  }, 0);
}
async function runLateRepair(session) {
  if (busy || activeScene !== session || session.frame !== ui['preview-frame'] || session.lateRepairStarted) return;
  const lateDiagnostics = (Array.isArray(session.pendingError) ? session.pendingError : [session.pendingError]).map(normalizeLateIssue);
  const savedHtml = scene;
  session.pendingError = null;
  session.lateRepairStarted = true;
  const selected = {frame:null};
  const traceContext = {attempt:0, maxAttempts:2};
  const status = appendMessage('FORMA · ИСПРАВЛЯЮ', 'Сцена сообщила об ошибке. Сначала повторно проверяю сохранённый HTML без новой генерации…');
  setShellText(ui['preview-status'], 'Восстанавливаю работу сцены…');
  error('');
  setBusy(true);
  trace.begin({preserve:true});
  trace.stage('Поздняя ошибка', lateDiagnostics.map(item => item.message).join('\n'));
  const controller = new AbortController();
  const signal = controller.signal;
  agentController = controller;
  const recoveryTool = trace.toolStart('Восстановление работающей сцены', {html:savedHtml, diagnostics:lateDiagnostics});
  let recoveryFinished = false;
  let restoreOnFailure = true;
  ui['stop-agent'].hidden = false;
  ui['stop-agent'].disabled = false;
  setShellText(ui['stop-agent'], 'Остановить');
  syncMobileStop();
  try {
    const ensureCurrent = () => {
      if (signal.aborted) throw new DOMException('Восстановление отменено.', 'AbortError');
      if (activeScene !== session) throw new Error('Сцена изменилась во время исправления.');
    };
    ensureCurrent();
    await parkScene();
    ensureCurrent();
    let validation = await agentValidator({status,session,selected,retainOnFailure:false})(savedHtml, {signal});
    ensureCurrent();
    let acceptedHtml = savedHtml;
    let usedModel = false;
    if (!validation.ok) {
      const canRepair = validation.contextLost === true
        ? validation.infrastructureErrorOther === false
        : validation.retryable !== false;
      if (!canRepair) {
        // The saved document has just exhausted its infrastructure recovery.
        // Re-running it in finally would repeat the same failed attempts.
        restoreOnFailure = false;
        throw new Error((validation.errors || []).join('; ') || 'Среда пока не позволяет восстановить сцену; HTML сохранён.');
      }
      const state = getModelState();
      if (!state.loaded && !state.suspended) throw new Error('Для исправления сцены сначала загрузи модель. HTML сохранён.');
      if (!session.prompt?.trim()) throw new Error('Исходный запрос для исправления недоступен. HTML сохранён.');
      const initialErrors = [...new Set([...(validation.errors || []), ...lateDiagnostics.map(item => `${item.kind}${item.source ? ' · ' + item.source : ''}\n${item.message}`)])];
      trace.stage('Исправление', 'Повторный запуск не устранил ошибку кода; передаю модели сохранённый HTML и полную диагностику.');
      const result = await runAgent({prompt:session.prompt, image:session.reference, previousCode:savedHtml, initialErrors, generate:agentGenerate(traceContext),
        validate:agentValidator({status,session,selected}), onEvent:agentEvents(status,traceContext,session), signal, maxAttempts:2});
      if (!result.ok && result.lastHtml) retainUnverified(result.lastHtml, session);
      if (!result.ok) throw new Error(result.reason === 'output_limit'
        ? 'Достигнут лимит вывода или контекста до получения полного HTML. Полученные фрагменты доступны в трассе; предыдущая сцена сохранена.'
        : (result.errors || []).join('; ') || 'Не удалось исправить ошибку.');
      ensureCurrent();
      acceptedHtml = result.html;
      validation = result.validation;
      usedModel = true;
    }
    if (activeScene !== session || !selected.frame) throw new Error('Сцена изменилась во время исправления.');
    adoptCandidate(selected.frame, acceptedHtml);
    if (usedModel) clearUnverified();
    session.frame = selected.frame;
    session.parked = false;
    selected.frame = null;
    const warning = (validation.warnings || []).join(' ');
    const message = usedModel ? 'Ошибка исправлена и запуск сцены проверен.' : 'Сцена восстановлена повторным запуском без новой генерации.';
    setShellText(status, redact(warning ? `${message} Замечание проверки: ${warning}` : message));
    trace.toolFinish(recoveryTool, {output:{usedModel, evidence:validation.evidence, diagnostics:validation.diagnostics, warnings:validation.warnings}});
    recoveryFinished = true;
    trace.finish(usedModel ? 'Исправлено' : 'Восстановлено', 'done');
  } catch (err) {
    if (!recoveryFinished) trace.toolFinish(recoveryTool, {error:err});
    setShellText(status, err?.name === 'AbortError' ? 'Исправление остановлено.' : 'Автоматически исправить сцену не удалось.');
    if (err?.name !== 'AbortError') trace.stage('Не удалось исправить сцену', err?.message || String(err));
    trace.finish(err?.name === 'AbortError' ? 'Остановлено' : 'Ошибка', err?.name === 'AbortError' ? 'done' : 'error');
    if (activeScene === session) {
      setShellText(ui['preview-status'], 'Ошибка во время работы сцены');
      if (err?.name !== 'AbortError') error(`Не удалось исправить ошибку: ${err?.message || String(err)}`);
    }
  } finally {
    await discardCandidate(selected.frame);
    if (restoreOnFailure && activeScene === session && session.parked) await restorePreviousScene();
    if (agentController === controller) {
      agentController = null;
      ui['stop-agent'].hidden = true;
      syncMobileStop();
      setBusy(false);
    }
  }
}
ui['load-model'].addEventListener('click', async () => {
  if (busy) return;
  setBusy(true); error(''); startStage('Подготавливаем загрузку…');
  try {
    await parkScene();
    await loadModel({
      onStatus: startStage,
      onProgress: updateProgress,
      token: ui['hf-token'].value.trim(),
    });
    profiler.invalidate();
    // Update hardware/offload information as soon as model loading finishes,
    // without waiting for a generation or blocking the page on a probe.
    void profiler.run().catch(() => {});
    updateModelStatus();
    setShellText(ui['load-model'], 'Готово ✓');
    finishProgress();
    appendMessage('FORMA · МОДЕЛЬ ГОТОВА', 'Опиши сцену. Для первого запроса с картинкой понадобится дополнительная загрузка.');
  } catch (e) {
    setShellText(ui['model-status'], 'Не удалось загрузить модель');
    finishProgress();
    error(e?.message || String(e));
  } finally {
    if (activeScene?.parked) await restorePreviousScene();
    setBusy(false);
  }
});
ui['check-connectivity'].addEventListener('click', async () => {
  const button = ui['check-connectivity'];
  const output = ui['connectivity-result'];
  button.disabled = true; output.hidden = false; setShellText(output, 'Проверяем доступ с твоего устройства…');
  try {
    const results = await checkConnectivity();
    setShellText(output, results.map(item => `${item.label}: ${item.status === 'ok' ? 'доступен' : 'не удалось проверить'} — ${item.detail}`).join('\n') + '\nЭто проверка соединения, а не гарантия полной загрузки.');
  } catch (e) { setShellText(output, `Не удалось выполнить проверку: ${e?.message || String(e)}`); }
  finally { button.disabled = false; }
});
$('check-webgpu').addEventListener('click', async () => {
  const button = $('check-webgpu');
  const output = $('webgpu-result');
  button.disabled = true;
  output.hidden = false;
  setShellText(output, 'Проверяю адаптер WebGPU…');
  try {
    const [availability, inferenceProbe] = await Promise.allSettled([checkWebGPU(), probeInferenceWebGPU()]);
    const detail = availability.status === 'fulfilled' && typeof availability.value?.detail === 'string'
      ? availability.value.detail : 'Не удалось проверить адаптер WebGPU.';
    const describe = value => {
      const states = { no_adapter:'адаптер недоступен', api_unavailable:'WebGPU API недоступен',
        error:'не удалось проверить', timeout:'время ожидания истекло', unsupported:'проверка не поддерживается' };
      if (value?.state !== 'available') return states[value?.state] || 'неизвестно';
      const feature = value.shaderF16 === true ? 'доступен' : value.shaderF16 === false ? 'недоступен' : 'неизвестно';
      return `адаптер доступен; shader-f16: ${feature}`;
    };
    const probe = inferenceProbe.status === 'fulfilled' ? inferenceProbe.value : null;
    setShellText(output, `${detail}\nОкно браузера: ${describe(probe?.main)}.\nТестовый worker: ${describe(probe?.worker)}.\nshader-f16 необходим WebGPU-бэкенду текущего движка. Тестовый worker не является worker модели: результаты не подтверждают загрузку весов на GPU.`);
  } catch {
    setShellText(output, 'Не удалось проверить WebGPU. В Chrome открой chrome://gpu, в Edge — edge://gpu.');
  } finally { button.disabled = false; }
});
ui['load-local'].addEventListener('click', async () => {
  if (busy) return;
  setWorkspaceView('chat');
  // Loading progress and any validation failure belong to the main workspace.
  closeModelSettings();
  setBusy(true); error('');
  startStage('Подготавливаем файлы…');
  try {
    await parkScene();
    const result = await loadLocalModel(ui['model-files'].files, ui['projector-file'].files?.[0] || null, {
      onStatus: startStage,
    });
    profiler.invalidate();
    void profiler.run().catch(() => {});
    finishProgress();
    setShellText(ui['load-model'], 'Готово ✓');
    closeModelSettings();
    updateModelStatus();
    appendMessage('FORMA · ЛОКАЛЬНАЯ МОДЕЛЬ', result.vision ? 'Можно описать сцену или приложить картинку.' : 'Можно создавать сцены по тексту. Для картинки выбери файл mmproj в разделе своих файлов.');
  } catch (e) {
    finishProgress();
    if (!getModelState().loaded && !getModelState().suspended) { setShellText(ui['model-status'], 'Модель не загружена'); setShellText(ui['load-model'], 'Загрузить ↗'); }
    else { updateModelStatus(); }
    error(e?.message || String(e));
  } finally {
    if (activeScene?.parked) await restorePreviousScene();
    setBusy(false);
  }
});
ui['prompt-form'].addEventListener('submit', async event => {
  event.preventDefault();
  if (busy) return;
  const prompt = ui['prompt-input'].value.trim();
  if (!prompt) return;
  if (!getModelState().loaded && !getModelState().suspended) { error('Сначала загрузи модель кнопкой выше.'); return; }
  error(''); setBusy(true); appendMessage('ТЫ', prompt, {attachment:Boolean(image)});
  trace.begin({preserve:true});
  trace.stage('Запрос пользователя', prompt);
  const status = appendMessage('FORMA · СОЗДАЮ', 'Готовлю сцену…');
  setShellText(ui['preview-status'], !ui['partial-preview'].hidden
    ? 'Генерирую сцену · показан предыдущий частичный кадр'
    : 'Генерирую сцену…');
  const session = {prompt, reference:image, frame:null, pendingError:null, lateRepairStarted:false, scheduled:false};
  const selected = {frame:null};
  const traceContext = {attempt:0, maxAttempts:3};
  agentController = new AbortController();
  ui['stop-agent'].hidden = false;
  ui['stop-agent'].disabled = false;
  setShellText(ui['stop-agent'], 'Остановить');
  syncMobileStop();
  try {
    if (image && !getModelState().vision && getModelState().mode === 'local' && !ui['projector-file'].files?.[0]) {
      throw new Error('Для картинки выбери файл mmproj в разделе «Свои файлы модели».');
    }
    await parkScene();
    await activateModel(agentController.signal);
    if (agentController.signal.aborted) throw new DOMException('Создание сцены остановлено.', 'AbortError');
    if (image && !getModelState().vision) {
      if (getModelState().mode === 'local') {
        const projector = ui['projector-file'].files?.[0];
        if (!projector) throw new Error('Для картинки выбери файл mmproj в разделе «Свои файлы модели».');
        await setLocalProjector(projector);
      }
      setShellText(status, 'Загружаю компонент для картинок и перезапускаю модель…');
      startStage('Подготавливаем компонент для картинок…');
      const call = trace.toolStart('Подключение vision', {source:getModelState().mode === 'local' ? 'local file' : 'Hugging Face'});
      try {
        await ensureVision({onStatus:text => {startStage(text); trace.stage(text);}, onProgress: updateProgress, token: ui['hf-token'].value.trim()});
        // Model reinitialization can change GPU/CPU placement.
        profiler.invalidate();
        trace.toolFinish(call, {output:'Компонент для картинок подключён.'});
      } catch (err) { trace.toolFinish(call, {error:err}); throw err; }
      finishProgress();
    }
    if (agentController.signal.aborted) throw new DOMException('Создание сцены остановлено.', 'AbortError');
    await profiler.run(agentController.signal);
    if (agentController.signal.aborted) throw new DOMException('Создание сцены остановлено.', 'AbortError');
    const result = await runAgent({
      prompt, image, previousCode: scene, generate:agentGenerate(traceContext),
      signal: agentController.signal,
      maxAttempts: 3,
      onEvent: agentEvents(status,traceContext,session),
      validate: agentValidator({status,session,selected}),
    });
    if (!result.ok && result.lastHtml) retainUnverified(result.lastHtml, session);
    if (!result.ok) {
      const details = (result.errors || []).join('; ') || 'Проверка не завершилась успешно.';
      if (result.reason === 'output_limit') {
        throw new Error(`Достигнут лимит вывода или контекста до получения полного HTML. Полученные фрагменты доступны в трассе. ${scene ? 'Предыдущая сцена сохранена.' : 'Сцена пока не создана.'}`);
      }
      throw new Error(`Не удалось получить рабочую сцену за ${result.attempts} попыток. ${details}`);
    }
    if (!selected.frame) throw new Error('Проверенная сцена недоступна для предпросмотра.');
    adoptCandidate(selected.frame, result.html);
    clearUnverified();
    session.frame = selected.frame;
    session.parked = false;
    activeScene = session;
    selected.frame = null;
    const warning = (result.validation.warnings || []).join(' ');
    setShellText(status, redact(warning ? `Сцена запущена. Замечание проверки: ${warning}` : 'Сцена запущена, ошибок за время проверки не обнаружено. Внешний вид и соответствие запросу автоматически не подтверждены.'));
    trace.finish('Готово', 'done');
    ui['prompt-input'].value = '';
    clearImage();
  } catch (e) {
    setShellText(status, e?.name === 'AbortError' ? 'Создание сцены остановлено.' : 'Не получилось создать и проверить сцену.');
    setShellText(ui['preview-status'], scene ? 'Предыдущая сцена сохранена' : 'Сцена пока не создана');
    finishProgress();
    if (!getModelState().loaded && !getModelState().suspended) {
      setShellText(ui['model-status'], 'Модель не загружена');
      setShellText(ui['load-model'], 'Загрузить ↗');
    } else {
      updateModelStatus();
    }
    if (e?.name !== 'AbortError') error(e?.message || String(e));
    if (e?.name !== 'AbortError') trace.stage('Не удалось завершить', e?.message || String(e));
    if (e?.name !== 'AbortError' && !scene && traceContext.fallbackHtml === unverifiedHtml) {
      await showPartialPreview(unverifiedHtml, traceContext.fallbackEvidence, agentController?.signal);
    }
    trace.finish(e?.name === 'AbortError' ? 'Остановлено' : 'Ошибка', e?.name === 'AbortError' ? 'done' : 'error');
  } finally {
    await discardCandidate(selected.frame);
    if (activeScene?.parked) await restorePreviousScene();
    agentController = null;
    ui['stop-agent'].hidden = true;
    syncMobileStop();
    setBusy(false);
  }
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
// Re-run the saved candidate without generating it again; when a code error is
// observed, use the usual bounded repair loop with its original request.
ui['retry-unverified'].addEventListener('click', async () => {
  if (busy || !unverifiedHtml) return;
  const html = unverifiedHtml;
  const session = {prompt:unverifiedContext?.prompt || '', reference:unverifiedContext?.reference || null, frame:null, pendingError:null, lateRepairStarted:false, scheduled:false};
  const selected = {frame:null};
  const previousSession = activeScene;
  let firstEvidence = null;
  let retryContext = null;
  error('');
  setBusy(true);
  trace.begin({preserve:true});
  trace.stage('Повторная проверка', 'Повторно запускаю сохранённый HTML без генерации модели.');
  const status = appendMessage('FORMA · ПРОВЕРКА', 'Проверяю сохранённую сцену…');
  agentController = new AbortController();
  const signal = agentController.signal;
  ui['stop-agent'].hidden = false;
  ui['stop-agent'].disabled = false;
  setShellText(ui['stop-agent'], 'Остановить');
  syncMobileStop();
  try {
    await parkScene();
    if (signal.aborted) throw new DOMException('Проверка отменена.', 'AbortError');
    setShellText(ui['preview-status'], 'Повторно проверяю сцену…');
    let validation = await agentValidator({status, session, selected, retainOnFailure:false})(html, {signal});
    if (!validation.ok) firstEvidence = validation.evidence || null;
    if (signal.aborted) throw new DOMException('Проверка отменена.', 'AbortError');
    let acceptedHtml = html;
    if (!validation.ok) {
      const canRepair = validation.contextLost === true
        ? validation.infrastructureErrorOther === false
        : validation.retryable !== false;
      if (!canRepair) throw new Error((validation.errors || []).join('; ') || 'Сцена не прошла проверку запуска.');
      const modelState = getModelState();
      if (!modelState.loaded && !modelState.suspended) throw new Error('Для исправления сцены сначала загрузи модель. HTML сохранён.');
      if (!session.prompt.trim()) throw new Error('Исходный запрос для исправления недоступен. HTML сохранён.');
      if (session.reference && !modelState.vision && modelState.mode === 'local' && !ui['projector-file'].files?.[0]) {
        throw new Error('Для исправления с изображением выбери компонент mmproj. HTML сохранён.');
      }
      setShellText(status, 'Проверка обнаружила ошибки. Восстанавливаю модель для исправления…');
      trace.stage('Исправление', 'Проверка нашла ошибки; передаю их модели вместе с сохранённым HTML.');
      await activateModel(signal);
      if (signal.aborted) throw new DOMException('Проверка отменена.', 'AbortError');
      if (session.reference && !getModelState().vision) {
        if (getModelState().mode === 'local') await setLocalProjector(ui['projector-file'].files[0]);
        const call = trace.toolStart('Подключение vision', {source:getModelState().mode === 'local' ? 'local file' : 'Hugging Face'});
        try {
          await ensureVision({onStatus:text => {startStage(text); trace.stage(text);}, onProgress:updateProgress, token:ui['hf-token'].value.trim()});
          profiler.invalidate();
          trace.toolFinish(call, {output:'Компонент для картинок подключён.'});
        } catch (err) { trace.toolFinish(call, {error:err}); throw err; }
        finally { finishProgress(); }
      }
      if (signal.aborted) throw new DOMException('Проверка отменена.', 'AbortError');
      const maxAttempts = validation.contextLost === true ? 1 : 2;
      const traceContext = {attempt:0, maxAttempts};
      retryContext = traceContext;
      const result = await runAgent({prompt:session.prompt, image:session.reference, previousCode:html, initialErrors:validation.errors,
        generate:agentGenerate(traceContext), validate:agentValidator({status,session,selected}), onEvent:agentEvents(status,traceContext,session), signal, maxAttempts});
      if (!result.ok && result.lastHtml) retainUnverified(result.lastHtml, session);
      if (!result.ok) throw new Error((result.errors || []).join('; ') || 'Не удалось исправить сцену. HTML сохранён.');
      acceptedHtml = result.html;
      validation = result.validation;
    }
    if (!selected.frame) throw new Error('Проверенная сцена недоступна для предпросмотра.');
    adoptCandidate(selected.frame, acceptedHtml);
    session.frame = selected.frame;
    session.parked = false;
    selected.frame = null;
    activeScene = session;
    clearUnverified();
    // Only clear the draft if the user has not changed it since the candidate
    // was generated; an unrelated draft must survive a successful recheck.
    if (ui['prompt-input'].value.trim() === session.prompt && image === session.reference) {
      ui['prompt-input'].value = '';
      clearImage();
    }
    const warning = (validation.warnings || []).join(' ');
    setShellText(status, redact(warning ? `Сцена запущена. Замечание проверки: ${warning}` : 'Сцена запущена; ошибок за время проверки не обнаружено.'));
    trace.finish('Готово', 'done');
  } catch (err) {
    const cancelled = err?.name === 'AbortError';
    setShellText(status, cancelled ? 'Проверка остановлена; HTML сохранён.' : 'Сцена не прошла повторную проверку; HTML сохранён.');
    setShellText(ui['preview-status'], scene ? 'Предыдущая сцена сохранена' : 'Сцена пока не создана');
    if (!cancelled) { error(err?.message || String(err)); trace.stage('Повторная проверка не прошла', err?.message || String(err)); }
    if (!cancelled && !scene) {
      const candidateEvidence = retryContext?.fallbackHtml === unverifiedHtml
        ? retryContext.fallbackEvidence
        : unverifiedHtml === html ? firstEvidence : null;
      await showPartialPreview(unverifiedHtml, candidateEvidence, signal);
    }
    trace.finish(cancelled ? 'Остановлено' : 'Ошибка', cancelled ? 'done' : 'error');
  } finally {
    await discardCandidate(selected.frame);
    if (activeScene === previousSession && previousSession?.parked) await restorePreviousScene();
    agentController = null;
    ui['stop-agent'].hidden = true;
    syncMobileStop();
    setBusy(false);
  }
});
ui['reset-scene'].addEventListener('click', async () => {
  if (busy) return;
  setBusy(true);
  try {
    await releaseScene(ui['preview-frame']);
    activeScene = null;
    scene = ''; clearUnverified(); clearPartialPreview(); ui['preview-frame'].srcdoc = ''; ui['preview-frame'].hidden = true; ui['preview-empty'].hidden = false;
    setShellText(ui['preview-status'], 'Твоя сцена появится здесь'); ui['download-html'].disabled = true; ui['copy-html'].disabled = true; error('');
  } finally { setBusy(false); }
});
ui['download-html'].addEventListener('click', () => {
  if (!scene) return;
  const url = URL.createObjectURL(new Blob([scene], {type: 'text/html;charset=utf-8'}));
  const a = document.createElement('a'); a.href = url; a.download = 'forma-scene.html'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
ui['download-unverified'].addEventListener('click', () => {
  if (!unverifiedHtml) return;
  const url = URL.createObjectURL(new Blob([unverifiedHtml], {type: 'text/html;charset=utf-8'}));
  const a = document.createElement('a'); a.href = url; a.download = 'forma-unverified.html'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
ui['copy-html'].addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(scene); setShellText(ui['copy-html'], 'Скопировано ✓'); setTimeout(() => { setShellText(ui['copy-html'], 'Копировать'); }, 2000); }
  catch { error('Не удалось скопировать код. Используй кнопку HTML для скачивания.'); }
});
