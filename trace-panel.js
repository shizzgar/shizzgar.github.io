// Visible, bounded execution trace. This renders only actual events/model output;
// it does not claim to expose hidden reasoning or treat streamed chunks as tokens.
const MAX_OUTPUT_CHARS = 240000;
const MAX_EVENTS = 120;
const MAX_TOOL_CHARS = 120000;
const now = () => typeof performance !== 'undefined' ? performance.now() : Date.now();

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}
function safeNumber(value, decimals = 1) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value.toFixed(decimals) : null;
}
function displayValue(value) {
  if (value === null || value === undefined || value === '') return 'неизвестно';
  return String(value).slice(0, 200);
}

/**
 * createTracePanel(mount, {redact?, getSecret?}) renders a trace into an existing element.
 * getSecret returns the current secret before each stream starts; it is required
 * to mask secrets split across streamed chunks. redact handles other fields.
 * begin({preserve:true}) starts a new run while retaining the prior trace;
 * event(e) consumes runAgent events; stage(label,
 * detail?) adds real external stages; toolStart(name,input) returns an opaque
 * id and toolFinish(id,{output,error}) records an actual call's outcome;
 * setDevice(object|array) displays measured
 * capabilities; setMetrics({ttftMs,tokensPerSecond,generatedTokens}) displays
 * measured values only; finish(label) marks the run as ended.
 */
