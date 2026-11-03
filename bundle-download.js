// Create a single ZIP directly on the user's disk from pre-split GGUF files.
// Each response is consumed as a stream; model weights are not buffered in RAM.
import { ZipStreamWriter } from './zip-stream.js?v=20261103-runtime-4';
import { downloadResumable } from './resumable-cache.js?v=20261103-runtime-4';

const MODEL_REPO = 'ReallyFloppyPenguin/Qwen3.5-4B-3D-Coder-GGUF-split';
const MODEL_API = `https://huggingface.co/api/models/${MODEL_REPO}/tree/main?recursive=true`;
const PROJECTOR_API = 'https://huggingface.co/api/models/ccore/Qwen3.5-4B-3D-Coder/tree/main';
const PROJECTOR_NAME = 'mmproj-Qwen3.5-4B-BF16.gguf';
const PROJECTOR_URL = `https://huggingface.co/ccore/Qwen3.5-4B-3D-Coder/resolve/main/${PROJECTOR_NAME}`;
const SHARD_NAME = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/i;
const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024;
const MAX_ZIP_SIZE = 0xffffffff;

function headers(token) {
  if (!token) return {};
  if (typeof token !== 'string' || /[\r\n]/.test(token)) throw new Error('Неверный токен Hugging Face.');
  return { Authorization: `Bearer ${token}` };
}
function checkCancelled(signal) {
  if (signal?.aborted) throw new DOMException('Скачивание отменено.', 'AbortError');
}
function validSize(value) { return Number.isSafeInteger(value) && value > 0 ? value : 0; }
function checkedGgufStream(body, name) {
  const magic = [0x47, 0x47, 0x55, 0x46];
  let checked = 0;
  return body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      if (!(chunk instanceof Uint8Array)) throw new Error(`Некорректные данные файла ${name}.`);
      for (let i = 0; i < chunk.length && checked < magic.length; i++, checked++) {
        if (chunk[i] !== magic[checked]) throw new Error(`Файл ${name} не похож на GGUF: источник мог вернуть страницу ошибки.`);
      }
      controller.enqueue(chunk);
    },
    flush() { if (checked < magic.length) throw new Error(`Файл ${name} не содержит заголовка GGUF.`); },
  }));
}
function validPath(path) {
  return typeof path === 'string' && path.length > 0 && !path.startsWith('/') && !path.includes('\\') && path.split('/').every(x => x && x !== '.' && x !== '..' && !/[\x00-\x1f\x7f]/.test(x));
}
function fileUrl(path) {
  if (!validPath(path)) throw new Error('Источник вернул некорректное имя части модели.');
  return `https://huggingface.co/${MODEL_REPO}/resolve/main/${path.split('/').map(encodeURIComponent).join('/')}`;
}
async function requestJson(url, token, signal) {
  const response = await fetch(url, { headers: { Accept: 'application/json', ...headers(token) }, credentials: 'omit', signal });
  if (!response.ok) throw new Error(`Не удалось получить список файлов модели (HTTP ${response.status}).`);
  const json = await response.json();
  if (!Array.isArray(json)) throw new Error('Источник вернул неверный список файлов модели.');
  return json;
}

/** Resolve and check the complete numbered shard set before opening any file. */
export async function resolveBundle({ token = '', signal, includeProjector = true } = {}) {
  checkCancelled(signal);
  const entries = await requestJson(MODEL_API, token, signal);
  const files = entries.filter(entry => entry?.type === 'file' && validPath(entry.path) && !/mmproj/i.test(entry.path));
  const parsed = files.map(entry => ({ entry, match: SHARD_NAME.exec(entry.path) })).filter(item => item.match);
  const starts = parsed.filter(item => item.match[2] === '00001');
  const q4 = starts.filter(item => /q4[_-]k[_-]m/i.test(item.entry.path));
  if (q4.length > 1) throw new Error('Источник содержит несколько вариантов модели Q4. Не удалось выбрать нужный набор.');
  const first = q4[0] || (starts.length === 1 ? starts[0] : null);
  if (!first) throw new Error('Не найден полный набор частей модели Q4. Проверь доступность источника модели.');
  const prefix = first.match[1];
  const totalParts = Number(first.match[3]);
  if (!Number.isSafeInteger(totalParts) || totalParts < 1 || totalParts > 65535) throw new Error('Источник вернул неверное количество частей модели.');
  const matching = parsed.filter(({match}) => match[1] === prefix && Number(match[3]) === totalParts);
  matching.sort((a,b) => Number(a.match[2]) - Number(b.match[2]));
  if (matching.length !== totalParts || matching.some(({match},index) => Number(match[2]) !== index + 1)) {
    throw new Error(`Набор частей модели неполный: доступно ${matching.length} из ${totalParts}.`);
  }
  const output = matching.map(({entry}) => {
    const size = validSize(entry.size);
    if (size > MAX_FILE_SIZE) throw new Error('Часть модели больше 2 ГиБ и не подходит для Forma.');
    return {name: entry.path.split('/').at(-1), url: fileUrl(entry.path), size};
  });
  if (includeProjector) {
    let size = 0;
    try {
      const projectorEntries = await requestJson(PROJECTOR_API, token, signal);
      size = validSize(projectorEntries.find(entry => entry?.type === 'file' && entry.path === PROJECTOR_NAME)?.size);
    } catch (err) { checkCancelled(signal); /* Download is still possible; percentage may be unavailable. */ }
    output.push({name: PROJECTOR_NAME, url: PROJECTOR_URL, size});
  }
  const names = new Set(output.map(file => file.name));
  if (names.size !== output.length) throw new Error('Источник вернул одинаковые имена файлов.');
  const knownTotal = output.reduce((sum,file) => sum + file.size, 0);
  if (knownTotal >= MAX_ZIP_SIZE || !Number.isSafeInteger(knownTotal)) throw new Error('Набор слишком большой для ZIP без ZIP64.');
  return output;
}

