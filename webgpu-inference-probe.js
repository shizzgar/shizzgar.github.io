// Probe capabilities independently in Window and in a dedicated Worker. This
// is NOT a test of the engine's worker or a guarantee that model offload works.
// No request text, credentials, adapter identity, model or network is used.
const WORKER_SOURCE = `
(async () => {
  let state = 'error', shaderF16 = null;
  try {
    if (typeof self.navigator?.gpu?.requestAdapter !== 'function') state = 'api_unavailable';
    else {
      const adapter = await self.navigator.gpu.requestAdapter();
      if (!adapter) state = 'no_adapter';
      else {
        state = 'available';
        try {
          if (typeof adapter.features?.has === 'function') shaderF16 = !!adapter.features.has('shader-f16');
        } catch { shaderF16 = null; }
      }
    }
  } catch { state = 'error'; }
  self.postMessage({state, shaderF16});
})();`;

const KNOWN = new Set(['available','no_adapter','api_unavailable','error','timeout','unsupported']);
const outcome = (state, shaderF16 = null) => ({ state, shaderF16: state === 'available' && typeof shaderF16 === 'boolean' ? shaderF16 : null });
function validTimeout(value) { return Number.isFinite(value) && value > 0 ? Math.min(30000, Math.floor(value)) : 5000; }

async function probeWindow(nav, timeoutMs) {
  if (typeof nav?.gpu?.requestAdapter !== 'function') return outcome('api_unavailable');
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(async () => {
        const adapter = await nav.gpu.requestAdapter();
        if (!adapter) return outcome('no_adapter');
        let shaderF16 = null;
        try {
          if (typeof adapter.features?.has === 'function') shaderF16 = !!adapter.features.has('shader-f16');
        } catch { /* A blocked feature query is not proof of absence. */ }
        return outcome('available', shaderF16);
      }).catch(() => outcome('error')),
      new Promise(resolve => { timer = setTimeout(() => resolve(outcome('timeout')), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function probeWorker({WorkerClass, URLApi, BlobClass}, timeoutMs) {
  if (typeof WorkerClass !== 'function' || typeof BlobClass !== 'function' || typeof URLApi?.createObjectURL !== 'function' || typeof URLApi?.revokeObjectURL !== 'function') return outcome('unsupported');
  let worker, url, timer;
  try {
    url = URLApi.createObjectURL(new BlobClass([WORKER_SOURCE], {type:'text/javascript'}));
    worker = new WorkerClass(url, {name:'forma-webgpu-probe'});
    return await new Promise(resolve => {
      let done = false;
      const finish = result => { if (done) return; done = true; resolve(result); };
      worker.onmessage = event => {
        const data = event?.data;
        // Treat malformed or unrecognized responses as unknown, never an
        // assertion that an adapter or feature is missing.
        if (!data || !KNOWN.has(data.state) || data.state === 'timeout' || data.state === 'unsupported') return finish(outcome('error'));
        finish(outcome(data.state, data.shaderF16));
      };
      worker.onerror = () => finish(outcome('error'));
      worker.onmessageerror = () => finish(outcome('error'));
      timer = setTimeout(() => finish(outcome('timeout')), timeoutMs);
    });
  } catch {
    // Unsupported worker, CSP, Blob restrictions or constructor failure.
    return outcome('unsupported');
  } finally {
    clearTimeout(timer);
    try { worker?.terminate(); } catch { /* cleanup is best effort */ }
    try { if (url !== undefined) URLApi.revokeObjectURL(url); } catch { /* best effort */ }
  }
}

/** Capability check only. No conclusions about actual model placement. */
export async function probeInferenceWebGPU({nav=globalThis.navigator, WorkerClass=globalThis.Worker, URLApi=globalThis.URL, BlobClass=globalThis.Blob, timeoutMs=5000} = {}) {
  const timeout = validTimeout(timeoutMs);
  const [main, worker] = await Promise.all([
    probeWindow(nav, timeout),
    probeWorker({WorkerClass, URLApi, BlobClass}, timeout),
  ]);
  let classification = 'worker_unknown';
  if (worker.state === 'available' && worker.shaderF16 === true) classification = 'worker_ready';
  else if (worker.state === 'available' && worker.shaderF16 === false) classification = 'worker_missing_shader_f16';
  else if (worker.state === 'no_adapter') classification = 'worker_no_adapter';
  else if (worker.state === 'api_unavailable') classification = 'worker_api_unavailable';
  return { main, worker, classification };
}
