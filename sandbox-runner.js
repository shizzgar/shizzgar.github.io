// Run untrusted model-generated scenes in an opaque-origin sandbox.
// The checks below observe technical execution, not visual quality or correctness.
// A synchronous infinite loop inside an iframe may still block the browser.
const LIBRARY_URL = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/0.160.0/three.module.min.js';
const RUNTIME_LIBRARY_URL = new URL('./vendor/three-r160.module.min.js', import.meta.url).href;
const sessions = new WeakMap();
const releaseSessions = new WeakMap();
// Keep the last generation even after disposal: delayed cleanup from an older
// session must never clear a newer document that has since been disposed.
const latestSessions = new WeakMap();
const MAX_ERRORS = 12;

function createNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, x => x.toString(16).padStart(2, '0')).join('');
}

function bridge(nonce, settleMs, captureImage) {
  // This code runs inside the sandbox before model-generated scripts.
  return `(() => {
  'use strict';
  const nonce = ${JSON.stringify(nonce)};
  const send = (type, payload) => parent.postMessage({channel:'forma-runner-v1', nonce, type, payload}, '*');
  const errors = [];
  let releasing = false;
  const timers = new Set();
  const schedule = (callback, delay) => {
    const id = setTimeout(() => { timers.delete(id); if (!releasing) callback(); }, delay);
    timers.add(id);
    return id;
  };
  const stopTimers = () => { for (const id of timers) clearTimeout(id); timers.clear(); };
  const report = (message, kind = 'script', source = '', location = null) => {
    try {
      if (releasing) return;
      const item = {message:String(message || 'Неизвестная ошибка').slice(0,900), kind, source:String(source || '').slice(0,500)};
      if (location && Number.isSafeInteger(location.line) && location.line > 0) item.line = location.line;
      if (location && Number.isSafeInteger(location.column) && location.column > 0) item.column = location.column;
      if (errors.some(value => value.kind === item.kind && value.source === item.source && value.message === item.message && value.line === item.line && value.column === item.column)) return;
      // Keep the report bounded, but never let a burst of shader errors hide
      // the first context-loss signal or the following JavaScript exception.
      if (kind === 'console' && errors.length >= ${MAX_ERRORS - 2}) return;
      if (errors.length >= ${MAX_ERRORS} && (kind !== 'webgl-context-lost' || errors.some(item => item.kind === 'webgl-context-lost'))) return;
      errors.push(item);
      send('error', item);
    } catch (_) {}
  };
  addEventListener('error', event => {
    const target = event.target;
    if (target && target !== window && (target.src || target.href)) {
      report('Не удалось загрузить ресурс: ' + (target.src || target.href), 'resource', target.src || target.href);
    } else if (String(target?.tagName || '').toUpperCase() === 'SCRIPT' && String(target.type || '').toLowerCase() === 'module' && !event.message && !event.error) {
      // Failed inline-module dependencies produce a plain Event on <script>,
      // with no message/stack/src. It is not evidence of a scene-code error.
      // Only identify our known import; do not interpret arbitrary source.
      const source = String(target.textContent || '');
      const importUrl = [${JSON.stringify(RUNTIME_LIBRARY_URL)}, ${JSON.stringify(LIBRARY_URL)}].find(url => source.includes('"' + url + '"') || source.includes("'" + url + "'")) || '';
      report('Не удалось загрузить или связать модульный скрипт' + (importUrl ? ': ' + importUrl : ' или его зависимости') + '. Браузер не передал подробности ошибки импорта.', 'module-load', importUrl);
    } else {
      const e = event.error;
      report((event.message || e?.message || 'Ошибка выполнения') + (e?.stack ? '\\n' + e.stack : ''), 'script', event.filename || '', {line:event.lineno, column:event.colno});
    }
  }, true);
  addEventListener('unhandledrejection', event => {
    const r = event.reason;
    report(r?.stack || r?.message || r || 'Необработанная ошибка Promise', 'promise');
  });
  addEventListener('securitypolicyviolation', event => {
    // A disallowed import/inline/eval is a generated-code defect, even when
    // the browser also emits an opaque module-load event for that script.
    const directive = String(event.effectiveDirective || '');
    if (!/^script-src(?:-|$)/.test(directive) || event.disposition === 'report') return;
    const blocked = String(event.blockedURI || 'неизвестный источник').slice(0,500);
    report('Политика выполнения сцены заблокировала скрипт (' + directive + '): ' + blocked + '. Используй встроенный код и только разрешённый модуль Three.js core ' + ${JSON.stringify(LIBRARY_URL)} + '; не используй другие импорты, eval или new Function.', 'policy', blocked, {line:event.lineNumber, column:event.columnNumber});
  });
  const originalConsoleError = console.error;
  console.error = function(...args) {
    try { report(args.map(x => x?.stack || x?.message || String(x)).join(' '), 'console'); } catch (_) {}
    return originalConsoleError.apply(this, args);
  };
  const contexts = [];
  // The parent asks the bridge to release the scene while the iframe is still
  // alive. This is best effort: an acknowledgement confirms the request was
  // processed, not that the driver has returned a particular amount of VRAM.
  addEventListener('message', event => {
    const data = event.data;
    if (event.source !== parent || !data || data.channel !== 'forma-runner-v1' || data.nonce !== nonce || data.type !== 'release') return;
    releasing = true;
    stopTimers();
    let requested = 0, unsupported = 0, failed = 0;
    for (const item of contexts) {
      try {
        if (typeof item.ctx.isContextLost === 'function' && item.ctx.isContextLost()) continue;
        const ext = item.ctx.getExtension('WEBGL_lose_context');
        if (!ext || typeof ext.loseContext !== 'function') { unsupported++; continue; }
        ext.loseContext();
        requested++;
      } catch (_) { failed++; }
    }
    send('released', {contexts:contexts.length, requested, unsupported, failed});
  });
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function(type, ...args) {
    const isWebGL = typeof type === 'string' && /^(webgl|experimental-webgl|webgl2)$/i.test(type);
    if (${captureImage} && isWebGL) args[0] = {...(args[0] || {}), preserveDrawingBuffer:true};
    const ctx = getContext.call(this, type, ...args);
    if (ctx && typeof type === 'string' && /^(webgl|experimental-webgl|webgl2)$/i.test(type) && !contexts.some(item => item.ctx === ctx)) {
      const item = {canvas:this, ctx, observed:false, draws:0}; contexts.push(item);
      try {
        this.addEventListener('webglcontextlost', () => report('Потерян контекст WebGL; устройство или браузер не смогли продолжить отрисовку.', 'webgl-context-lost'), {once:true});
      } catch (_) {}
      for (const method of ['drawArrays','drawElements','drawArraysInstanced','drawElementsInstanced']) {
        try {
          const original = ctx[method];
          if (typeof original !== 'function') continue;
          ctx[method] = function(...args) { item.draws++; return original.apply(this, args); };
          if (ctx[method] !== original) item.observed = true;
        } catch (_) {}
      }
      try {
        const getExtension = ctx.getExtension;
        ctx.getExtension = function(...args) {
          const ext = getExtension.apply(this, args);
          if (ext && !ext.__formaObserved) {
            for (const method of ['drawArraysInstancedANGLE','drawElementsInstancedANGLE','multiDrawArraysWEBGL','multiDrawElementsWEBGL','multiDrawArraysInstancedWEBGL','multiDrawElementsInstancedWEBGL']) {
              try {
                const original = ext[method];
                if (typeof original !== 'function') continue;
                ext[method] = function(...args) { item.draws++; return original.apply(this, args); };
              } catch (_) {}
            }
            try { Object.defineProperty(ext, '__formaObserved', {value:true}); } catch (_) {}
          }
          return ext;
        };
      } catch (_) {}
    }
    return ctx;
  };
  // Report state while imports are still pending. window.load can itself be
  // blocked by a slow module, so it cannot be the only diagnostic trigger.
  const now = () => typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
  const started = now();
  let phase = 'boot', loadedAt = null, firstDrawAt = null, readySent = false, pollCount = 0;
  const snapshot = (includeImage = false) => {
    const canvases = Array.from(document.querySelectorAll('canvas'));
    const hasVisibleSize = canvas => {
      const rect = canvas.getBoundingClientRect();
      return canvas.isConnected && canvas.width > 0 && canvas.height > 0 && rect.width > 0 && rect.height > 0;
    };
    const visibleCanvasCount = canvases.filter(hasVisibleSize).length;
    const activeContexts = contexts.filter(item => {
      try { return hasVisibleSize(item.canvas) && (typeof item.ctx.isContextLost !== 'function' || !item.ctx.isContextLost()); }
      catch (_) { return false; }
    });
    const drawCalls = Math.min(1000000, activeContexts.reduce((sum,item) => sum + item.draws, 0));
    let screenshot = null;
    if (includeImage && ${captureImage} && activeContexts.length && drawCalls > 0) {
      try {
        const source = (activeContexts.find(item => item.draws > 0) || activeContexts[0]).canvas;
        const size = Math.min(1, 768 / source.width, 768 / source.height);
        const thumb = document.createElement('canvas');
        thumb.width = Math.max(1, Math.round(source.width * size));
        thumb.height = Math.max(1, Math.round(source.height * size));
        const ctx = thumb.getContext('2d');
        ctx.drawImage(source, 0, 0, thumb.width, thumb.height);
        const value = thumb.toDataURL('image/jpeg', 0.7);
        if (value.startsWith('data:image/jpeg;base64,') && value.length <= 1000000) screenshot = value;
      } catch (_) {}
    }
    return {canvasCount:canvases.length, visibleCanvasCount, webglContexts:activeContexts.length, drawCalls, drawObservationAvailable:activeContexts.some(item => item.observed), screenshot, errors, phase, documentReadyState:String(document.readyState || 'unknown'), loadPending:loadedAt === null, elapsedMs:Math.max(0, Math.round(now() - started))};
  };
  const inspect = () => {
    if (releasing || readySent) return;
    const p = snapshot();
    if (p.webglContexts > 0 && p.drawCalls > 0) { if (firstDrawAt === null) firstDrawAt = now(); }
    else firstDrawAt = null;
    const settledAfterLoad = loadedAt !== null && now() - loadedAt >= ${settleMs};
    const settledDraws = firstDrawAt !== null && now() - firstDrawAt >= ${settleMs};
    if (settledAfterLoad || settledDraws) {
      readySent = true;
      stopTimers();
      send('ready', ${captureImage} ? snapshot(true) : p);
      return;
    }
    send('progress', p);
    // The parent has a bounded deadline too. Stop polling even if a hostile
    // or abandoned document never reaches load; runtime errors stay observed.
    if (++pollCount < 240) schedule(inspect, 250);
  };
  const hasDocument = typeof document !== 'undefined' && typeof document.querySelectorAll === 'function';
  addEventListener('DOMContentLoaded', () => { phase = loadedAt === null ? 'dom-ready' : 'loaded'; }, {once:true});
  addEventListener('load', () => { phase = 'loaded'; loadedAt = now(); }, {once:true});
  addEventListener('pagehide', () => { releasing = true; stopTimers(); }, {once:true});
  if (hasDocument) {
    if (document.readyState === 'complete') { phase = 'loaded'; loadedAt = now(); }
    send('boot', {phase, documentReadyState:String(document.readyState || 'unknown')});
    schedule(inspect, 0);
  }
})();`;
}

