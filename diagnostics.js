// Browser-side connection checks. They do not download model weights.
// Results describe this browser/network at this moment, not the entire country.
const CHECKS = [
  {
    id: 'model-index', label: 'Список частей модели', method: 'GET',
    url: 'https://huggingface.co/api/models/ReallyFloppyPenguin/Qwen3.5-4B-3D-Coder-GGUF-split/tree/main?recursive=true',
    async validate(response) {
      const files = await response.json();
      if (!Array.isArray(files)) throw new Error('Сервис вернул не список файлов');
      const shards = files.filter(file => file.type === 'file' && /-00001-of-\d{5}\.gguf$/i.test(file.path || '') && !/mmproj/i.test(file.path));
      const matches = shards.filter(file => /q4[_-]k[_-]m/i.test(file.path));
      if (!matches.length && shards.length !== 1) throw new Error('Подходящая разбитая модель не найдена');
      return 'Список и первый шард найдены. Доступность файлов проверяется при загрузке.';
    },
  },
  {
    id: 'runtime', label: 'Библиотека wllama (jsDelivr)', method: 'GET',
    url: 'https://cdn.jsdelivr.net/npm/@wllama/wllama@3.8.1/esm/index.js',
    async validate(response) {
      // Response headers prove only that the module URL is reachable; the
      // browser still needs to import it and any of its dependencies.
      response.body?.cancel().catch(() => {});
      return 'Адрес библиотеки доступен; её импорт ещё нужно проверить.';
    },
  },
  {
    id: 'wasm', label: 'Движок WASM (jsDelivr)', method: 'HEAD',
    url: 'https://cdn.jsdelivr.net/npm/@wllama/wllama@3.8.1/src/wasm/wllama.wasm',
    async validate() { return 'Проверка адреса прошла; файл не скачивался.'; },
  },
  {
    id: 'compat-worker', label: 'Совместимый движок JS (jsDelivr)', method: 'HEAD',
    url: 'https://cdn.jsdelivr.net/npm/@wllama/wllama-compat@3.8.1/wasm/wllama.js',
    async validate() { return 'Адрес доступен. Нужен в некоторых браузерах, файл не скачивался.'; },
  },
  {
    id: 'compat-wasm', label: 'Совместимый движок WASM (jsDelivr)', method: 'HEAD',
    url: 'https://cdn.jsdelivr.net/npm/@wllama/wllama-compat@3.8.1/wasm/wllama.wasm',
    async validate() { return 'Адрес доступен. Нужен в некоторых браузерах, файл не скачивался.'; },
  },
  {
    id: 'three', label: '3D-библиотека Three.js (этот сайт)', method: 'HEAD',
    url: new URL('./vendor/three-r160.module.min.js', import.meta.url).href,
    async validate() { return 'Проверка адреса прошла; файл не скачивался.'; },
  },
  {
    id: 'projector', label: 'Компонент для картинок', method: 'HEAD',
    url: 'https://huggingface.co/ccore/Qwen3.5-4B-3D-Coder/resolve/main/mmproj-Qwen3.5-4B-BF16.gguf',
    async validate() { return 'Проверка адреса прошла; файл не скачивался.'; },
  },
];

async function runCheck(check, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const response = await fetch(check.url, {
      method: check.method,
      mode: 'cors',
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const detail = await check.validate(response);
    return { id: check.id, label: check.label, status: 'ok', detail };
  } catch (error) {
    let detail;
    if (timedOut) detail = 'Время ожидания истекло.';
    else if (error instanceof TypeError) detail = 'Сеть или политика CORS не позволила выполнить запрос.';
    else detail = `${error?.message || 'Не удалось выполнить запрос'}.`;
    if (check.method === 'HEAD') detail += ' Это проверка HEAD; она не гарантирует, что обычная загрузка недоступна.';
    return { id: check.id, label: check.label, status: 'error', detail };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Check connectivity from the current browser without downloading weights.
 * Success checks individual URLs only; it does not prove inference works.
 * @returns {Promise<Array<{id:string,label:string,status:'ok'|'error',detail:string}>>}
 */
export async function checkConnectivity({ timeoutMs = 10000 } = {}) {
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 10000;
  return Promise.all(CHECKS.map(check => runCheck(check, timeout)));
}

// Check the default adapter, as requested by the current inference runtime.
// This never initializes the model or allocates VRAM, and sends no network data.
export async function checkWebGPU({ nav = globalThis.navigator, secure = globalThis.isSecureContext, timeoutMs = 5000 } = {}) {
  const steps = 'В Chrome открой chrome://gpu и проверь WebGPU; в Edge — edge://gpu. Включи аппаратное ускорение в настройках браузера, перезапусти браузер и проверь драйвер видеокарты.';
  if (!secure) return { status:'error', code:'insecure', detail:'WebGPU требует защищённого соединения HTTPS. Открой сайт по HTTPS.' };
  if (typeof nav?.gpu?.requestAdapter !== 'function') return { status:'error', code:'api_unavailable', detail:`Браузер не предоставляет WebGPU. Обнови браузер и проверь аппаратное ускорение. ${steps}` };
  let timer, timedOut = false;
  try {
    const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, 30000) : 5000;
    const probe = async () => {
      const core = await nav.gpu.requestAdapter();
      if (core || timedOut) return {adapter:core, mode:'core'};
      // The app's engine requests the default/core adapter. A second probe is
      // diagnostic only: it does not configure the engine or create a device.
      try {
        const compat = await nav.gpu.requestAdapter({featureLevel:'compatibility'});
        return {adapter:compat, mode:'compat'};
      } catch {
        // Older implementations may reject the compatibility option.
        return {adapter:null, mode:'compat'};
      }
    };
    const {adapter, mode} = await Promise.race([
      probe(),
      new Promise((_, reject) => { timer = setTimeout(() => { timedOut = true; reject(new Error('timeout')); }, timeout); }),
    ]);
    if (!adapter) return { status:'error', code:'no_adapter', detail:`Браузер предоставляет WebGPU, но не нашёл доступный адаптер. ${steps} WebGL может видеть GPU, даже когда WebGPU не может его открыть.` };
    let info = {};
    try { info = adapter.info || {}; } catch { /* Identity may be blocked even when an adapter exists. */ }
    const name = [info.vendor, info.architecture, info.device, info.description].filter(v => typeof v === 'string' && v.trim()).map(v => v.trim().slice(0, 120));
    const identity = [...new Set(name)].join(' · ') || 'название скрыто браузером';
    const fallback = info.isFallbackAdapter === true;
    if (mode === 'compat') return { status:'warning', code:'compat_only', detail:`Основной адаптер WebGPU недоступен, но запрос совместимого адаптера вернул результат: ${identity}.${fallback ? ' Браузер сообщает о резервном адаптере, который может быть программным.' : ''} Движок модели запрашивает основной режим; эта проверка не гарантирует его работу с совместимым адаптером. ${steps}` };
    return { status:fallback ? 'warning' : 'ok', code:fallback ? 'fallback' : 'available', detail:`Адаптер WebGPU доступен: ${identity}.${fallback ? ' Браузер сообщает о резервном адаптере, который может быть программным.' : ''} Эта проверка не гарантирует загрузку модели или использование конкретной видеокарты.` };
  } catch (error) {
    const timeout = timedOut;
    return { status:'error', code:timeout ? 'timeout' : 'adapter_error', detail:`${timeout ? 'Браузер не ответил на запрос WebGPU вовремя.' : 'Браузер не смог открыть адаптер WebGPU.'} ${steps}` };
  } finally { clearTimeout(timer); }
}
