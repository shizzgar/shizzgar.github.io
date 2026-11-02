import { loadModel, loadLocalModel, setLocalProjector, ensureVision, generate, getModelState, getLoadedContextInfo } from './inference.js';
import { checkConnectivity, checkWebGPU } from './diagnostics.js';
import { probeInferenceWebGPU } from './webgpu-inference-probe.js';
import { createBundle } from './bundle-download.js';
import { runAgent } from './agent-loop.js';
import { validateScene, disposeScene } from './sandbox-runner.js';
import { createTracePanel } from './trace-panel.js';
import { createProfiler } from './profiling-ui.js';

const $ = (id) => document.getElementById(id);
const ui = Object.fromEntries(['load-model','open-local','local-files','hf-token','model-status','model-progress','progress-wrap','progress-track','model-progress-detail','chat-log','prompt-form','prompt-input','image-input','image-chip','image-preview','image-name','remove-image','generate-button','stop-agent','agent-thinking','trace-mount','preview-frame','preview-empty','preview-status','error-panel','error-text','download-html','copy-html','reset-scene','model-files','projector-file','load-local','check-connectivity','connectivity-result','download-bundle','cancel-bundle','bundle-result','download-files'].map(id => [id, $(id)]));
// The token is never stored by the app; discard any value restored by the browser.
ui['hf-token'].value = '';
// The form is present for browser password-field semantics, not submission.
$('hf-token-form').addEventListener('submit', event => event.preventDefault());
const secret = () => ui['hf-token'].value.trim();
const redact = value => { const text = String(value ?? ''); const token = secret(); return token ? text.split(token).join('[скрыто]') : text; };
const trace = createTracePanel(ui['trace-mount'], {redact, getSecret:secret});
const profiler = createProfiler(trace);
// Probe browser capabilities before the user commits to downloading the model.
// This only reads local WebGPU/WebGL information; a failure must not prevent
// loading or using the application.
void profiler.run().catch(() => {});
let scene = '';
let image = null;
let imageUrl = null;
let busy = false;
let agentController = null;
let activeScene = null;

