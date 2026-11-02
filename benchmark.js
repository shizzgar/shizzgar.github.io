// Device capability probe and bounded, measured engine configuration comparison.
// No measurements or device details are persisted or sent to any server.
export const DEFAULT_CANDIDATES = Object.freeze([
  Object.freeze({ n_batch: 256, n_ubatch: 128 }),
  Object.freeze({ n_batch: 512, n_ubatch: 128 }),
]);

function throwIfAborted(signal) {
  if (signal?.aborted) throw new DOMException('Профилирование отменено.', 'AbortError');
}
function clampPositive(value, fallback, min, max) {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : fallback;
}
function safeInteger(value) { return Number.isSafeInteger(value) && value > 0 ? value : null; }

/** Capability information is approximate and browser-dependent, not a speed measurement. */
export async function profileDevice({ nav = globalThis.navigator, isolated = globalThis.crossOriginIsolated === true } = {}) {
  const out = {
    secureContext: globalThis.isSecureContext === true,
    crossOriginIsolated: isolated,
    logicalCores: safeInteger(nav?.hardwareConcurrency),
    deviceMemoryGiB: typeof nav?.deviceMemory === 'number' && Number.isFinite(nav.deviceMemory) && nav.deviceMemory > 0 ? nav.deviceMemory : null,
    webgpuAvailable: Boolean(nav?.gpu),
    adapterAvailable: false,
    adapter: null,
    maxBufferBytes: null,
    maxStorageBufferBindingBytes: null,
    // Wllama can use threads only when the environment is cross-origin isolated.
    wasmThreadsAvailable: isolated && typeof SharedArrayBuffer === 'function',
  };
  if (!nav?.gpu?.requestAdapter) return out;
  try {
    const adapter = await nav.gpu.requestAdapter();
    if (!adapter) return out;
    out.adapterAvailable = true;
    const info = adapter.info;
    // Device description is reported only locally. Some browsers mask these fields.
    const parts = [info?.vendor, info?.architecture, info?.device, info?.description]
      .filter(v => typeof v === 'string' && v.trim()).map(v => v.trim().slice(0, 120));
    out.adapter = [...new Set(parts)].join(' · ') || null;
    out.maxBufferBytes = safeInteger(adapter.limits?.maxBufferSize);
    out.maxStorageBufferBindingBytes = safeInteger(adapter.limits?.maxStorageBufferBindingSize);
  } catch {
    // API existence does not guarantee an available GPU adapter.
  }
  return out;
}

/** Extract only timing values explicitly provided by the runtime. */
function runtimeMetrics(timings) {
  if (!timings || typeof timings !== 'object') return { tokensPerSecond:null, generatedTokens:null };
  const tokens = Number(timings.predicted_n);
  const elapsedMs = Number(timings.predicted_ms);
  const rate = Number(timings.predicted_per_second);
  const count = Number.isFinite(tokens) && tokens > 0 ? tokens : null;
  let tokensPerSecond = Number.isFinite(rate) && rate > 0 ? rate : null;
  if (tokensPerSecond === null && count !== null && Number.isFinite(elapsedMs) && elapsedMs > 0) {
    tokensPerSecond = count * 1000 / elapsedMs;
  }
  return { tokensPerSecond, generatedTokens: count };
}

/**
 * Measure one streaming request, starting immediately before run() invokes the
 * engine. run({signal,maxTokens,onChunk}) must honour signal and send raw
 * wllama chunks; the final chunk or return value may include `timings`.
 * Stream chunk count is never equated to generated token count.
 */
export async function measureSample({ run, signal, maxTokens = 64, timeoutMs = 60000, now = () => performance.now() } = {}) {
  if (typeof run !== 'function') throw new TypeError('Нужна функция запуска модели.');
  throwIfAborted(signal);
  const child = new AbortController();
  const parentAbort = () => child.abort(signal?.reason);
  signal?.addEventListener('abort', parentAbort, { once:true });
  if (signal?.aborted) parentAbort();
  const timeout = clampPositive(timeoutMs, 60000, 1000, 120000);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.abort(); }, timeout);
  let first = null, chars = 0, latestTimings = null;
  const started = now();
  try {
    const response = await run({
      signal: child.signal,
      maxTokens: clampPositive(maxTokens, 64, 1, 128),
      onChunk: chunk => {
        if (child.signal.aborted) return;
        const content = chunk?.choices?.[0]?.delta?.content;
        if (typeof content === 'string' && content.length) {
          if (first === null) first = now();
          chars += [...content].length;
        }
        if (chunk?.timings && typeof chunk.timings === 'object') latestTimings = chunk.timings;
      },
    });
    const ended = now();
    if (signal?.aborted) throw new DOMException('Профилирование отменено.', 'AbortError');
    if (timedOut) throw new Error('Пробный запуск превысил лимит времени.');
    if (response?.timings && typeof response.timings === 'object') latestTimings = response.timings;
    if (first === null) throw new Error('Во время теста модель не вернула текст.');
    const { tokensPerSecond, generatedTokens } = runtimeMetrics(latestTimings);
    const durationMs = Math.max(0, ended - started);
    const visibleDuration = ended - first;
    return {
      ttftMs: Math.max(0, first - started),
      tokensPerSecond,
      generatedTokens,
      characters: chars,
      charactersPerSecond: visibleDuration > 0 ? chars * 1000 / visibleDuration : null,
      durationMs,
    };
  } catch (error) {
    if (signal?.aborted) throw new DOMException('Профилирование отменено.', 'AbortError');
    if (timedOut) throw new Error('Пробный запуск превысил лимит времени.');
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', parentAbort);
  }
}

