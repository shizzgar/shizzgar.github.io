// The visible trace is bounded; the export archive retains the complete content
// of this tab's trace. It never invents hidden reasoning or token counts.
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
 * createTracePanel(mount, {redact?, getSecret?, language?, translate?, scrollContainer?})
 * renders a trace into an existing element. scrollContainer is the surrounding
 * conversation scroller; automatic following stops when the reader scrolls up.
 * getSecret returns the current secret before each stream starts; it is required
 * to mask secrets split across streamed chunks. redact handles other fields.
 * begin({preserve:true}) starts a new run while retaining the prior trace;
 * event(e) consumes runAgent events; stage(label,
 * detail?) adds real external stages; toolStart(name,input) returns an opaque
 * id and toolFinish(id,{output,error}) records an actual call's outcome;
 * setDevice(object|array) displays measured
 * capabilities; setMetrics({ttftMs,tokensPerSecond,generatedTokens}) displays
 * measured values only; finish(label) marks the run as ended. exportTrace()
 * returns full JSON/TXT content independent of the visible DOM limits.
 */
export function createTracePanel(mount, {redact = x => x, getSecret = () => '', language = globalThis.document?.documentElement?.lang || 'ru', translate = value => value, scrollContainer = null} = {}) {
  if (!mount || typeof mount.append !== 'function') throw new TypeError('Не найден контейнер трассы.');
  let locale = language === 'en' ? 'en' : 'ru';
  const tr = (ru, en) => locale === 'en' ? en : ru;
  const localeCode = () => locale === 'en' ? 'en-US' : 'ru-RU';
  const bindings = new WeakMap();
  const bind = (node, render) => { bindings.set(node, render); node.textContent = render(); return node; };
  const refresh = node => { const render = bindings.get(node); if (render) node.textContent = render(); for (const child of [...(node.children || [])]) refresh(child); };
  const secrets = new Set();
  function rememberSecret() {
    try { const value = String(getSecret() ?? ''); if (value) secrets.add(value); return value; }
    catch { return null; }
  }
  function protect(value) {
    const current = rememberSecret();
    if (current === null) return '[redaction unavailable]';
    let text = String(value ?? '');
    for (const secret of secrets) text = text.split(secret).join('[redacted]');
    text = text.replace(/\bhf_[A-Za-z0-9]{10,}\b/g, '[redacted]');
    try { return String(redact(text) ?? ''); } catch { return '[redaction unavailable]'; }
  }
  const mask = value => protect(value).slice(0, 3000);
  const shell = value => { try { return mask(translate(String(value ?? ''), locale)); } catch { return mask(value); } };
  let archive = [], sequence = 0, runId = 0;
  const archiveStreams = new Map();
  function serializable(value) {
    const seen = new WeakSet();
    const visit = item => {
      if (typeof item === 'string') return protect(item);
      if (item == null || typeof item === 'boolean') return item;
      if (typeof item === 'number') return Number.isFinite(item) ? item : String(item);
      if (typeof Blob !== 'undefined' && item instanceof Blob) return {kind:'file', name:protect(item.name || ''), type:item.type || '', size:item.size, binaryIncluded:false};
      if (typeof ArrayBuffer !== 'undefined' && (item instanceof ArrayBuffer || ArrayBuffer.isView(item))) return {kind:'binary', byteLength:item.byteLength, binaryIncluded:false};
      if (item instanceof Error || Object.prototype.toString.call(item) === '[object Error]') return {name:protect(item.name), message:protect(item.message), stack:protect(item.stack || '')};
      if (typeof item !== 'object') return String(item);
      if (seen.has(item)) return '[circular reference]';
      seen.add(item);
      if (Array.isArray(item)) return item.map(visit);
      const out = Object.create(null);
      for (const key of Object.keys(item)) { try { out[protect(key)] = visit(item[key]); } catch { out[protect(key)] = '[unavailable]'; } }
      return out;
    };
    return visit(value);
  }
  function record(type, payload = {}) {
    rememberSecret();
    const entry = {sequence:++sequence, runId, timestamp:new Date().toISOString(), elapsedMs:Math.max(0, now() - runStarted), type, ...serializable(payload)};
    archive.push(entry);
    updateExportButtons();
    return entry;
  }
  const root = element('details', 'trace-panel');
  root.open = false;
  const summary = element('summary', 'trace-summary');
  const summaryName = bind(element('span', 'trace-title'), () => tr('✳  Работа агента', '✳  Agent activity'));
  const badge = bind(element('span', 'trace-badge'), () => tr('ОЖИДАНИЕ', 'IDLE'));
  const exportActions = element('span', 'trace-actions');
  const jsonButton = element('button', 'trace-export-button', 'JSON ↓');
  const textButton = element('button', 'trace-export-button', 'TXT ↓');
  for (const button of [jsonButton, textButton]) { button.type = 'button'; button.disabled = true; }
  exportActions.append(jsonButton, textButton);
  summary.append(summaryName, badge, exportActions);
  const body = element('div', 'trace-body');
  const caption = bind(element('p', 'trace-caption'), () => tr('Реальные этапы, ошибки и поток ответа модели.', 'Actual steps, errors and streamed model output.'));
  const meter = element('div', 'trace-metrics');
  const ttftBox = metric('TTFT');
  const tpsBox = metric(() => tr('ТОКЕНОВ / С', 'TOKENS / S'));
  const countBox = metric(() => tr('ТОКЕНОВ', 'TOKENS'));
  meter.append(ttftBox.root, tpsBox.root, countBox.root);
  const feed = element('div', 'trace-feed');
  feed.setAttribute('aria-label', 'Лента событий агента');
  const empty = bind(element('p', 'trace-empty'), () => tr('После запуска здесь появятся действия и ответы агента.', 'Agent actions and responses will appear here when a run starts.'));
  feed.append(empty);
  const machine = element('details', 'trace-machine');
  // Device details remain available without crowding the main conversation.
  machine.open = false;
  const machineSummary = bind(element('summary', ''), () => tr('Устройство и параметры', 'Device and settings'));
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
  let latestDevice = {};

  function updateExportButtons() { jsonButton.disabled = textButton.disabled = archive.length === 0; }
  jsonButton.onclick = event => { event?.preventDefault?.(); event?.stopPropagation?.(); downloadTrace({format:'json'}); };
  textButton.onclick = event => { event?.preventDefault?.(); event?.stopPropagation?.(); downloadTrace({format:'text'}); };

  // The conversation owns the main scroll in the current layout. Preserve the
  // user's position when they have moved up to read an earlier event.
  const scrollTarget = () => scrollContainer || mount.closest?.('.conversation-body') || feed;
  const nearEnd = target => target.scrollHeight - target.scrollTop - target.clientHeight < 36;
  const followEnd = target => { target.scrollTop = Math.max(0, target.scrollHeight - target.clientHeight); };

  function appendFeed(item) {
    const target = scrollTarget();
    const follow = nearEnd(target);
    if (empty.isConnected) empty.remove();
    feed.append(item);
    if (++count > MAX_EVENTS) { feed.firstElementChild?.remove(); count = MAX_EVENTS; }
    if (follow) followEnd(target);
  }

  function metric(label) {
    const root = element('div', 'trace-metric');
    const title = typeof label === 'function' ? bind(element('span', 'trace-metric-label'), label) : element('span', 'trace-metric-label', label);
    const value = element('strong', 'trace-metric-value', '—');
    root.append(title, value);
    return {root, value};
  }
  function tick(label, detail, kind = 'normal') {
    const item = element('div', `trace-event trace-event--${kind}`);
    const dot = element('span', 'trace-event-dot'); dot.setAttribute('aria-hidden', 'true');
    const text = element('div', 'trace-event-text');
    const labelText = typeof label === 'function' ? label : () => shell(label);
    const head = bind(element('strong', ''), labelText);
    const elapsed = Math.max(0, (now() - runStarted) / 1000).toFixed(1);
    const time = bind(element('time', 'trace-event-time'), () => `+${elapsed} ${tr('с', 's')}`);
    text.append(head, time);
    if (detail) text.append(bind(element('p', 'trace-event-detail'), typeof detail === 'function' ? detail : () => shell(detail)));
    item.append(dot, text);
    appendFeed(item);
  }
  function newStream(attempt, maxAttempts, kind = 'content') {
    const box = element('details', 'trace-output-card');
    box.open = true;
    const heading = bind(element('summary', 'trace-output-title'), () => `${kind === 'reasoning' ? tr('Размышления модели', 'Model reasoning') : tr('Ответ модели', 'Model response')} · ${tr('попытка', 'attempt')} ${attempt}${maxAttempts ? `/${maxAttempts}` : ''}`);
    const note = element('p', 'trace-output-note');
    const output = element('pre', 'trace-output');
    output.setAttribute('aria-label', `${kind === 'reasoning' ? 'Поток размышлений' : 'Поток ответа'} модели, попытка ${attempt}`);
    const text = document.createTextNode(''); output.append(text);
    box.append(heading, note, output); appendFeed(box);
    const secret = rememberSecret();
    const archiveEntry = record('model_stream', {attempt, maxAttempts:maxAttempts ?? null, kind, text:'', chunks:0, receivedChars:0, firstChunkMs:null, lastChunkMs:null});
    const state = {box, note, output, text, chars:0, truncated:false, pending:'', secret:secret || '', unavailable:secret === null, archiveEntry};
    archiveStreams.set(archiveEntry.sequence, state);
    bind(note, () => state.chars === 0 ? tr('Ожидаем первые данные…', 'Waiting for the first chunk…') : state.truncated ? tr(`Показан конец ответа: ${state.chars.toLocaleString(localeCode())} символов получено.`, `Showing the end: ${state.chars.toLocaleString(localeCode())} characters received.`) : tr(`Получено ${state.chars.toLocaleString(localeCode())} символов`, `${state.chars.toLocaleString(localeCode())} characters received`));
    attempts.set(`${attempt}:${kind}`, state);
    return state;
  }
  function writeStream(state, value) {
    if (!value) return;
    let safe;
    try { safe = protect(value); }
    catch { safe = '[поток скрыт: ошибка защиты]'; state.unavailable = true; }
    state.text.appendData(safe);
    state.archiveEntry.text += safe;
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
      const measured = measuredTtft;
      bind(ttftBox.value, () => `${(measured / 1000).toFixed(2)} ${tr('с', 's')}`);
      ttftBox.value.title = tr('Время от старта этого этапа генерации до первого текстового фрагмента', 'Time from this generation starting to its first text chunk');
    }
    const follow = nearEnd(state.output);
    const target = scrollTarget();
    const followConversation = nearEnd(target);
    state.chars += event.delta.length;
    state.archiveEntry.chunks++;
    state.archiveEntry.receivedChars = state.chars;
    const elapsedMs = Math.max(0, now() - runStarted);
    state.archiveEntry.firstChunkMs ??= elapsedMs;
    state.archiveEntry.lastChunkMs = elapsedMs;
    streamChunk(state, event.delta);
    state.note.textContent = bindings.get(state.note)();
    if (follow) followEnd(state.output);
    if (followConversation) followEnd(target);
  }
  function begin({preserve = false} = {}) {
    const target = scrollTarget();
    const follow = nearEnd(target);
    flushStreams();
    if (!preserve) { archive = []; archiveStreams.clear(); sequence = 0; runId = 0; }
    runId++;
    runStarted = generationStarted = now(); attempts = new Map(); toolCalls = new Map(); nextTool = 0; stopped = false; measuredTtft = null; lastStatus = '';
    record('begin', {preserve});
    if (!preserve) { feed.replaceChildren(); feed.append(empty); count = 0; }
    else if (count > 0) appendFeed(bind(element('div', 'trace-run-divider'), () => tr('НОВЫЙ ХОД', 'NEW TURN')));
    bind(ttftBox.value, () => '—'); tpsBox.value.textContent = '—'; countBox.value.textContent = '—';
    bind(badge, () => tr('В РАБОТЕ', 'RUNNING')); badge.dataset.state = 'active'; root.open = true;
    if (follow) followEnd(target);
  }
  function event(e = {}) {
    if (e.type === 'token' || e.type === 'reasoning') { addChunk(e); return; }
    record('event', {event:e});
    const attempt = Number.isFinite(e.attempt) ? e.attempt : 0;
    const suffix = () => attempt ? ` · ${tr('попытка', 'attempt')} ${attempt}${e.maxAttempts ? `/${e.maxAttempts}` : ''}` : '';
    if (['generating', 'preflight', 'validating', 'validation_failed', 'unchanged', 'context_loss_repair', 'repairing', 'success', 'failed'].includes(e.type)) flushStreams();
    switch (e.type) {
      case 'generating':
        // TTFT is per generation, including prefill; do not include validation.
        generationStarted = now(); measuredTtft = null; bind(ttftBox.value, () => '—'); tpsBox.value.textContent = '—'; countBox.value.textContent = '—';
        tick(() => `${tr('Генерация', 'Generation')}${suffix()}`); break;
      case 'preflight': tick(() => `${tr('Предварительная проверка', 'Preflight check')}${suffix()}`, () => tr('Проверяю структуру документа и синтаксис обычных скриптов; для проверки отрисовки нужен запуск.', 'Checking the document structure and classic script syntax; rendering requires execution.')); break;
      case 'validating': tick(() => `${tr('Проверка запуска', 'Execution check')}${suffix()}`, () => tr('Запускаю код и отслеживаю ошибки.', 'Running the code and collecting errors.')); break;
      case 'validation_failed': tick(() => `${tr('Ошибка проверки', 'Validation failed')}${suffix()}`, Array.isArray(e.errors) ? e.errors.join('\n') : e.errors, 'error'); break;
      case 'unchanged': tick(() => `${tr('Код не изменился', 'Code unchanged')}${suffix()}`, () => e.retryPlanned ? tr('Повторный запуск пропущен; передаю модели предыдущую ошибку и прошу изменить код.', 'Skipping the repeated run; asking the model to change the code using the previous error.') : tr('Повторный запуск пропущен; лимит попыток исчерпан.', 'Skipping the repeated run; no attempts remain.'), 'error'); break;
      case 'context_loss_repair': tick(() => tr('Потерян WebGL-контекст', 'WebGL context lost'), () => tr('Причина неизвестна; попробую один раз исправить и запустить сцену заново.', 'The cause is unknown; trying one repair and restart.')); break;
      case 'repairing': tick(() => tr('Исправление', 'Repair'), () => tr('Передаю найденные ошибки модели.', 'Passing the observed errors to the model.')); break;
      case 'success': tick(() => tr('Проверка пройдена', 'Validation passed'), () => tr('Ошибок выполнения за время проверки не обнаружено.', 'No execution errors were detected during the check.'), 'success'); break;
      case 'failed': tick(() => e.reason === 'output_limit' ? tr('Достигнут предел генерации', 'Generation limit reached') : tr('Остановлено с ошибкой', 'Stopped with an error'), Array.isArray(e.errors) ? e.errors.join('\n') : e.errors, 'error'); bind(badge, () => tr('ОШИБКА', 'ERROR')); badge.dataset.state = 'error'; break;
      default: if (e.type && e.label) tick(e.label, e.detail);
    }
  }
  function renderDevice() {
    machineContent.replaceChildren();
    const labels = {browser:tr('Браузер','Browser'),gpu:tr('Адаптер WebGPU при проверке','WebGPU adapter at check'),webglGpu:tr('Видеокарта при проверке WebGL','GPU reported by WebGL'),webglNote:tr('Примечание WebGL','WebGL note'),backend:tr('Размещение модели','Model placement'),engineWebgpu:tr('WebGPU в движке','WebGPU in the engine'),modelBuffers:tr('Буферы весов модели','Model weight buffers'),vram:tr('Видеопамять','Video memory'),cores:tr('Логических ядер','Logical cores'),memory:tr('Оперативная память','System memory'),webgpu:tr('Проверка WebGPU','WebGPU check'),threads:tr('Потоки CPU','CPU threads'),context:tr('Запрошенный контекст, токенов','Requested context, tokens'),outputLimit:tr('Потолок вывода, токенов','Output ceiling, tokens'),contextNote:tr('Расход контекста','Context usage'),batch:tr('Размер batch','Batch size'),profile:tr('Профиль','Profile'),note:tr('Примечание','Note')};
    const pairs = Array.isArray(latestDevice) ? latestDevice.map(x => [x?.label, x?.value]) : Object.entries(latestDevice).map(([key,value]) => [labels[key] || key, value]);
    for (const [label,value] of pairs.slice(0, 20)) {
      if (!label) continue;
      const term = element('dt', '', shell(label));
      const description = element('dd', '', shell(value === null || value === undefined || value === '' ? tr('неизвестно', 'unknown') : displayValue(value)));
      machineContent.append(term, description);
    }
    if (!pairs.length) machineContent.append(element('dt', '', tr('Устройство', 'Device')), element('dd', '', tr('Данные пока недоступны', 'No data available yet')));
  }
  function setDevice(data = {}) {
    latestDevice = serializable(data) || {};
    if (Object.keys(latestDevice).length) record('device', {data:latestDevice});
    renderDevice();
  }
  function setMetrics(metrics = {}) {
    record('metrics', {metrics});
    const ttft = safeNumber(metrics.ttftMs, 0);
    const tps = safeNumber(metrics.tokensPerSecond, 2);
    const tokens = safeNumber(metrics.generatedTokens, 0);
    if (ttft !== null) { bind(ttftBox.value, () => `${(Number(ttft) / 1000).toFixed(2)} ${tr('с', 's')}`); ttftBox.value.title = tr('Время до первого ответа модели', 'Time to the first model response'); }
    if (tps !== null) tpsBox.value.textContent = tps;
    if (tokens !== null) countBox.value.textContent = tokens;
  }
  function stage(label, detail = '') {
    record('stage', {label, detail});
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
          if (typeof Blob !== 'undefined' && item instanceof Blob) return tr(`[Файл ${item.type || 'binary'}, ${item.size} байт]`, `[File ${item.type || 'binary'}, ${item.size} bytes]`);
          if (item instanceof ArrayBuffer) return tr(`[Данные, ${item.byteLength} байт]`, `[Data, ${item.byteLength} bytes]`);
          if (typeof item === 'string' && item.startsWith('data:image/')) return tr(`[Кадр изображения, ${item.length} символов]`, `[Image frame, ${item.length} characters]`);
          if (item && typeof item === 'object') {
            if (seen.has(item)) return tr('[повторная ссылка]', '[circular reference]');
            seen.add(item);
          }
          return item;
        }, 2);
      }
    } catch { text = tr('[Не удалось отобразить результат]', '[Unable to display the result]'); }
    text = protect(text);
    if (text.length > MAX_TOOL_CHARS) text = text.slice(0, MAX_TOOL_CHARS) + tr('\n… вывод сокращён', '\n… display truncated');
    return text;
  }
  function toolStart(name, input) {
    const id = ++nextTool;
    record('tool_start', {toolId:id, name, input});
    const box = element('details', 'trace-tool');
    const summary = bind(element('summary', 'trace-tool-summary'), () => `↗ ${shell(name)} · ${tr('выполняется', 'running')}`);
    const label = bind(element('div', 'trace-tool-label'), () => tr('ВХОД', 'INPUT'));
    const pre = bind(element('pre', 'trace-tool-io'), () => formatToolValue(input));
    box.append(summary, label, pre); appendFeed(box);
    toolCalls.set(id, {box,summary,name:protect(name)});
    return id;
  }
  function toolFinish(id, {output, error: failure, screenshot} = {}) {
    const call = toolCalls.get(id);
    if (!call) return;
    const failed = failure !== undefined && failure !== null && failure !== '';
    record('tool_finish', {toolId:id, name:call.name, status:failed ? 'error' : 'done', ...(failed ? {error:failure} : {}), ...(output === undefined ? {} : {output}), ...(typeof screenshot === 'string' && screenshot.length <= 1000000 && /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(screenshot) ? {screenshot} : {})});
    bind(call.summary, () => `${failed ? '!' : '✓'} ${shell(call.name)} · ${failed ? tr('ошибка', 'error') : tr('готово', 'done')}`);
    call.box.dataset.state = failed ? 'error' : 'done';
    const result = element('details', 'trace-tool');
    result.dataset.state = failed ? 'error' : 'done';
    result.open = failed;
    result.append(bind(element('summary', 'trace-tool-summary'), () => `${failed ? '!' : '✓'} ${shell(call.name)} · ${failed ? tr('ошибка', 'error') : tr('результат', 'result')}`));
    const label = bind(element('div', 'trace-tool-label'), () => failed ? tr('ОШИБКА', 'ERROR') : tr('РЕЗУЛЬТАТ', 'RESULT'));
    const value = failed && failure instanceof Error ? failure.message : failed ? failure : output;
    result.append(label, bind(element('pre', 'trace-tool-io'), () => formatToolValue(value)));
    if (failed && output !== undefined) {
      const data = element('details','trace-tool');
      data.append(bind(element('summary','trace-tool-summary'), () => tr('Данные проверки', 'Validation data')),
        bind(element('pre','trace-tool-io'), () => formatToolValue(output)));
      result.append(data);
    }
    // Accept only the bounded JPEG data URL returned by the scene validator.
    // Never load arbitrary URLs, SVG, or remote resources into the parent page.
    if (typeof screenshot === 'string' && screenshot.length <= 1000000 && /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(screenshot)) {
      const image = element('img', 'trace-screenshot');
      image.src = screenshot;
      image.alt = tr('Кадр сцены во время проверки', 'Scene frame during validation');
      result.append(bind(element('div', 'trace-tool-label'), () => tr('КАДР ПРОВЕРКИ', 'VALIDATION FRAME')), image);
    }
    appendFeed(result);
    toolCalls.delete(id);
  }
  function finish(label = null, state = 'done') {
    flushStreams();
    record('finish', {label:label ?? 'Завершено', state});
    stopped = true;
    bind(badge, () => (label === null ? tr('Завершено', 'Finished') : shell(label)).toLocaleUpperCase(localeCode()));
    badge.dataset.state = state;
  }
  function pendingForExport(state) {
    if (!state || !state.pending) return '';
    if (state.unavailable) return '[redaction unavailable]';
    const pending = state.pending;
    let suffix = 0;
    for (const secret of secrets) {
      for (let k = Math.min(secret.length - 1, pending.length); k > suffix; k--) {
        if (pending.endsWith(secret.slice(0, k))) { suffix = k; break; }
      }
    }
    return protect(suffix ? pending.slice(0, -suffix) : pending) + (suffix ? '[redacted]' : '');
  }
  /** A complete, secret-masked snapshot; visible UI limits do not affect it. */
  function getExportData() {
    rememberSecret();
    const events = archive.map(entry => {
      const snapshot = entry.type === 'model_stream'
        ? {...entry, text:entry.text + pendingForExport(archiveStreams.get(entry.sequence))}
        : entry;
      // Re-mask at export time, including secrets entered after an event and
      // arbitrary HF tokens assembled across streamed chunks.
      return serializable(snapshot);
    });
    const currentRunId = events.at(-1)?.runId ?? 0;
    const currentEvents = events.filter(entry => entry.runId === currentRunId);
    const lastFinish = currentEvents.findLast(entry => entry.type === 'finish');
    const pending = new Map();
    for (const entry of currentEvents) {
      if (entry.type === 'tool_start') pending.set(entry.toolId, {toolId:entry.toolId,name:entry.name,startedAt:entry.timestamp});
      if (entry.type === 'tool_finish') pending.delete(entry.toolId);
    }
    const recording = {runId:currentRunId,
      state:lastFinish?.state || (currentEvents.some(entry => entry.type === 'begin' || entry.type === 'tool_start') ? 'running' : 'idle'),
      pendingTools:[...pending.values()]};
    return {
      schema:'forma.agent-trace', schemaVersion:1, exportedAt:new Date().toISOString(),
      appVersion:protect(globalThis.document?.documentElement?.dataset?.appVersion || '') || null, uiLanguage:locale,
      complete:true, archiveTruncated:false, recording,
      streamEncoding:'Complete assembled text, chunk counts and first/last chunk times. Only model-provided reasoning is included.',
      attachments:'File and binary inputs are represented by metadata; their bytes are not retained in the trace.',
      visibleLimits:{events:MAX_EVENTS, streamCharacters:MAX_OUTPUT_CHARS, toolCharacters:MAX_TOOL_CHARS},
      events,
    };
  }
  function exportTrace({format = 'json'} = {}) {
    const data = getExportData();
    const stamp = data.exportedAt.replace(/[:.]/g, '-');
    if (format === 'json') return {filename:`forma-trace-${stamp}.json`, mimeType:'application/json;charset=utf-8', content:JSON.stringify(data, null, 2)};
    if (format !== 'text' && format !== 'txt') throw new TypeError('Unsupported trace format');
    const lines = ['FORMA — AGENT TRACE', `Exported: ${data.exportedAt}`, `Run ${data.recording.runId}: ${data.recording.state}; active tools: ${data.recording.pendingTools.length}`, 'Complete recorded content; secrets redacted; files contain metadata only.', ''];
    for (const entry of data.events) {
      lines.push(`[${entry.sequence}] run ${entry.runId} +${(entry.elapsedMs / 1000).toFixed(3)}s ${entry.type} — ${entry.timestamp}`);
      if (entry.type === 'model_stream') {
        lines.push(`${entry.kind} · attempt ${entry.attempt}${entry.maxAttempts ? `/${entry.maxAttempts}` : ''} · ${entry.chunks} chunks · ${entry.receivedChars} characters`, entry.text);
      } else {
        const {sequence,runId,timestamp,elapsedMs,type,...payload} = entry;
        lines.push(JSON.stringify(payload, null, 2));
      }
      lines.push('');
    }
    return {filename:`forma-trace-${stamp}.txt`, mimeType:'text/plain;charset=utf-8', content:lines.join('\n')};
  }
  function downloadTrace(options) {
    if (!archive.length) return false;
    const exported = exportTrace(options);
    const url = URL.createObjectURL(new Blob([exported.content], {type:exported.mimeType}));
    const link = document.createElement('a'); link.href = url; link.download = exported.filename;
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  }
  function setLanguage(value) {
    locale = value === 'en' ? 'en' : 'ru';
    refresh(root);
    renderDevice();
    feed.setAttribute('aria-label', tr('Лента событий агента', 'Agent event feed'));
    jsonButton.setAttribute('aria-label', tr('Скачать полную трассу в JSON', 'Download the complete trace as JSON'));
    textButton.setAttribute('aria-label', tr('Скачать полную трассу в TXT', 'Download the complete trace as TXT'));
    for (const state of archiveStreams.values()) state.output.setAttribute('aria-label', `${state.archiveEntry.kind === 'reasoning' ? tr('Поток размышлений', 'Reasoning stream') : tr('Поток ответа', 'Response stream')} ${tr('модели, попытка', 'from the model, attempt')} ${state.archiveEntry.attempt}`);
  }
  setDevice({});
  setLanguage(locale);
  return { root, begin, event, stage, toolStart, toolFinish, setDevice, setMetrics, finish, setLanguage, getExportData, exportTrace, downloadTrace, hasTrace:() => archive.length > 0 };
}
