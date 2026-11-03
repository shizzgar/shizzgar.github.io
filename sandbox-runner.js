// Run untrusted model-generated scenes in an opaque-origin sandbox.
// The checks below observe technical execution, not visual quality or correctness.
// A synchronous infinite loop inside an iframe may still block the browser.
const LIBRARY_URL = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/0.160.0/three.module.min.js';
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
  const report = (message, kind = 'script', source = '') => {
    try {
      if (releasing) return;
      // Keep the report bounded, but never let a burst of shader errors hide
      // the first context-loss signal needed for resource recovery.
      if (errors.length >= ${MAX_ERRORS} && (kind !== 'webgl-context-lost' || errors.some(item => item.kind === 'webgl-context-lost'))) return;
      const item = {message:String(message || 'Неизвестная ошибка').slice(0,900), kind, source:String(source || '').slice(0,500)};
      errors.push(item);
      send('error', item);
    } catch (_) {}
  };
  addEventListener('error', event => {
    const target = event.target;
    if (target && target !== window && (target.src || target.href)) {
      report('Не удалось загрузить ресурс: ' + (target.src || target.href), 'resource', target.src || target.href);
    } else {
      const e = event.error;
      report((event.message || e?.message || 'Ошибка выполнения') + (e?.stack ? '\\n' + e.stack : ''), 'script', event.filename || '');
    }
  }, true);
  addEventListener('unhandledrejection', event => {
    const r = event.reason;
    report(r?.stack || r?.message || r || 'Необработанная ошибка Promise', 'promise');
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
  addEventListener('load', () => setTimeout(() => {
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
    if (${captureImage} && activeContexts.length && drawCalls > 0) {
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
    send('ready', {canvasCount:canvases.length, visibleCanvasCount, webglContexts:activeContexts.length, drawCalls, drawObservationAvailable:activeContexts.some(item => item.observed), screenshot, errors});
  }, ${settleMs}), {once:true});
})();`;
}

export function makeSandboxDocument(html, nonce, settleMs = 2000, captureImage = false) {
  if (typeof html !== 'string' || !/<html(?:\s[^>]*)?>/i.test(html) || !/<\/html\s*>/i.test(html)) {
    throw new Error('Модель должна вернуть полный HTML-документ.');
  }
  const delay = Math.max(250, Math.min(10000, Math.floor(settleMs) || 2000));
  const policy = `default-src 'none'; script-src 'unsafe-inline' ${LIBRARY_URL}; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; navigate-to 'none';`;
  const prefix = `<meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer"><script>${bridge(nonce, delay, Boolean(captureImage))}<\/script>`;
  return '<!doctype html>' + prefix + html.replace(/^\s*<!doctype\s+html[^>]*>/i, '');
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
      if (observed.length >= MAX_ERRORS && (item.kind !== 'webgl-context-lost' || observed.some(value => value.kind === 'webgl-context-lost'))) return;
      const value = {
        message: item.message.slice(0,900),
        kind: typeof item.kind === 'string' ? item.kind.slice(0,40) : 'script',
        source: typeof item.source === 'string' ? item.source.slice(0,500) : '',
      };
      observed.push(value);
      if (ended) { try { onRuntimeError(value); } catch (_) {} }
    };
    const onMessage = event => {
      const data = event.data;
      if (event.source !== iframe.contentWindow || !data || data.channel !== 'forma-runner-v1' || data.nonce !== nonce || typeof data.type !== 'string') return;
      if (data.type === 'error') { appendError(data.payload); return; }
      if (data.type !== 'ready' || ended || !data.payload || typeof data.payload !== 'object') return;
      const p = data.payload;
      const isCount = value => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000;
      if (![p.canvasCount,p.visibleCanvasCount,p.webglContexts,p.drawCalls].every(isCount)) return;
      const evidence = {canvasCount:p.canvasCount, visibleCanvasCount:p.visibleCanvasCount, webglContexts:p.webglContexts, drawCalls:p.drawCalls, drawObservationAvailable:!!p.drawObservationAvailable};
      const errors = observed.map(item => item.message);
      const warnings = [];
      if (p.canvasCount === 0) errors.push('В сцене не появился canvas для 3D-рендеринга.');
      else if (p.visibleCanvasCount === 0) errors.push('Canvas сцены не имеет видимого размера.');
      // webglContexts counts contexts that are still active at the time of
      // validation. A lost context was created earlier; don't report that it
      // was never created. The loss itself is already in observed errors.
      if (p.webglContexts === 0 && !observed.some(item => item.kind === 'webgl-context-lost')) {
        errors.push('Активный WebGL-контекст не обнаружен.');
      }
      if (p.webglContexts > 0 && p.drawCalls === 0) {
        if (p.drawObservationAvailable) errors.push('WebGL-контекст есть, но вызовы отрисовки не обнаружены; сцена может быть пустой.');
        else warnings.push('Не удалось проверить вызовы WebGL-отрисовки.');
      }
      const screenshot = captureImage && typeof p.screenshot === 'string' && p.screenshot.startsWith('data:image/jpeg;base64,') && p.screenshot.length <= 1000000 ? p.screenshot : null;
      if (captureImage && !screenshot) warnings.push('Не удалось получить изображение сцены для визуальной проверки.');
      const contextLost = observed.some(item => item.kind === 'webgl-context-lost');
      // A runtime exception inside Three.js also names the CDN file as its
      // source; that does not mean that loading the library failed. Keep
      // shader / material runtime failures eligible for the repair loop.
      const infrastructureErrorOther = observed.some(item => item.kind === 'resource' && item.source.startsWith(LIBRARY_URL)) || observed.some(item => /error creating webgl context|webgl is not supported/i.test(item.message));
      finish({ok:errors.length === 0, errors, warnings, retryable:!(contextLost || infrastructureErrorOther), contextLost, infrastructureErrorOther, evidence, screenshot});
    };
    sessions.set(iframe, dispose);
    releaseSessions.set(iframe, releaseSession);
    latestSessions.set(iframe, releaseSession);
    window.addEventListener('message', onMessage);
    signal?.addEventListener('abort', onAbort, {once:true});
    timer = setTimeout(() => finish({ok:false, errors:['Сцена не завершила запуск за отведённое время. Проверь доступность Three.js и работу браузера.'], warnings:[], retryable:false, evidence:null}), timeout);
    iframe.srcdoc = srcdoc;
  });
}