// Only the runtime copy uses our versioned, same-site Three.js asset. The
// generated/exported document remains unchanged and works independently.
function runtimeHtml(html) {
  return html.replace(/(["'])https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/three\.js\/0\.160\.0\/three\.module\.min\.js\1/g, (_match, quote) => quote + RUNTIME_LIBRARY_URL + quote);
}

export function makeSandboxDocument(html, nonce, settleMs = 2000, captureImage = false) {
  if (typeof html !== 'string' || !/<html(?:\s[^>]*)?>/i.test(html) || !/<\/html\s*>/i.test(html)) {
    throw new Error('Модель должна вернуть полный HTML-документ.');
  }
  const delay = Math.max(250, Math.min(10000, Math.floor(settleMs) || 2000));
  const policy = `default-src 'none'; script-src 'unsafe-inline' ${RUNTIME_LIBRARY_URL} ${LIBRARY_URL}; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none';`;
  const prefix = `<meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer"><script>${bridge(nonce, delay, Boolean(captureImage))}<\/script>`;
  return '<!doctype html>' + prefix + runtimeHtml(html.replace(/^\s*<!doctype\s+html[^>]*>/i, ''));
}

// The runner prepends an inline bridge and may remove an existing doctype.
// Browser srcdoc stacks therefore refer to a different document from the
// one the model generated. Compute offsets from these exact two documents,
// rather than depending on the current length of the bridge.
function describeOriginalLocation(html, srcdoc, item) {
  if (item.kind === 'resource') return '';
  const match = /^\s*<!doctype\s+html[^>]*>/i.exec(html);
  const removed = match ? match[0] : '';
  const body = runtimeHtml(html.slice(removed.length));
  if (!body || !srcdoc.endsWith(body)) return '';
  const prefix = srcdoc.slice(0, srcdoc.length - body.length);
  const normalize = value => value.replace(/\r\n?/g, '\n');
  const prefixNormalized = normalize(prefix);
  const removedNormalized = normalize(removed);
  const sourceLines = normalize(html).split('\n');
  const countLines = value => (value.match(/\n/g) || []).length;
  const insertedLines = countLines(prefixNormalized);
  const removedLines = countLines(removedNormalized);
  const locations = [];
  if (item.source === 'about:srcdoc' && Number.isSafeInteger(item.line) && item.line > 0) {
    locations.push({line:item.line, column:item.column});
  }
  for (const location of item.message.matchAll(/\babout:srcdoc:(\d+)(?::(\d+))?/g)) {
    locations.push({line:Number(location[1]), column:location[2] ? Number(location[2]) : null});
  }
  const firstBodyLine = insertedLines + 1;
  for (const location of locations) {
    if (!Number.isSafeInteger(location.line) || location.line < firstBodyLine) continue;
    if (location.column != null && (!Number.isSafeInteger(location.column) || location.column <= 0)) continue;
    // The final bridge line and the start of the generated HTML can share a
    // line. Without a column we cannot tell which side produced the error.
    let sourceColumn = location.column;
    if (location.line === firstBodyLine) {
      const boundary = prefixNormalized.length - prefixNormalized.lastIndexOf('\n') - 1;
      if (location.column == null || location.column <= boundary) continue;
      const removedTail = removedNormalized.length - removedNormalized.lastIndexOf('\n') - 1;
      sourceColumn = location.column - boundary + removedTail;
    }
    const sourceLine = location.line - insertedLines + removedLines;
    if (!Number.isSafeInteger(sourceLine) || sourceLine < 1 || sourceLine > sourceLines.length) continue;
    // Replacing a CDN URL preserves lines, but can shift columns on an import
    // line. Map a reported runtime column back to the original document.
    if (Number.isSafeInteger(sourceColumn) && sourceColumn > 0) {
      const line = sourceLines[sourceLine - 1];
      let shift = 0;
      for (const match of line.matchAll(/(["'])https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/three\.js\/0\.160\.0\/three\.module\.min\.js\1/g)) {
        const start = match.index + 1 + shift;
        const offset = sourceColumn - 1;
        if (offset < start) break;
        if (offset < start + RUNTIME_LIBRARY_URL.length) {
          sourceColumn = match.index + 2 + Math.min(offset - start, LIBRARY_URL.length);
          shift = 0;
          break;
        }
        shift += RUNTIME_LIBRARY_URL.length - LIBRARY_URL.length;
      }
      if (shift) sourceColumn -= shift;
    }
    const lines = [];
    for (let i = Math.max(1, sourceLine - 1); i <= Math.min(sourceLines.length, sourceLine + 1); i++) {
      const text = sourceLines[i - 1];
      let excerpt = text;
      if (text.length > 180) {
        const focus = i === sourceLine && Number.isSafeInteger(sourceColumn) && sourceColumn > 0 && sourceColumn <= text.length + 1 ? sourceColumn - 1 : 0;
        const start = Math.max(0, Math.min(text.length - 180, focus - 60));
        excerpt = (start ? '…' : '') + text.slice(start, start + 180) + (start + 180 < text.length ? '…' : '');
      }
      lines.push(`${i === sourceLine ? '>' : ' '} ${i} | ${excerpt}`);
    }
    return `Исходный HTML, строка ${sourceLine} (по стеку about:srcdoc; фрагмент кода):\n${lines.join('\n')}`;
  }
  return '';
}

/** Stop listening to a previous scene without reloading it. */
export function disposeScene(iframe) {
  const dispose = sessions.get(iframe);
  if (dispose) dispose();
}

/** Ask a live sandbox to release WebGL before its iframe is removed.
 * Acknowledgement is not confirmation of GPU memory reclamation. */
export async function releaseScene(iframe, {timeoutMs = 1000} = {}) {
  const session = iframe && releaseSessions.get(iframe);
  if (!session) {
    if (iframe) disposeScene(iframe);
    return {acknowledged:false};
  }
  const timeout = Math.max(100, Math.min(5000, Math.floor(timeoutMs) || 1000));
  const result = await new Promise(resolve => {
    let done = false;
    let timer;
    const finish = value => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      resolve(value);
    };
    const onMessage = event => {
      const data = event.data;
      if (event.source !== session.target || !data || data.channel !== 'forma-runner-v1' || data.nonce !== session.nonce || data.type !== 'released') return;
      const p = data.payload;
      const isCount = value => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000;
      if (!p || ![p.contexts, p.requested, p.unsupported, p.failed].every(isCount)) return;
      finish({acknowledged:true, contexts:p.contexts, requested:p.requested, unsupported:p.unsupported, failed:p.failed});
    };
    window.addEventListener('message', onMessage);
    timer = setTimeout(() => finish({acknowledged:false}), timeout);
    try { session.target.postMessage({channel:'forma-runner-v1', nonce:session.nonce, type:'release'}, '*'); }
    catch (_) { finish({acknowledged:false}); }
  });
  // A later validateScene call may already have installed a new session.
  if (releaseSessions.get(iframe) === session) disposeScene(iframe);
  return result;
}

/**
 * Execute a scene in an iframe already attached to the DOM. For meaningful
 * canvas-size checks the frame needs dimensions and must not be display:none.
 * Resolves {ok, errors, warnings, retryable, evidence}; onRuntimeError receives
 * subsequent diagnostics until disposeScene or a later validation call.
 */
export function validateScene({iframe, html, signal, timeoutMs = 15000, settleMs = 2000, captureImage = false, onRuntimeError = () => {}} = {}) {
  if (!iframe || !iframe.isConnected) return Promise.reject(new Error('Для проверки нужен iframe, добавленный в документ.'));
  if (signal?.aborted) return Promise.reject(new DOMException('Проверка отменена.', 'AbortError'));
  disposeScene(iframe);
  const nonce = createNonce();
  const srcdoc = makeSandboxDocument(html, nonce, settleMs, captureImage);
  const timeout = Math.max(1000, Math.min(60000, Math.floor(timeoutMs) || 15000));
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.setAttribute('referrerpolicy', 'no-referrer');

  return new Promise((resolve, reject) => {
    const observed = [];
    let ended = false;
    let disposed = false;
    let timer;
    let lastSnapshot = null;
    let phase = 'awaiting-bridge';
    let documentReadyState = 'unknown';
    const releaseSession = {nonce, target:iframe.contentWindow};
    const cleanup = () => {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      signal?.removeEventListener('abort', onAbort);
      if (sessions.get(iframe) === dispose) sessions.delete(iframe);
      if (releaseSessions.get(iframe) === releaseSession) releaseSessions.delete(iframe);
    };
    const releaseCandidate = callback => {
      // Don't release or clear a newer validation using the same iframe.
      let release;
      try { release = releaseSessions.get(iframe) === releaseSession ? releaseScene(iframe) : null; }
      catch (_) { if (releaseSessions.get(iframe) === releaseSession) cleanup(); }
      Promise.resolve(release).catch(() => { if (releaseSessions.get(iframe) === releaseSession) cleanup(); }).then(() => {
        if (latestSessions.get(iframe) === releaseSession) iframe.srcdoc = '';
        callback();
      });
    };
    const finish = result => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (result.ok) { resolve(result); return; }
      // Failed candidates can still own live WebGL resources.
      releaseCandidate(() => resolve(result));
    };
    const onAbort = () => {
      if (ended) { cleanup(); return; }
      ended = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      releaseCandidate(() => reject(new DOMException('Проверка отменена.', 'AbortError')));
    };
    const dispose = () => {
      if (!ended) onAbort();
      else cleanup();
    };
    const appendError = item => {
      if (!item || typeof item.message !== 'string') return;
      const value = {
        message: item.message.slice(0,900),
        rawMessage: item.message.slice(0,900),
        kind: typeof item.kind === 'string' ? item.kind.slice(0,40) : 'script',
        source: typeof item.source === 'string' ? item.source.slice(0,500) : '',
      };
      if (Number.isSafeInteger(item.line) && item.line > 0) value.line = item.line;
      if (Number.isSafeInteger(item.column) && item.column > 0) value.column = item.column;
      const originalLocation = describeOriginalLocation(html, srcdoc, value);
      if (originalLocation) value.message = `${originalLocation}\n\n${value.message}`;
      if (observed.some(previous => previous.kind === value.kind && previous.source === value.source && previous.message === value.message)) return;
      if (value.kind === 'console' && observed.length >= MAX_ERRORS - 2) return;
      if (observed.length >= MAX_ERRORS && (value.kind !== 'webgl-context-lost' || observed.some(previous => previous.kind === 'webgl-context-lost'))) return;
      observed.push(value);
      if (ended) { try { onRuntimeError(value); } catch (_) {} }
    };
    const updatePhase = payload => {
      if (['boot','dom-ready','loaded'].includes(payload?.phase)) phase = payload.phase;
      if (['loading','interactive','complete','unknown'].includes(payload?.documentReadyState)) documentReadyState = payload.documentReadyState;
    };
    const acceptSnapshot = p => {
      if (!p || typeof p !== 'object') return false;
      const isCount = value => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000;
      if (![p.canvasCount,p.visibleCanvasCount,p.webglContexts,p.drawCalls].every(isCount)) return false;
      updatePhase(p);
      if (Array.isArray(p.errors)) for (const item of p.errors.slice(0,MAX_ERRORS + 1)) appendError(item);
      const evidence = {canvasCount:p.canvasCount, visibleCanvasCount:p.visibleCanvasCount, webglContexts:p.webglContexts, drawCalls:p.drawCalls, drawObservationAvailable:!!p.drawObservationAvailable};
      const screenshot = captureImage && typeof p.screenshot === 'string' && p.screenshot.startsWith('data:image/jpeg;base64,') && p.screenshot.length <= 1000000 ? p.screenshot : null;
      lastSnapshot = {evidence, screenshot, loadPending:p.loadPending === true};
      return true;
    };
    const classifyDiagnostics = () => {
      const contextLost = observed.some(item => item.kind === 'webgl-context-lost');
      const scriptPolicy = observed.some(item => item.kind === 'policy');
      const moduleLoad = !scriptPolicy && observed.some(item => item.kind === 'module-load');
      const libraryResource = !scriptPolicy && observed.some(item => item.kind === 'resource' && (item.source.startsWith(LIBRARY_URL) || item.source.startsWith(RUNTIME_LIBRARY_URL)));
      const contextUnavailable = observed.some(item => /error creating webgl context|webgl is not supported/i.test(item.message));
      return {
        contextLost,
        scriptPolicy,
        infrastructureErrorOther:moduleLoad || libraryResource || contextUnavailable,
        infrastructureFailure:moduleLoad ? 'module-load' : libraryResource ? 'resource' : null,
        codeError:observed.some(item => ['script','promise','console','policy'].includes(item.kind)),
      };
    };
    const resultFromSnapshot = (timedOut = false) => {
      const evidence = lastSnapshot?.evidence || null;
      const diagnostics = classifyDiagnostics();
      const errors = observed.map(item => item.message);
      const warnings = [];
      if (timedOut) {
        errors.push('Сцена не завершила запуск за отведённое время. Проверь доступность Three.js и работу браузера.');
      } else if (evidence) {
        if (evidence.canvasCount === 0) errors.push('В сцене не появился canvas для 3D-рендеринга.');
        else if (evidence.visibleCanvasCount === 0) errors.push('Canvas сцены не имеет видимого размера.');
        // Don't turn a failed module download into a misleading scene-code
        // diagnosis, or claim that a lost context was never created.
        if (evidence.webglContexts === 0 && !diagnostics.contextLost && !diagnostics.infrastructureErrorOther && !diagnostics.scriptPolicy) errors.push('Активный WebGL-контекст не обнаружен.');
        if (evidence.webglContexts > 0 && evidence.drawCalls === 0) {
          if (evidence.drawObservationAvailable) errors.push('WebGL-контекст есть, но вызовы отрисовки не обнаружены; сцена может быть пустой.');
          else warnings.push('Не удалось проверить вызовы WebGL-отрисовки.');
        }
      }
      const screenshot = lastSnapshot?.screenshot || null;
      if (captureImage && !screenshot) warnings.push('Не удалось получить изображение сцены для визуальной проверки.');
      if (!timedOut && lastSnapshot?.loadPending) warnings.push('Сцена уже рисует, но загрузка документа ещё не завершена; ошибки продолжают отслеживаться.');
      // A timeout without a real code error is not a reason to regenerate the
      // whole scene. Keep prior exceptions and context-loss semantics intact.
      const startupTimeout = timedOut && !diagnostics.codeError && !diagnostics.contextLost && !diagnostics.infrastructureErrorOther;
      const infrastructureErrorOther = diagnostics.infrastructureErrorOther || startupTimeout;
      return {
        ok:errors.length === 0,
        errors, warnings,
        retryable:!(diagnostics.contextLost || infrastructureErrorOther),
        contextLost:diagnostics.contextLost,
        infrastructureErrorOther,
        infrastructureFailure:diagnostics.infrastructureFailure || (startupTimeout ? 'startup-timeout' : null),
        diagnostics:observed.map(item => ({...item})),
        evidence, screenshot, phase, documentReadyState, timedOut,
      };
    };
    const onMessage = event => {
      const data = event.data;
      if (event.source !== iframe.contentWindow || !data || data.channel !== 'forma-runner-v1' || data.nonce !== nonce || typeof data.type !== 'string') return;
      if (data.type === 'error') { appendError(data.payload); return; }
      if (ended) return;
      if (data.type === 'boot') { updatePhase(data.payload); return; }
      if (data.type === 'progress') { acceptSnapshot(data.payload); return; }
      if (data.type !== 'ready' || !acceptSnapshot(data.payload)) return;
      finish(resultFromSnapshot());
    };
    sessions.set(iframe, dispose);
    releaseSessions.set(iframe, releaseSession);
    latestSessions.set(iframe, releaseSession);
    window.addEventListener('message', onMessage);
    signal?.addEventListener('abort', onAbort, {once:true});
    timer = setTimeout(() => finish(resultFromSnapshot(true)), timeout);
    iframe.srcdoc = srcdoc;
  });
}
