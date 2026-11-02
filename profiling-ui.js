import { profileDevice, tuneEngine } from './benchmark.js';
import { prepareBenchmark, runBenchmark, restoreBenchmark, getLoadedContextInfo, getModelState } from './inference.js';

// Run once after a successful model load, before the first requested generation.
// Results and hardware information stay in this tab.
export function createProfiler(trace) {
  let needsTuning = true;
  const showDevice = (device) => {
    const info = getLoadedContextInfo() || {};
    trace.setDevice({
      gpu: device.adapter || 'неизвестно',
      cores: device.logicalCores ?? 'неизвестно',
      memory: device.deviceMemoryGiB ? `≈ ${device.deviceMemoryGiB} ГиБ` : 'неизвестно',
      webgpu: device.adapterAvailable ? 'доступен' : 'не подтверждён',
      threads: info.n_threads ?? (device.wasmThreadsAvailable ? 'доступны' : '1 (без изоляции)'),
      context: info.n_ctx ?? 'неизвестно',
      batch: info.n_batch ?? 'по умолчанию',
    });
  };
  return {
    invalidate() { needsTuning = true; },
    async run(signal) {
      const device = await profileDevice();
      showDevice(device);
      if (!needsTuning) return;
      const baseline = getLoadedContextInfo() || {};
      trace.stage('Подбор скорости', 'Сравниваю две конфигурации локально. Потребуется повторная инициализация модели.');
      const call = trace.toolStart('engine.benchmark', { candidates: [{n_batch:256,n_ubatch:128},{n_batch:512,n_ubatch:128}], request:'короткий синтетический запрос', baseline });
      try {
        const result = await tuneEngine({ prepare:prepareBenchmark, run:runBenchmark, restore:restoreBenchmark, baseline, signal,
          onEvent: e => {
            if (e.type === 'preparing') trace.stage(`Вариант ${e.index}/${e.total}`, `batch ${e.config.n_batch}, ubatch ${e.config.n_ubatch}: инициализация`);
            if (e.type === 'warming') trace.stage('Прогрев', `Вариант ${e.index}/${e.total}`);
            if (e.type === 'measuring') trace.stage('Измерение', `Вариант ${e.index}/${e.total}`);
            if (e.type === 'measured') {
              const m = e.result;
              trace.setMetrics(m);
              trace.stage(`Результат batch ${m.config.n_batch}`, `${Number.isFinite(m.ttftMs) ? `TTFT ${(m.ttftMs/1000).toFixed(2)} с` : 'TTFT недоступен'}; ${m.tokensPerSecond == null ? 'TPS недоступен' : `${m.tokensPerSecond.toFixed(2)} токенов/с`}`);
            }
            if (e.type === 'candidate_failed') trace.stage('Тест параметров не завершён', e.message);
            if (e.type === 'restoring') trace.stage('Восстанавливаю модель');
          },
        });
        needsTuning = false;
        showDevice(device);
        trace.toolFinish(call, {output:result});
        trace.stage(result.basedOnTimings ? 'Выбран лучший из проверенных вариантов' : 'Оставлены исходные параметры', result.basedOnTimings ? `batch ${result.selected.n_batch}, ubatch ${result.selected.n_ubatch}. Один короткий замер не гарантирует максимума.` : 'Недостаточно данных для сравнения.');
      } catch (err) {
        trace.toolFinish(call, {error:err?.message || String(err)});
        if (err?.name === 'AbortError') throw err;
        if (!getModelState().loaded) throw new Error('Не удалось восстановить модель после подбора скорости. Загрузи её заново.');
        needsTuning = false;
        trace.stage('Подбор скорости не завершён', 'Продолжаю с текущей работающей конфигурацией.');
      }
    },
  };
}