/**
 * Compare small, predefined loading configurations. For each candidate:
 * reinitialize once, run a short warmup and then one measured request using the
 * same synthetic prompt. `prepare(config,{signal})` and `run(config,opts)` must
 * honour cancellation; prepare must use the currently cached model, never fetch.
 * `restore(config)` leaves the selected known-good configuration active.
 * One sample is noisy: this selects only the best of the tested candidates.
 */
export async function tuneEngine({ prepare, run, restore, onEvent = () => {}, signal, candidates = DEFAULT_CANDIDATES, baseline = null, timeoutMs = 60000 } = {}) {
  if (typeof prepare !== 'function' || typeof run !== 'function' || typeof restore !== 'function') throw new TypeError('Нужны функции подготовки, запуска и восстановления модели.');
  if (!Array.isArray(candidates) || candidates.length < 1 || candidates.length > 2) throw new Error('Можно сравнить один или два безопасных варианта.');
  const configs = candidates.map(config => {
    const batch = Number(config?.n_batch), ubatch = Number(config?.n_ubatch);
    if (!Number.isInteger(batch) || !Number.isInteger(ubatch) || ![256,512].includes(batch) || ubatch !== 128 || ubatch > batch) throw new Error('Неподдерживаемые параметры теста.');
    return { n_batch:batch, n_ubatch:ubatch };
  });
  const outcomes = [];
  let cancelled = false;
  const emit = event => onEvent(event);
  try {
    for (let i=0; i<configs.length; i++) {
      throwIfAborted(signal);
      const config = configs[i];
      emit({type:'preparing',index:i+1,total:configs.length,config});
      try {
        await prepare(config, {signal});
        throwIfAborted(signal);
        emit({type:'warming',index:i+1,total:configs.length,config});
        await measureSample({run: options => run(config,{...options,warmup:true}),signal,maxTokens:16,timeoutMs});
        throwIfAborted(signal);
        emit({type:'measuring',index:i+1,total:configs.length,config});
        const measurement = await measureSample({run: options => run(config,{...options,warmup:false}),signal,maxTokens:64,timeoutMs});
        const result = {config,...measurement}; outcomes.push(result);
        emit({type:'measured',index:i+1,total:configs.length,result});
      } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') throw new DOMException('Профилирование отменено.', 'AbortError');
        emit({type:'candidate_failed',index:i+1,total:configs.length,config,message:String(error?.message || 'Проверка варианта не удалась.').slice(0,400)});
        // Failed initializations may leave the runtime unavailable: stop rather
        // than repeatedly trying large GPU allocations after a failure.
        break;
      }
    }
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') cancelled = true; else throw error;
  }
  const measured = outcomes.filter(item => Number.isFinite(item.tokensPerSecond) && item.tokensPerSecond > 0);
  measured.sort((a,b) => b.tokensPerSecond - a.tokensPerSecond);
  // A single successful run is not evidence that its settings outperform the
  // baseline. Only switch automatically when every intended candidate yielded
  // real token timings and there was an actual comparison.
  let best = configs.length > 1 && measured.length === configs.length ? measured[0] : null;
  if (measured.length > 1 && measured[1].tokensPerSecond >= best.tokensPerSecond * 0.95 && measured[1].ttftMs < best.ttftMs) best = measured[1];
  // The caller can retain its exact known-working settings if no valid timing
  // is produced, or if the comparison is cancelled.
  const original = baseline && typeof baseline === 'object' ? { ...baseline } : configs[0];
  const selected = cancelled ? original : (best?.config || original);
  emit({type:'restoring',config:selected});
  try {
    // Restore is intentionally not passed the aborted signal; cancellation must
    // leave a usable model rather than stranding an unloaded engine.
    await restore(selected);
  } catch (error) {
    emit({type:'restore_failed',config:selected,message:String(error?.message || 'Не удалось восстановить модель.').slice(0,400)});
    throw new Error('Не удалось восстановить модель после профилирования.');
  }
  if (cancelled) throw new DOMException('Профилирование отменено.', 'AbortError');
  const result = { measurements:outcomes, selected, compared:measured.length, criterion:'Наибольшая измеренная скорость токенов; при разнице менее 5% выбран меньший TTFT.', basedOnTimings:Boolean(best) };
  emit({type:'complete',...result});
  return result;
}