function error(message) {
  ui['error-text'].textContent = redact(message || '');
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
  if (!value) schedulePendingRepair();
}
ui['stop-agent'].addEventListener('click', () => {
  if (!agentController) return;
  agentController.abort();
  ui['stop-agent'].disabled = true;
  ui['stop-agent'].textContent = 'Останавливаю…';
  trace.stage('Остановка запрошена', 'Если компонент модели ещё загружается, остановка произойдёт после текущего этапа.');
});
ui['open-local'].addEventListener('click', () => {
  if (busy) return;
  ui['local-files'].open = true;
  ui['open-local'].setAttribute('aria-expanded', 'true');
  ui['model-files'].focus();
});
ui['local-files'].addEventListener('toggle', () => {
  ui['open-local'].setAttribute('aria-expanded', String(ui['local-files'].open));
});
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 Б';
  const units = ['Б', 'КиБ', 'МиБ', 'ГиБ'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / (1024 ** index);
  return `${index === 0 ? Math.floor(value) : value.toFixed(1)} ${units[index]}`;
}
function updateModelStatus() {
  const state = getModelState();
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
  ui['model-status'].textContent = `${name}: ${modality}${backend}`;
}
function startStage(text) {
  ui['model-status'].textContent = text;
  ui['progress-wrap'].hidden = false;
  ui['model-progress'].removeAttribute('value');
  ui['progress-track'].classList.add('indeterminate');
  ui['model-progress-detail'].textContent = text;
}
function updateProgress({loaded, total, cachedBytes = 0}) {
  const received = Number.isFinite(loaded) && loaded > 0 ? loaded : 0;
  const cached = Number.isFinite(cachedBytes) && cachedBytes > 0 ? ` · сохранено ${formatBytes(cachedBytes)}` : '';
  const known = Number.isFinite(total) && total > 0 && received <= total;
  ui['progress-wrap'].hidden = false;
  if (known) {
    const percent = Math.min(100, received / total * 100);
    ui['model-progress'].value = percent;
    ui['progress-track'].classList.remove('indeterminate');
    ui['model-progress-detail'].textContent = `${formatBytes(received)} из ${formatBytes(total)} · ${Math.floor(percent)}%${cached}`;
  } else {
    ui['model-progress'].removeAttribute('value');
    ui['progress-track'].classList.add('indeterminate');
    ui['model-progress-detail'].textContent = received > 0 ? `Получено ${formatBytes(received)} · общий размер неизвестен${cached}` : 'Ожидание данных…';
  }
}
function finishProgress() {
  ui['progress-wrap'].hidden = true;
  ui['model-progress'].removeAttribute('value');
  ui['progress-track'].classList.add('indeterminate');
  ui['model-progress-detail'].textContent = '';
  updateModelStatus();
}
ui['download-bundle'].addEventListener('click', async () => {
  if (busy) return;
  error('');
  ui['bundle-result'].hidden = true;
  if (typeof window.showSaveFilePicker !== 'function') {
    ui['download-files'].open = true;
    error('Этот браузер не поддерживает сохранение большого ZIP напрямую. Попробуй актуальный Chrome или Edge; ниже доступны отдельные файлы.');
    return;
  }
  const token = ui['hf-token'].value.trim();
  const previousStatus = ui['model-status'].textContent;
  setBusy(true);
  let controller;
  try {
    // Must run directly in the click handler to preserve browser user activation.
    const handle = await window.showSaveFilePicker({
      suggestedName: 'forma-3d-coder.zip',
      types: [{ description: 'ZIP архив', accept: { 'application/zip': ['.zip'] } }],
    });
    startStage('Подготавливаем комплект…');
    const writable = await handle.createWritable();
    controller = new AbortController();
    ui['cancel-bundle'].hidden = false;
    ui['cancel-bundle'].onclick = () => controller.abort();
    await createBundle({
      writable, token, signal: controller.signal,
      onProgress: data => {
        const stage = data.stage ? String(data.stage) : 'Скачиваем комплект…';
        if ((!data.loaded && !data.total) || stage.startsWith('Завершаем')) startStage(stage);
        else { ui['model-status'].textContent = stage; updateProgress(data); }
      },
    });
    ui['bundle-result'].textContent = 'ZIP сохранён. Распакуй его перед загрузкой частей в Forma.';
    ui['bundle-result'].hidden = false;
  } catch (e) {
    if (e?.name === 'AbortError' || controller?.signal.aborted) {
      ui['bundle-result'].textContent = 'Скачивание отменено.';
      ui['bundle-result'].hidden = false;
    } else {
      error(e?.message || String(e));
    }
  } finally {
    ui['cancel-bundle'].hidden = true;
    ui['cancel-bundle'].onclick = null;
    finishProgress();
    ui['model-status'].textContent = previousStatus;
    setBusy(false);
  }
});
function createCandidate() {
  // Keep candidates in the stage while invisible. Moving an iframe after it has
  // run can reload it; opacity keeps its real viewport and running context.
  const frame = document.createElement('iframe');
  frame.title = 'Проверка 3D-сцены';
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  frame.style.opacity = '0';
  frame.style.pointerEvents = 'none';
  frame.style.zIndex = '2';
  ui['preview-frame'].parentElement.appendChild(frame);
  return frame;
}
function discardCandidate(frame) {
  if (!frame) return;
  disposeScene(frame);
  frame.remove();
}
function adoptCandidate(frame, html) {
  const old = ui['preview-frame'];
  disposeScene(old);
  old.remove();
  frame.id = 'preview-frame';
  frame.title = 'Предпросмотр сгенерированной 3D-сцены';
  frame.removeAttribute('aria-hidden');
  frame.removeAttribute('tabindex');
  frame.style.opacity = '1';
  frame.style.pointerEvents = '';
  ui['preview-frame'] = frame;
  ui['preview-empty'].hidden = true;
  scene = html;
  ui['preview-status'].textContent = 'Проверен запуск сцены';
}
function agentEvents(status, context) {
  return event => {
    if (event.type === 'generating') { context.attempt = event.attempt; context.maxAttempts = event.maxAttempts; }
    trace.event(event);
    const attempt = `${event.attempt}/${event.maxAttempts}`;
    if (event.type === 'generating') status.textContent = `Создаю сцену · попытка ${attempt}…`;
    if (event.type === 'token') status.textContent = `Пишу код · попытка ${attempt} · ${event.length} символов`;
    if (event.type === 'validating') status.textContent = `Запускаю сцену и проверяю ошибки · попытка ${attempt}…`;
    if (event.type === 'repairing') status.textContent = `Исправляю ошибки · следующая попытка ${event.attempt + 1}/${event.maxAttempts}…`;
    if (event.type === 'validation_failed') {
      const token = ui['hf-token'].value.trim();
      const diagnostic = (event.errors || []).join('; ').slice(0, 500);
      appendMessage('FORMA · ПРОВЕРКА', token ? diagnostic.split(token).join('[скрыто]') : diagnostic);
    }
  };
}
function agentGenerate(context) {
  return async args => {
    // Per-attempt overrides let the agent save the output budget after a
    // length-limited response without changing the user's checkbox.
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
function agentValidator({status, session, selected}) {
  return async (html, {signal}) => {
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
            ui['preview-status'].textContent = 'Потерян контекст WebGL';
            error(`Браузер или устройство потеряло контекст WebGL: ${detail.message}`);
          } else { contextLost = true; lateIssues.push(detail.message.slice(0, 500)); }
          return;
        }
        if (activeScene !== session || session.frame !== frame || ui['preview-frame'] !== frame) {
          lateIssues.push(detail.message.slice(0, 500));
          return;
        }
        queueLateRepair(session, detail.message);
      }});
      trace.toolFinish(run, validation.ok
        ? {output:{evidence:validation.evidence, warnings:validation.warnings}}
        : {error:(validation.errors || []).join('\n') || 'Проверка не прошла'});
      runFinished = true;
      if (lateIssues.length) {
        validation.ok = false;
        validation.retryable = !contextLost;
        validation.errors = [...(validation.errors || []), ...lateIssues];
      }
      if (validation.ok) selected.frame = frame; else discardCandidate(frame);
      return validation;
    } catch (err) {
      if (!runFinished) trace.toolFinish(run, {error:err});
      discardCandidate(frame);
      throw err;
    }
  };
}
function queueLateRepair(session, message) {
  if (activeScene !== session || session.frame !== ui['preview-frame']) return;
  if (session.lateRepairStarted) {
    if (!busy && !session.failureReported) {
      session.failureReported = true;
      ui['preview-status'].textContent = 'Ошибка во время работы сцены';
      error(`Сцена снова сообщила об ошибке после автоматического исправления: ${String(message || '').slice(0, 500)}`);
    }
    return;
  }
  if (!session.pendingError) session.pendingError = String(message || 'Ошибка выполнения сцены.').slice(0, 500);
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
  const diagnostic = session.pendingError;
  session.pendingError = null;
  session.lateRepairStarted = true;
  const oldFrame = session.frame;
  const selected = {frame:null};
  const traceContext = {attempt:0, maxAttempts:2};
  const status = appendMessage('FORMA · ИСПРАВЛЯЮ', 'Сцена сообщила об ошибке после запуска. Исправляю её…');
  ui['preview-status'].textContent = 'Исправляю ошибку сцены…';
  error('');
  setBusy(true);
  trace.begin({preserve:true});
  trace.stage('Поздняя ошибка', diagnostic);
  agentController = new AbortController();
  ui['stop-agent'].hidden = false;
  ui['stop-agent'].disabled = false;
  ui['stop-agent'].textContent = 'Остановить';
  try {
    const result = await runAgent({prompt:session.prompt, image:session.reference, previousCode:scene, initialErrors:[diagnostic], generate:agentGenerate(traceContext),
      validate:agentValidator({status,session,selected}), onEvent:agentEvents(status,traceContext), signal:agentController.signal, maxAttempts:2});
    if (!result.ok) throw new Error(result.reason === 'output_limit'
      ? 'Достигнут лимит вывода или контекста до получения полного HTML. Полученные фрагменты доступны в трассе; предыдущая сцена сохранена.'
      : (result.errors || []).join('; ') || 'Не удалось исправить ошибку.');
    if (activeScene !== session || ui['preview-frame'] !== oldFrame || !selected.frame) throw new Error('Сцена изменилась во время исправления.');
    adoptCandidate(selected.frame, result.html);
    session.frame = selected.frame;
    selected.frame = null;
    const warning = (result.validation.warnings || []).join(' ');
    status.textContent = redact(warning ? `Ошибка исправлена; замечание проверки: ${warning}` : 'Ошибка исправлена и запуск сцены проверен.');
    trace.finish('Исправлено', 'done');
  } catch (err) {
    status.textContent = err?.name === 'AbortError' ? 'Исправление остановлено.' : 'Автоматически исправить сцену не удалось.';
    if (err?.name !== 'AbortError') trace.stage('Не удалось исправить сцену', err?.message || String(err));
    trace.finish(err?.name === 'AbortError' ? 'Остановлено' : 'Ошибка', err?.name === 'AbortError' ? 'done' : 'error');
    if (activeScene === session && ui['preview-frame'] === oldFrame) {
      ui['preview-status'].textContent = 'Ошибка во время работы сцены';
      if (err?.name !== 'AbortError') error(`Не удалось исправить ошибку: ${err?.message || String(err)}`);
    }
  } finally {
    discardCandidate(selected.frame);
    agentController = null;
    ui['stop-agent'].hidden = true;
    setBusy(false);
  }
}
ui['load-model'].addEventListener('click', async () => {
  if (busy) return;
  setBusy(true); error(''); startStage('Подготавливаем загрузку…');
  try {
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
    ui['load-model'].textContent = 'Готово ✓';
    finishProgress();
    appendMessage('FORMA · МОДЕЛЬ ГОТОВА', 'Опиши сцену. Для первого запроса с картинкой понадобится дополнительная загрузка.');
  } catch (e) {
    ui['model-status'].textContent = 'Не удалось загрузить модель';
    finishProgress();
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
$('check-webgpu').addEventListener('click', async () => {
  const button = $('check-webgpu');
  const output = $('webgpu-result');
  button.disabled = true;
  output.hidden = false;
  output.textContent = 'Проверяю адаптер WebGPU…';
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
    output.textContent = `${detail}\nОкно браузера: ${describe(probe?.main)}.\nТестовый worker: ${describe(probe?.worker)}.\nshader-f16 необходим WebGPU-бэкенду текущего движка. Тестовый worker не является worker модели: результаты не подтверждают загрузку весов на GPU.`;
  } catch {
    output.textContent = 'Не удалось проверить WebGPU. В Chrome открой chrome://gpu, в Edge — edge://gpu.';
  } finally { button.disabled = false; }
});
ui['load-local'].addEventListener('click', async () => {
  if (busy) return;
  setBusy(true); error('');
  startStage('Подготавливаем файлы…');
  try {
    const result = await loadLocalModel(ui['model-files'].files, ui['projector-file'].files?.[0] || null, {
      onStatus: startStage,
    });
    profiler.invalidate();
    void profiler.run().catch(() => {});
    finishProgress();
    ui['load-model'].textContent = 'Готово ✓';
    updateModelStatus();
    appendMessage('FORMA · ЛОКАЛЬНАЯ МОДЕЛЬ', result.vision ? 'Можно описать сцену или приложить картинку.' : 'Можно создавать сцены по тексту. Для картинки выбери файл mmproj в разделе своих файлов.');
  } catch (e) {
    finishProgress();
    if (!getModelState().loaded) { ui['model-status'].textContent = 'Модель не загружена'; ui['load-model'].textContent = 'Загрузить ↗'; }
    else { updateModelStatus(); }
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
  trace.begin({preserve:true});
  trace.stage('Запрос пользователя', prompt);
  const status = appendMessage('FORMA · СОЗДАЮ', 'Готовлю сцену…');
  ui['preview-status'].textContent = 'Генерирую сцену…';
  const session = {prompt, reference:image, frame:null, pendingError:null, lateRepairStarted:false, scheduled:false};
  const selected = {frame:null};
  const traceContext = {attempt:0, maxAttempts:3};
  agentController = new AbortController();
  ui['stop-agent'].hidden = false;
  ui['stop-agent'].disabled = false;
  ui['stop-agent'].textContent = 'Остановить';
  try {
    if (image && !getModelState().vision) {
      if (getModelState().mode === 'local') {
        const projector = ui['projector-file'].files?.[0];
        if (!projector) throw new Error('Для картинки выбери файл mmproj в разделе «Свои файлы модели».');
        await setLocalProjector(projector);
      }
      status.textContent = 'Загружаю компонент для картинок и перезапускаю модель…';
      startStage('Подготавливаем компонент для картинок…');
      const call = trace.toolStart('Подключение vision', {источник:getModelState().mode === 'local' ? 'локальный файл' : 'Hugging Face'});
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
      onEvent: agentEvents(status,traceContext),
      validate: agentValidator({status,session,selected}),
    });
    if (!result.ok) {
      const details = (result.errors || []).join('; ') || 'Проверка не завершилась успешно.';
      if (result.reason === 'output_limit') {
        throw new Error(`Достигнут лимит вывода или контекста до получения полного HTML. Полученные фрагменты доступны в трассе. ${scene ? 'Предыдущая сцена сохранена.' : 'Сцена пока не создана.'}`);
      }
      throw new Error(`Не удалось получить рабочую сцену за ${result.attempts} попыток. ${details}`);
    }
    if (!selected.frame) throw new Error('Проверенная сцена недоступна для предпросмотра.');
    adoptCandidate(selected.frame, result.html);
    session.frame = selected.frame;
    activeScene = session;
    selected.frame = null;
    const warning = (result.validation.warnings || []).join(' ');
    status.textContent = redact(warning ? `Сцена запущена. Замечание проверки: ${warning}` : 'Сцена запущена, ошибок за время проверки не обнаружено. Внешний вид и соответствие запросу автоматически не подтверждены.');
    trace.finish('Готово', 'done');
    ui['prompt-input'].value = '';
    clearImage();
  } catch (e) {
    status.textContent = e?.name === 'AbortError' ? 'Создание сцены остановлено.' : 'Не получилось создать и проверить сцену.';
    ui['preview-status'].textContent = scene ? 'Предыдущая сцена сохранена' : 'Сцена пока не создана';
    finishProgress();
    if (!getModelState().loaded) {
      ui['model-status'].textContent = 'Модель не загружена';
      ui['load-model'].textContent = 'Загрузить ↗';
    } else {
      updateModelStatus();
    }
    if (e?.name !== 'AbortError') error(e?.message || String(e));
    if (e?.name !== 'AbortError') trace.stage('Не удалось завершить', e?.message || String(e));
    trace.finish(e?.name === 'AbortError' ? 'Остановлено' : 'Ошибка', e?.name === 'AbortError' ? 'done' : 'error');
  } finally {
    discardCandidate(selected.frame);
    agentController = null;
    ui['stop-agent'].hidden = true;
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
ui['reset-scene'].addEventListener('click', () => {
  if (busy) return;
  disposeScene(ui['preview-frame']);
  activeScene = null;
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
