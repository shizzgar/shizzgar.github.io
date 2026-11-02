// Run untrusted model-generated scenes in an opaque-origin sandbox.
// The checks below observe technical execution, not visual quality or correctness.
// A synchronous infinite loop inside an iframe may still block the browser.
const LIBRARY_URL = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/0.160.0/three.module.min.js';
const sessions = new WeakMap();
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
  const report = (message, kind = 'script', source = '') => {
    try {
      if (errors.length >= ${MAX_ERRORS}) return;
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
    const cleanup = () => {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      signal?.removeEventListener('abort', onAbort);
      if (sessions.get(iframe) === dispose) sessions.delete(iframe);
    };
    const finish = result => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (!result.ok) { cleanup(); iframe.srcdoc = ''; }
      resolve(result);
    };
    const onAbort = () => {
      if (ended) { cleanup(); return; }
      ended = true;
      cleanup();
      iframe.srcdoc = '';
      reject(new DOMException('Проверка отменена.', 'AbortError'));
    };
    const dispose = () => {
      if (!ended) onAbort();
      else cleanup();
    };
    const appendError = item => {
      if (!item || typeof item.message !== 'string' || observed.length >= MAX_ERRORS) return;
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
      if (p.webglContexts === 0) errors.push('Сцена не создала доступный WebGL-контекст.');
      if (p.webglContexts > 0 && p.drawCalls === 0) {
        if (p.drawObservationAvailable) errors.push('WebGL-контекст есть, но вызовы отрисовки не обнаружены; сцена может быть пустой.');
        else warnings.push('Не удалось проверить вызовы WebGL-отрисовки.');
      }
      const screenshot = captureImage && typeof p.screenshot === 'string' && p.screenshot.startsWith('data:image/jpeg;base64,') && p.screenshot.length <= 1000000 ? p.screenshot : null;
      if (captureImage && !screenshot) warnings.push('Не удалось получить изображение сцены для визуальной проверки.');
      const infrastructureError = observed.some(item => item.source.startsWith(LIBRARY_URL) || item.kind === 'webgl-context-lost') || observed.some(item => /error creating webgl context|webgl is not supported/i.test(item.message));
      finish({ok:errors.length === 0, errors, warnings, retryable:!infrastructureError, evidence, screenshot});
    };
    sessions.set(iframe, dispose);
    window.addEventListener('message', onMessage);
    signal?.addEventListener('abort', onAbort, {once:true});
    timer = setTimeout(() => finish({ok:false, errors:['Сцена не завершила запуск за отведённое время. Проверь доступность Three.js и работу браузера.'], warnings:[], retryable:false, evidence:null}), timeout);
    iframe.srcdoc = srcdoc;
  });
}