export function createTracePanel(mount, {redact = x => x, getSecret = () => ''} = {}) {
  if (!mount || typeof mount.append !== 'function') throw new TypeError('Не найден контейнер трассы.');
  const mask = value => String(redact(String(value ?? '')) ?? '').slice(0, 3000);
  const root = element('details', 'trace-panel');
  root.open = true;
  const summary = element('summary', 'trace-summary');
  const summaryName = element('span', 'trace-title', '✳  Работа агента');
  const badge = element('span', 'trace-badge', 'ОЖИДАНИЕ');
  summary.append(summaryName, badge);
  const body = element('div', 'trace-body');
  const caption = element('p', 'trace-caption', 'Реальные этапы, ошибки и поток ответа модели.');
  const meter = element('div', 'trace-metrics');
  const ttftBox = metric('TTFT');
  const tpsBox = metric('ТОКЕНОВ / С');
  const countBox = metric('ТОКЕНОВ');
  meter.append(ttftBox.root, tpsBox.root, countBox.root);
  const feed = element('div', 'trace-feed');
  feed.setAttribute('aria-label', 'Лента событий агента');
  const empty = element('p', 'trace-empty', 'После запуска здесь появятся действия и ответы агента.');
  feed.append(empty);
  const machine = element('details', 'trace-machine');
  // The browser profile is useful before downloading multi-gigabyte weights.
  machine.open = true;
  const machineSummary = element('summary', '', 'Устройство и параметры');
  const machineContent = element('dl', 'trace-machine-grid');
  machine.append(machineSummary, machineContent);
  body.append(caption, meter, feed, machine);
  root.append(summary, body);
  mount.append(root);
  let runStarted = now();
  let generationStarted = runStarted;
  let attempts = new Map();
  let toolCalls = new Map();
  let nextTool = 0;
  let count = 0;
  let stopped = false;
  let measuredTtft = null;
  let lastStatus = '';

  function appendFeed(item) {
    const follow = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 36;
    if (empty.isConnected) empty.remove();
    feed.append(item);
    if (++count > MAX_EVENTS) { feed.firstElementChild?.remove(); count = MAX_EVENTS; }
    if (follow) feed.scrollTop = feed.scrollHeight;
  }

  function metric(label) {
    const root = element('div', 'trace-metric');
    const title = element('span', 'trace-metric-label', label);
    const value = element('strong', 'trace-metric-value', '—');
    root.append(title, value);
    return {root, value};
  }
  function tick(label, detail, kind = 'normal') {
    const item = element('div', `trace-event trace-event--${kind}`);
    const dot = element('span', 'trace-event-dot'); dot.setAttribute('aria-hidden', 'true');
    const text = element('div', 'trace-event-text');
    const head = element('strong', '', mask(label));
    const time = element('time', 'trace-event-time', `+${Math.max(0, (now() - runStarted) / 1000).toFixed(1)} с`);
    text.append(head, time);
    if (detail) text.append(element('p', 'trace-event-detail', mask(detail)));
    item.append(dot, text);
    appendFeed(item);
  }
  function newStream(attempt, maxAttempts, kind = 'content') {
    const box = element('details', 'trace-output-card');
    box.open = true;
    const heading = element('summary', 'trace-output-title', `${kind === 'reasoning' ? 'Размышления модели' : 'Ответ модели'} · попытка ${attempt}${maxAttempts ? `/${maxAttempts}` : ''}`);
    const note = element('p', 'trace-output-note', 'Ожидаем первые данные…');
    const output = element('pre', 'trace-output');
    output.setAttribute('aria-label', `${kind === 'reasoning' ? 'Поток размышлений' : 'Поток ответа'} модели, попытка ${attempt}`);
    const text = document.createTextNode(''); output.append(text);
    box.append(heading, note, output); appendFeed(box);
    let secret, unavailable = false;
    try { secret = String(getSecret() ?? ''); } catch { secret = ''; unavailable = true; }
    const state = {box, note, output, text, chars:0, truncated:false, pending:'', secret, unavailable};
    attempts.set(`${attempt}:${kind}`, state);
    return state;
  }
  function writeStream(state, value) {
    if (!value) return;
    let safe;
    try { safe = String(redact(value) ?? ''); }
    catch { safe = '[поток скрыт: ошибка защиты]'; state.unavailable = true; }
    state.text.appendData(safe);
    if (state.text.data.length > MAX_OUTPUT_CHARS) {
      state.text.data = state.text.data.slice(-MAX_OUTPUT_CHARS);
      state.truncated = true;
    }
  }
  function streamChunk(state, delta, final = false) {
    if (state.unavailable) {
      if (!state.text.data) writeStream(state, '[поток скрыт: ошибка защиты]');
      return;
    }
    state.pending += delta;
    const secret = state.secret;
    if (!secret) { writeStream(state, state.pending); state.pending = ''; return; }
    if (final) {
      // Even an incomplete secret at the end must not be displayed.
      let suffix = 0;
      for (let k = Math.min(secret.length - 1, state.pending.length); k > 0; k--) {
        if (state.pending.endsWith(secret.slice(0, k))) { suffix = k; break; }
      }
      const head = suffix ? state.pending.slice(0, -suffix) : state.pending;
      writeStream(state, head.split(secret).join('[скрыто]') + (suffix ? '[скрыто]' : ''));
      state.pending = '';
      return;
    }
    const cut = Math.max(0, state.pending.length - secret.length + 1);
    let pos = 0, safe = '';
    while (pos < cut) {
      const match = state.pending.indexOf(secret, pos);
      if (match < 0 || match >= cut) { safe += state.pending.slice(pos, cut); pos = cut; }
      else { safe += state.pending.slice(pos, match) + '[скрыто]'; pos = match + secret.length; }
    }
    state.pending = state.pending.slice(pos);
    writeStream(state, safe);
  }
  function flushStreams() {
    for (const state of attempts.values()) streamChunk(state, '', true);
  }
  function addChunk(event) {
    if (stopped || typeof event.delta !== 'string' || !event.delta) return;
    const attempt = Number.isFinite(event.attempt) ? event.attempt : 1;
    const kind = event.type === 'reasoning' ? 'reasoning' : 'content';
    const state = attempts.get(`${attempt}:${kind}`) || newStream(attempt, event.maxAttempts, kind);
    if (measuredTtft === null) {
      measuredTtft = Math.max(0, now() - generationStarted);
      ttftBox.value.textContent = `${(measuredTtft / 1000).toFixed(2)} с`;
      ttftBox.value.title = 'Время от старта этого этапа генерации до первого текстового фрагмента';
    }
    const follow = state.output.scrollHeight - state.output.scrollTop - state.output.clientHeight < 36;
    const followFeed = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 36;
    state.chars += event.delta.length;
    streamChunk(state, event.delta);
    state.note.textContent = state.truncated ? `Показан конец ответа: ${state.chars.toLocaleString('ru-RU')} символов получено.` : `Получено ${state.chars.toLocaleString('ru-RU')} символов`;
    if (follow) state.output.scrollTop = state.output.scrollHeight;
    if (followFeed) feed.scrollTop = feed.scrollHeight;
  }
  function begin({preserve = false} = {}) {
    flushStreams();
    runStarted = generationStarted = now(); attempts = new Map(); toolCalls = new Map(); nextTool = 0; stopped = false; measuredTtft = null; lastStatus = '';
    if (!preserve) { feed.replaceChildren(); feed.append(empty); count = 0; }
    else if (count > 0) appendFeed(element('div', 'trace-run-divider', 'НОВЫЙ ХОД'));
    ttftBox.value.textContent = '—'; tpsBox.value.textContent = '—'; countBox.value.textContent = '—';
    badge.textContent = 'В РАБОТЕ'; badge.dataset.state = 'active'; root.open = true;
  }
  function event(e = {}) {
    if (e.type === 'token' || e.type === 'reasoning') { addChunk(e); return; }
    const attempt = Number.isFinite(e.attempt) ? e.attempt : 0;
    const suffix = attempt ? ` · попытка ${attempt}${e.maxAttempts ? `/${e.maxAttempts}` : ''}` : '';
    if (['generating', 'validating', 'validation_failed', 'repairing', 'success', 'failed'].includes(e.type)) flushStreams();
    switch (e.type) {
      case 'generating':
        // TTFT is per generation, including prefill; do not include validation.
        generationStarted = now(); measuredTtft = null; ttftBox.value.textContent = '—'; tpsBox.value.textContent = '—'; countBox.value.textContent = '—';
        tick(`Генерация${suffix}`); break;
      case 'validating': tick(`Проверка запуска${suffix}`, 'Запускаю код и отслеживаю ошибки.'); break;
      case 'validation_failed': tick(`Ошибка проверки${suffix}`, Array.isArray(e.errors) ? e.errors.join('\n') : e.errors, 'error'); break;
      case 'repairing': tick('Исправление', 'Передаю найденные ошибки модели.'); break;
      case 'success': tick('Проверка пройдена', 'Ошибок выполнения за время проверки не обнаружено.', 'success'); break;
      case 'failed': tick('Остановлено с ошибкой', Array.isArray(e.errors) ? e.errors.join('\n') : e.errors, 'error'); badge.textContent = 'ОШИБКА'; badge.dataset.state = 'error'; break;
      default: if (e.type && e.label) tick(e.label, e.detail);
    }
  }
  function setDevice(data = {}) {
    machineContent.replaceChildren();
    const labels = {browser:'Браузер',gpu:'Адаптер WebGPU при проверке',webglGpu:'Видеокарта при проверке WebGL',webglNote:'Примечание WebGL',backend:'Размещение модели',engineWebgpu:'WebGPU в движке',modelBuffers:'Буферы весов модели',vram:'Видеопамять',cores:'Логических ядер',memory:'Оперативная память',webgpu:'Проверка WebGPU',threads:'Потоки CPU',context:'Контекст',batch:'Размер batch',profile:'Профиль',note:'Примечание'};
    const pairs = Array.isArray(data) ? data.map(x => [x?.label, x?.value]) : Object.entries(data).map(([key,value]) => [labels[key] || key, value]);
    for (const [label,value] of pairs.slice(0, 20)) {
      if (!label) continue;
      const term = element('dt', '', mask(label));
      const description = element('dd', '', mask(displayValue(value)));
      machineContent.append(term, description);
    }
    if (!pairs.length) machineContent.append(element('dt', '', 'Устройство'), element('dd', '', 'Данные пока недоступны'));
  }
  function setMetrics(metrics = {}) {
    const ttft = safeNumber(metrics.ttftMs, 0);
    const tps = safeNumber(metrics.tokensPerSecond, 2);
    const tokens = safeNumber(metrics.generatedTokens, 0);
    if (ttft !== null) { ttftBox.value.textContent = `${(Number(ttft) / 1000).toFixed(2)} с`; ttftBox.value.title = 'Время до первого ответа модели'; }
    if (tps !== null) tpsBox.value.textContent = tps;
    if (tokens !== null) countBox.value.textContent = tokens;
  }
  function stage(label, detail = '') {
    const text = mask(label);
    if (!text) return;
    if (text === lastStatus && !detail) return;
    lastStatus = text;
    tick(text, detail);
  }
  function formatToolValue(value) {
    let text;
    try {
      if (typeof value === 'string') text = value;
      else {
        const seen = new WeakSet();
        text = JSON.stringify(value, (_key, item) => {
          if (typeof Blob !== 'undefined' && item instanceof Blob) return `[Файл ${item.type || 'binary'}, ${item.size} байт]`;
          if (item instanceof ArrayBuffer) return `[Данные, ${item.byteLength} байт]`;
          if (typeof item === 'string' && item.startsWith('data:image/')) return `[Кадр изображения, ${item.length} символов]`;
          if (item && typeof item === 'object') {
            if (seen.has(item)) return '[повторная ссылка]';
            seen.add(item);
          }
          return item;
        }, 2);
      }
    } catch { text = '[Не удалось отобразить результат]'; }
    text = String(redact(String(text ?? '')) ?? '');
    if (text.length > MAX_TOOL_CHARS) text = text.slice(0, MAX_TOOL_CHARS) + '\n… вывод сокращён';
    return text;
  }
  function toolStart(name, input) {
    const id = ++nextTool;
    const box = element('details', 'trace-tool');
    const summary = element('summary', 'trace-tool-summary', `↗ ${mask(name)} · выполняется`);
    const label = element('div', 'trace-tool-label', 'ВХОД');
    const pre = element('pre', 'trace-tool-io', formatToolValue(input));
    box.append(summary, label, pre); appendFeed(box);
    toolCalls.set(id, {box,summary,name:mask(name)});
    return id;
  }
  function toolFinish(id, {output, error: failure, screenshot} = {}) {
    const call = toolCalls.get(id);
    if (!call) return;
    const failed = failure !== undefined && failure !== null && failure !== '';
    call.summary.textContent = `${failed ? '!' : '✓'} ${call.name} · ${failed ? 'ошибка' : 'готово'}`;
    call.box.dataset.state = failed ? 'error' : 'done';
    const result = element('details', 'trace-tool');
    result.dataset.state = failed ? 'error' : 'done';
    result.open = failed;
    result.append(element('summary', 'trace-tool-summary', `${failed ? '!' : '✓'} ${call.name} · ${failed ? 'ошибка' : 'результат'}`));
    const label = element('div', 'trace-tool-label', failed ? 'ОШИБКА' : 'РЕЗУЛЬТАТ');
    const value = failed && failure instanceof Error ? failure.message : failed ? failure : output;
    result.append(label, element('pre', 'trace-tool-io', formatToolValue(value)));
    // Accept only the bounded JPEG data URL returned by the scene validator.
    // Never load arbitrary URLs, SVG, or remote resources into the parent page.
    if (typeof screenshot === 'string' && screenshot.length <= 1000000 && /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(screenshot)) {
      const image = element('img', 'trace-screenshot');
      image.src = screenshot;
      image.alt = 'Кадр сцены во время проверки';
      result.append(element('div', 'trace-tool-label', 'КАДР ПРОВЕРКИ'), image);
    }
    appendFeed(result);
    toolCalls.delete(id);
  }
  function finish(label = 'Завершено', state = 'done') {
    flushStreams();
    stopped = true;
    badge.textContent = mask(label).toLocaleUpperCase('ru-RU');
    badge.dataset.state = state;
  }
  setDevice({});
  return { root, begin, event, stage, toolStart, toolFinish, setDevice, setMetrics, finish };
}
