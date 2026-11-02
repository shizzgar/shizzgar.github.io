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
    id: 'three', label: '3D-библиотека Three.js (cdnjs)', method: 'HEAD',
    url: 'https://cdnjs.cloudflare.com/ajax/libs/three.js/0.160.0/three.module.min.js',
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