/**
 * Fetch a verified complete list of parts and write a ZIP to the user's chosen
 * WritableStream. Includes the optional image projector by default.
 * onProgress receives {stage,loaded,total,file}; total is 0 when unknown.
 * Closes writable on success and aborts on error.
 */
export async function createBundle({writable, token = '', onProgress = () => {}, signal, includeProjector = true} = {}) {
  if (!writable || typeof writable.getWriter !== 'function') throw new Error('Не удалось открыть файл для сохранения архива.');
  let zip;
  try {
    checkCancelled(signal);
    onProgress({stage:'Проверяем части модели…',loaded:0,total:0,file:''});
    const files = await resolveBundle({token,signal,includeProjector});
    const sizes = files.map(file => file.size);
    const total = () => sizes.every(size => size > 0) ? sizes.reduce((a,b) => a + b,0) : 0;
    const initialTotal = total();
    if (initialTotal >= MAX_ZIP_SIZE) throw new Error('Набор слишком большой для ZIP без ZIP64.');
    zip = new ZipStreamWriter(writable);
    let downloaded = 0;
    for (let i=0; i<files.length; i++) {
      checkCancelled(signal);
      const file = files[i];
      if (!sizes[i]) {
        // An independently declared size is needed to reject truncated streams.
        const head = await fetch(file.url, {method:'HEAD',headers:headers(token),credentials:'omit',signal});
        const rawLength = head.headers.get('content-length');
        sizes[i] = head.ok && rawLength && /^\d+$/.test(rawLength) ? validSize(Number(rawLength)) : 0;
        if (!sizes[i]) throw new Error(`Источник не сообщил размер ${file.name}. Не удалось проверить полноту файла.`);
      }
      if (sizes[i] > MAX_FILE_SIZE || sizes.reduce((a,b) => a+b,0) >= MAX_ZIP_SIZE) {
        throw new Error('Набор файлов слишком большой для этого архива.');
      }
      let input;
      let streamingFallback = false;
      let lastLoaded = 0;
      let lastCached = 0;
      onProgress({stage:'Загружаем файлы…',loaded:downloaded,total:total(),file:file.name,cachedBytes:0});
      try {
        const blob = await downloadResumable(file.url, {
          expectedBytes:sizes[i], hfToken:token, signal,
          onStatus:stage => onProgress({stage,loaded:downloaded+lastLoaded,total:total(),file:file.name,cachedBytes:lastCached}),
          onProgress:progress => {
            lastLoaded = progress.loaded;
            lastCached = progress.cachedBytes || 0;
            onProgress({stage:'Загружаем файлы…',loaded:downloaded+lastLoaded,total:total(),file:file.name,cachedBytes:lastCached});
          },
        });
        if (!blob || blob.size !== sizes[i]) throw new Error(`Размер ${file.name} не совпадает с ожидаемым.`);
        input = blob.stream();
        downloaded += blob.size;
      } catch (error) {
        if (error?.code !== 'UNSUPPORTED') throw error;
        // Browsers without resumable OPFS can still stream directly to the ZIP.
        const response = await fetch(file.url, {headers:headers(token),credentials:'omit',signal});
        if (!response.ok || !response.body) throw new Error(`Не удалось скачать ${file.name} (HTTP ${response.status}).`);
        const rawLength = response.headers.get('content-length');
        const length = rawLength && /^\d+$/.test(rawLength) ? validSize(Number(rawLength)) : 0;
        if (length && sizes[i] !== length) {
          await response.body.cancel().catch(() => {});
          throw new Error(`Размер ${file.name} не совпадает с данными источника.`);
        }
        input = response.body;
        streamingFallback = true;
      }
      onProgress({stage:streamingFallback ? 'Скачиваем и собираем архив…' : 'Упаковываем часть…',loaded:streamingFallback ? downloaded : 0,total:streamingFallback ? total() : sizes[i],file:file.name,cachedBytes:lastCached});
      let fileLoaded = 0;
      await zip.addStream(file.name, checkedGgufStream(input, file.name), sizes[i], {
        signal,
        onProgress: progress => {
          checkCancelled(signal);
          fileLoaded = progress.loaded;
          if (fileLoaded > MAX_FILE_SIZE) throw new Error(`Файл ${file.name} больше 2 ГиБ.`);
          onProgress({stage:streamingFallback ? 'Скачиваем и собираем архив…' : 'Упаковываем часть…',loaded:streamingFallback ? downloaded+fileLoaded : fileLoaded,total:streamingFallback ? total() : sizes[i],file:file.name,cachedBytes:lastCached});
        },
      });
      if (!fileLoaded) throw new Error(`Получен пустой файл ${file.name}.`);
      if (streamingFallback) downloaded += fileLoaded;
    }
    checkCancelled(signal);
    onProgress({stage:'Завершаем архив…',loaded:downloaded,total:total(),file:''});
    await zip.close();
    return {files:files.map(file => file.name), bytes:downloaded};
  } catch (error) {
    try { if (zip) await zip.abort(error); else await writable.abort(error); } catch { /* preserve original error */ }
    if (signal?.aborted || error?.name === 'AbortError') throw new DOMException('Скачивание отменено.', 'AbortError');
    const message = String(error?.message || 'Не удалось собрать архив.');
    throw new Error(token ? message.split(token).join('[скрыто]') : message);
  }
}
