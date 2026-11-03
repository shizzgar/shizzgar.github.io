// Progress-aware downloads using wllama 3.8.1's public CacheManager.
// The stage progress covers file transfer only, never model/GPU initialization.
import { downloadResumable } from './resumable-cache.js?v=20261103-recovery-5';

export function modelShardUrls(instance, firstUrl) {
  const parse = instance?.modelManager?.constructor?.parseModelUrl;
  if (typeof parse !== 'function') throw new Error('Движок не поддерживает загрузку частей модели.');
  const urls = parse(firstUrl);
  if (!Array.isArray(urls) || !urls.length || urls.some(url => typeof url !== 'string')) {
    throw new Error('Не удалось определить части модели.');
  }
  return urls;
}

/**
 * Download and open files in order. onProgress receives
 * {loaded, total, cachedBytes, filesDone, filesTotal}; total=0 if unknown.
 * sizes optionally maps complete file URLs to trusted source metadata sizes.
 */
export async function downloadFiles(instance, urls, { sizes = {}, onProgress = () => {}, signal, parallel = 3, headersForUrl = () => ({}) } = {}) {
  if (!Array.isArray(urls) || !urls.length || new Set(urls).size !== urls.length) {
    throw new Error('Некорректный набор файлов модели.');
  }
  const cache = instance.cacheManager;
  const entries = await cache.list();
  const states = urls.map(url => {
    const size = Number(sizes[url]);
    const manifestSize = Number.isSafeInteger(size) && size > 0 ? size : 0;
    return { url, expected: manifestSize, manifestSize, loaded: 0, cached: 0, done: false, blob: null };
  });
  const send = () => {
    const total = states.every(s => s.expected > 0) ? states.reduce((n, s) => n + s.expected, 0) : 0;
    onProgress({ loaded: states.reduce((n, s) => n + s.loaded, 0), total, cachedBytes: states.reduce((n, s) => n + s.cached, 0), filesDone: states.filter(s => s.done).length, filesTotal: states.length });
  };
  for (const state of states) {
    const entry = entries.find(item => item.metadata?.originalURL === state.url && item.size > 0 && item.size === item.metadata.originalSize);
    if (!entry) continue;
    if (state.expected && entry.size !== state.expected) {
      // A URL was reused for a different file. Evict just this obsolete cache item.
      await cache.delete(entry.name);
      continue;
    }
    const blob = await cache.open(entry.name);
    if (!blob || blob.size !== entry.size) continue;
    state.blob = blob;
    state.loaded = state.cached = blob.size;
    state.expected = state.expected || blob.size;
    state.done = true;
  }
  send();
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  const queue = states.filter(s => !s.done);
  let next = 0;
  const worker = async () => {
    while (next < queue.length) {
      const state = queue[next++];
      if (controller.signal.aborted) throw new Error('Загрузка отменена.');
      let headers = headersForUrl(state.url) || {};
      try {
        const origin = new URL(state.url);
        if (origin.protocol !== 'https:' || origin.hostname !== 'huggingface.co' || origin.port || origin.username || origin.password) headers = {};
      } catch { headers = {}; }
      const auth = headers.Authorization || '';
      const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : '';
      const progress = ({loaded, total, cachedBytes = 0}) => {
          if (controller.signal.aborted) return;
          if (!state.expected && Number.isFinite(total) && total > 0) state.expected = total;
          if (Number.isFinite(loaded) && loaded >= 0) state.loaded = loaded;
          if (Number.isFinite(cachedBytes) && cachedBytes >= 0) state.cached = cachedBytes;
          send();
      };
      let blob;
      let fromWllamaCache = false;
      try {
        blob = await downloadResumable(state.url, { expectedBytes: state.manifestSize, onProgress: progress, signal: controller.signal, hfToken: token });
      } catch (error) {
        if (error?.code !== 'UNSUPPORTED') throw error;
        // Fall back to wllama on browsers without resumable OPFS support.
        await cache.download(state.url, {
          signal: controller.signal,
          headers,
          metadataAdditional: { originalURL: state.url },
          progressCallback: progress,
        });
        blob = await cache.open(state.url);
        fromWllamaCache = true;
      }
      if (controller.signal.aborted) throw new Error('Загрузка отменена.');
      if (!blob || !blob.size) throw new Error('Не удалось открыть скачанный файл модели.');
      if (state.expected && blob.size !== state.expected) throw new Error('Размер скачанного файла модели не совпадает с ожидаемым.');
      state.blob = blob;
      state.loaded = blob.size;
      state.expected = blob.size;
      state.done = true;
      // Wllama writes originalSize=0 if Content-Length is absent. Repair this
      // only if independently supplied metadata proves the downloaded size;
      // otherwise a truncated stream might be treated as a valid cache entry.
      if (fromWllamaCache && state.manifestSize && state.manifestSize === blob.size) {
        try {
          const name = await cache.getNameFromURL(state.url);
          const metadata = await cache.getMetadata(name);
          if (metadata?.originalURL === state.url && !metadata.originalSize) {
            await cache.writeMetadata(name, { ...metadata, originalSize: blob.size });
          }
        } catch {
          // The current file is still usable; a future visit may re-download it.
        }
      }
      send();
    }
  };
  try {
    const count = Math.max(1, Math.min(3, Math.floor(parallel) || 1, queue.length || 1));
    const workers = Array.from({length: count}, () => worker());
    try { await Promise.all(workers); }
    catch (error) { controller.abort(); await Promise.allSettled(workers); throw error; }
    return states.map(s => s.blob);
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}
