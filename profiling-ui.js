import { profileDevice } from './benchmark.js';
import * as inference from './inference.js';

// Profile available device capabilities without running a synthetic benchmark
// or reinitializing the model. Measurements come from ordinary generation.
export function createProfiler(trace) {
  let cachedDevice = null;
  function throwIfAborted(signal) {
    if (signal?.aborted) throw new DOMException('Проверка устройства отменена.', 'AbortError');
  }
  return {
    invalidate() { cachedDevice = null; },
    async run(signal) {
      throwIfAborted(signal);
      const device = cachedDevice || await profileDevice();
      throwIfAborted(signal);
      cachedDevice = device;
      const loadedInfo = inference.getLoadedContextInfo();
      const modelState = inference.getModelState?.() || {};
      const backend = modelState.backend ?? null;
      const info = loadedInfo || {};
      const count = info.gpu_layers_offloaded;
      const total = info.gpu_layers_total;
      const reported = Number.isSafeInteger(count) && count >= 0 && Number.isSafeInteger(total) && total > 0 && count <= total;
      // These numbers are parsed exclusively from the running engine's model
      // buffer allocation logs, not from a WebGPU capability probe. They do not
      // include KV cache, temporary buffers, or the rest of GPU memory.
      const bufferTotals = new Map();
      for (const item of Array.isArray(info.model_buffers) ? info.model_buffers : []) {
        if (!['WebGPU', 'CPU', 'CPU_Mapped'].includes(item?.backend) || !Number.isFinite(item?.mib) || item.mib < 0 || item.mib > 10000000) continue;
        bufferTotals.set(item.backend, (bufferTotals.get(item.backend) || 0) + item.mib);
      }
      const buffers = bufferTotals.size
        ? [...bufferTotals].map(([name, mib]) => `${name}: ${mib.toFixed(1)} МиБ`).join(' · ') + ' (только буферы весов модели)'
        : 'Нет данных от движка';
      // A CPU-only report is useful evidence but not proof that no other
      // buffers exist: a worker may omit or suppress individual log lines.
      const cpuBuffersWithoutWebGpu = !bufferTotals.has('WebGPU') &&
        ((bufferTotals.get('CPU') || 0) > 0 || (bufferTotals.get('CPU_Mapped') || 0) > 0);
      const fallbackReason = modelState.fallbackReason || info.backend_fallback_reason;
      const cpuPlacement = fallbackReason === 'adapter-unavailable'
        ? 'CPU/WASM: не удалось получить WebGPU-адаптер'
        : fallbackReason === 'gpu-init-failed'
        ? 'CPU/WASM: инициализация модели с GPU не удалась'
        : 'CPU/WASM: модель загружена без выгрузки на GPU';
      const placement = modelState.retiring
        ? 'Остановка движка не завершена; освобождение ресурсов не подтверждено'
        : modelState.suspended
        ? 'Модель временно выгружена для показа сцены; файлы сохранены для повторного запуска'
        : !loadedInfo
        ? 'При загрузке модели GPU или CPU будет выбран автоматически'
        : backend === 'cpu'
        ? cpuPlacement
        : cpuBuffersWithoutWebGpu
        ? 'Движок разместил веса в CPU-буфере; GPU-буферы в журнале не обнаружены'
        : reported
        ? `Движок сообщил ${count}/${total} слоёв; наличие GPU-буферов смотри отдельно`
        : 'Запрошен перенос всех слоёв на GPU; фактическое размещение не подтверждено';
      trace.setDevice({
        gpu: device.adapter || (device.adapterAvailable ? 'имя не раскрыто браузером' : 'не обнаружен'),
        webglGpu: device.webglRenderer || (device.webglAvailable ? 'имя не раскрыто браузером' : 'недоступен'),
        webglNote: 'Адаптер WebGL может отличаться от используемого моделью через WebGPU.',
        backend: placement,
        engineWebgpu: modelState.retiring ? 'Остановка движка не завершена' : modelState.suspended ? 'Движок остановлен для показа сцены' : !loadedInfo ? 'Модель ещё не загружена' : info.webgpu_initialized === true ? 'Движок сообщил инициализацию WebGPU' : 'Нет подтверждения от движка',
        modelBuffers: modelState.retiring ? 'Актуальные данные недоступны; завершение не подтверждено' : modelState.suspended ? 'Движок остановлен; актуальные данные отсутствуют' : loadedInfo ? buffers : 'Модель ещё не загружена',
        vram: 'Свободная VRAM недоступна из браузера',
        cores: device.logicalCores ?? 'неизвестно',
        memory: device.deviceMemoryGiB ? `≈ ${device.deviceMemoryGiB} ГиБ` : 'неизвестно',
        webgpu: device.adapterAvailable ? 'доступен' : 'не подтверждён',
        threads: info.n_threads ?? (device.wasmThreadsAvailable ? 'доступны' : '1 (без изоляции)'),
        context: info.n_ctx ?? 'неизвестно',
        outputLimit: info.output_token_limit ?? (modelState.suspended ? 'Модель временно выгружена' : loadedInfo ? 'неизвестно' : 'Модель ещё не загружена'),
        contextNote: 'Запрос, изображения, размышления и ответ занимают общее окно контекста; доступный для ответа объём может быть меньше потолка.',
        batch: info.n_batch ?? 'по умолчанию',
      });
      if (loadedInfo) trace.stage('Режим модели', placement);
    },
  };
}
