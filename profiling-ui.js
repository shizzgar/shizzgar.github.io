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
      const backend = inference.getModelState?.()?.backend ?? null;
      const info = loadedInfo || {};
      const count = info.gpu_layers_offloaded;
      const total = info.gpu_layers_total;
      const reported = Number.isSafeInteger(count) && count >= 0 && Number.isSafeInteger(total) && total > 0 && count <= total;
      const placement = !loadedInfo
        ? 'При загрузке модели GPU или CPU будет выбран автоматически'
        : backend === 'cpu'
        ? 'CPU/WASM: WebGPU-адаптер недоступен; модель загружена без GPU'
        : reported
        ? `Движок сообщил ${count}/${total} слоёв на GPU; запрошен перенос всех слоёв`
        : 'Запрошен перенос всех слоёв на GPU; фактическое размещение не подтверждено';
      trace.setDevice({
        gpu: device.adapter || (device.adapterAvailable ? 'имя не раскрыто браузером' : 'не обнаружен'),
        webglGpu: device.webglRenderer || (device.webglAvailable ? 'имя не раскрыто браузером' : 'недоступен'),
        webglNote: 'Адаптер WebGL может отличаться от используемого моделью через WebGPU.',
        backend: placement,
        vram: 'Свободная VRAM недоступна из браузера',
        cores: device.logicalCores ?? 'неизвестно',
        memory: device.deviceMemoryGiB ? `≈ ${device.deviceMemoryGiB} ГиБ` : 'неизвестно',
        webgpu: device.adapterAvailable ? 'доступен' : 'не подтверждён',
        threads: info.n_threads ?? (device.wasmThreadsAvailable ? 'доступны' : '1 (без изоляции)'),
        context: info.n_ctx ?? 'неизвестно',
        batch: info.n_batch ?? 'по умолчанию',
      });
      if (loadedInfo) trace.stage('Режим модели', placement);
    },
  };
}
