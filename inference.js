import { prepareLocalModel, validateProjectorFile } from './local-model.js';
// Browser-local GGUF inference, using Wllama's OpenAI-compatible v3 API.
// Inference never leaves the device; runtime and weights are downloaded on load.
const WLLAMA_VERSION = '3.8.1';
const WLLAMA_ESM = `https://cdn.jsdelivr.net/npm/@wllama/wllama@${WLLAMA_VERSION}/esm/index.js`;
const WLLAMA_WASM = `https://cdn.jsdelivr.net/npm/@wllama/wllama@${WLLAMA_VERSION}/src/wasm/wllama.wasm`;
const SPLIT_REPO = 'ReallyFloppyPenguin/Qwen3.5-4B-3D-Coder-GGUF-split';
const PROJECTOR_URL = 'https://huggingface.co/ccore/Qwen3.5-4B-3D-Coder/resolve/main/mmproj-Qwen3.5-4B-BF16.gguf';

let engine = null;
let loading = false;
let running = false;
let visionAvailable = false;
let activeModelUrl = '';
let activeProjectorUrl = PROJECTOR_URL;
let activeMode = 'remote';
let localShards = [];
let localProjector = null;

function loadOptions(onProgress) {
  return {
    n_ctx: 8192,
    n_parallel: 1,
    n_threads: globalThis.crossOriginIsolated ? Math.max(1, Math.min(4, Math.floor((navigator.hardwareConcurrency || 2) / 2))) : 1,
    n_gpu_layers: 99999,
    jinja: true,
    progressCallback: onProgress,
  };
}

async function makeEngine() {
  const { Wllama } = await import(WLLAMA_ESM);
  const instance = new Wllama({ default: WLLAMA_WASM }, { parallelDownloads: 3, allowOffline: true });
  instance.setCompat('default', 'firefox_safari');
  return instance;
}

// Wllama 3.8.1 identifies cached models by the first shard URL, ignoring the
// projector. Open only text shards so an old combined cache remains compatible.
async function textShards(instance, url, onProgress) {
  const model = await instance.modelManager.getModelOrDownload({ url }, { progressCallback: onProgress });
  const files = model.files.filter(file => file.metadata.originalURL !== model.mmprojUrl);
  const blobs = await Promise.all(files.map(file => instance.cacheManager.open(file.name)));
  if (!blobs.length || blobs.some(blob => !blob)) throw new Error('Не удалось открыть сохранённые файлы модели.');
  return blobs;
}

async function projectorBlob(instance, url, onProgress) {
  const entries = await instance.cacheManager.list();
  const cached = entries.find(file => file.metadata.originalURL === url && file.size > 0 && file.size === file.metadata.originalSize);
  if (cached) {
    const blob = await instance.cacheManager.open(cached.name);
    if (blob && blob.size === cached.size) {
      onProgress({loaded: blob.size, total: blob.size});
      return blob;
    }
  }
  await instance.cacheManager.download(url, { progressCallback: onProgress });
  const blob = await instance.cacheManager.open(url);
  if (!blob || !blob.size) throw new Error('Не удалось открыть компонент для картинок.');
  return blob;
}

// Resolve the first actual GGUF shard rather than guessing a filename. Wllama
// automatically downloads the remaining numbered shards from that first URL.
async function findModelUrl() {
  const response = await fetch(`https://huggingface.co/api/models/${SPLIT_REPO}/tree/main?recursive=true`, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`Не удалось получить список файлов модели (HTTP ${response.status}).`);
  const entries = await response.json();
  if (!Array.isArray(entries)) throw new Error('Hugging Face вернул неверный список файлов модели.');
  const files = entries.filter((entry) => entry.type === 'file' && /\.gguf$/i.test(entry.path) && !/mmproj/i.test(entry.path));
  const firstShards = files.filter((entry) => /-00001-of-\d{5}\.gguf$/i.test(entry.path));
  const quantized = firstShards.filter((entry) => /q4[_-]k[_-]m/i.test(entry.path));
  // Some mirrors omit the quantization from a path when they contain only one model.
  const first = quantized[0] || (firstShards.length === 1 ? firstShards[0] : null);
  if (!first) throw new Error('Не найдена разделённая на части Q4_K_M модель. Проверьте доступность репозитория модели.');
  return `https://huggingface.co/${SPLIT_REPO}/resolve/main/${first.path.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * Load 3D Coder for text first. The image projector is loaded separately.
 * onProgress receives {loaded, total}; onStatus receives a displayable string.
 */
export async function loadModel({ onProgress = () => {}, onStatus = () => {}, modelUrl = '', projectorUrl = PROJECTOR_URL } = {}) {
  if (loading || running) throw new Error('Модель уже занята.');
  if (engine) return { vision: visionAvailable };
  if (!globalThis.isSecureContext || !navigator.gpu) {
    throw new Error('Нужны HTTPS и браузер с WebGPU. Попробуйте актуальный Chrome или Edge на компьютере.');
  }
  loading = true;
  let instance;
  try {
    onStatus('Проверяем файлы модели…');
    // modelUrl can point to the first shard of another compatible mirror.
    // The community mirror is discovered at runtime and can disappear or change.
    const resolvedModelUrl = modelUrl || await findModelUrl();
    onStatus('Загружаем движок…');
    instance = await makeEngine();
    onStatus('Загружаем модель для текста…');
    const shards = await textShards(instance, resolvedModelUrl, onProgress);
    onStatus('Инициализируем модель…');
    await instance.loadModel(shards, loadOptions(onProgress));
    visionAvailable = false;
    engine = instance;
    activeModelUrl = resolvedModelUrl;
    activeProjectorUrl = projectorUrl;
    activeMode = 'remote';
    localShards = [];
    localProjector = null;
    onStatus('Модель готова для текста');
    return { vision: false };
  } catch (error) {
    if (instance) await instance.exit().catch(() => {});
    throw error;
  } finally {
    loading = false;
  }
}

/** Load explicitly selected GGUF files; these File objects last only for the tab session. */
export async function loadLocalModel(modelFiles, projectorFile = null, { onStatus = () => {} } = {}) {
  if (loading || running) throw new Error('Модель уже занята.');
  if (!globalThis.isSecureContext || !navigator.gpu) throw new Error('Нужны HTTPS и браузер с WebGPU.');
  loading = true;
  let instance = null;
  try {
    onStatus('Проверяем локальные файлы…');
    const { shards, projector, files } = await prepareLocalModel(modelFiles, projectorFile);
    // Validate input and resolve the runtime before discarding a working engine.
    onStatus('Загружаем движок…');
    instance = await makeEngine();
    if (engine) {
      const old = engine;
      engine = null;
      visionAvailable = false;
      await old.exit();
    }
    onStatus('Инициализируем локальную модель…');
    await instance.loadModel(files, loadOptions(() => {}));
    const hasVision = instance.supportInputModality('image');
    if (projector && !hasVision) throw new Error('Движок не распознал компонент для картинок.');
    engine = instance;
    instance = null;
    activeMode = 'local';
    activeModelUrl = '';
    localShards = shards;
    localProjector = projector;
    visionAvailable = Boolean(projector && hasVision);
    onStatus(visionAvailable ? 'Локальная модель готова для текста и картинок' : 'Локальная модель готова для текста');
    return { vision: visionAvailable };
  } catch (err) {
    if (instance) await instance.exit().catch(() => {});
    throw err;
  } finally {
    loading = false;
  }
}

/** Keep a local projector available for the next vision initialization. */
export async function setLocalProjector(file) {
  if (loading || running) throw new Error('Модель уже занята.');
  if (activeMode !== 'local' || !engine) throw new Error('Сначала загрузи локальную модель.');
  localProjector = await validateProjectorFile(file);
}

/** Download the projector only when needed and reload the model using cached shards. */
export async function ensureVision({ onProgress = () => {}, onStatus = () => {} } = {}) {
  if (!engine) throw new Error('Сначала загрузи модель.');
  if (loading || running) throw new Error('Модель уже занята.');
  if (visionAvailable) return;
  loading = true;
  let next = null;
  let old = engine;
  try {
    // Keep the text engine usable if the projector download fails.
    onStatus(activeMode === 'local' ? 'Проверяем локальный компонент для картинок…' : 'Загружаем компонент для картинок…');
    if (activeMode === 'local' && !localProjector) throw new Error('Выбери локальный файл mmproj в разделе «Свои файлы модели».');
    const projector = activeMode === 'local' ? localProjector : await projectorBlob(old, activeProjectorUrl, onProgress);
    const shards = activeMode === 'local' ? localShards : await textShards(old, activeModelUrl, () => {});
    onStatus('Перезапускаем модель для картинок…');
    engine = null;
    visionAvailable = false;
    await old.exit();
    old = null;
    next = await makeEngine();
    await next.loadModel([...shards, projector], loadOptions(onProgress));
    if (!next.supportInputModality('image')) throw new Error('Движок не распознал компонент для картинок.');
    engine = next;
    next = null;
    visionAvailable = true;
    onStatus('Модель готова для текста и картинок');
  } catch (err) {
    if (next) await next.exit().catch(() => {});
    const recovery = engine ? 'Текстовая модель осталась доступна; можно повторить попытку с картинкой.' : (activeMode === 'local' ? 'Нажми «Загрузить свои файлы» ещё раз, чтобы восстановить модель.' : 'Нажми «Загрузить» ещё раз, чтобы восстановить текстовый режим.');
    throw new Error(`Не удалось включить картинки: ${err?.message || err}. ${recovery}`);
  } finally {
    loading = false;
  }
}

/**
 * Generate a complete HTML scene. image is an optional File, Blob or ArrayBuffer.
 * onToken receives each text delta; returns accumulated text.
 */
export async function generate({ prompt, image = null, previousCode = '', onToken = () => {}, signal } = {}) {
  if (!engine) throw new Error('Сначала загрузите модель.');
  if (running || loading) throw new Error('Модель уже занята.');
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('Введите описание сцены.');
  if (image && !visionAvailable) throw new Error('Vision-компонент не загружен.');
  running = true;
  try {
    const system = 'You are a creative 3D coding assistant. Return one complete standalone HTML document and nothing else. Build an interactive Three.js scene. Use only the Three.js core ES module from https://cdnjs.cloudflare.com/ajax/libs/three.js/0.160.0/three.module.min.js. Do not import addons or legacy examples/js paths; implement camera controls directly. Include all code in the HTML, keep the scene well lit, and size it to the viewport.';
    const text = previousCode
      ? `Update this existing scene according to the request. Return the complete updated HTML document.\n\nRequest: ${prompt.trim()}\n\nExisting HTML:\n${previousCode}`
      : prompt.trim();
    let content = text;
    if (image) {
      const bytes = image instanceof ArrayBuffer ? image : await image.arrayBuffer();
      content = [{ type: 'image', data: bytes }, { type: 'text', text }];
    }
    const stream = await engine.createChatCompletion({
      messages: [{ role: 'system', content: system }, { role: 'user', content }],
      stream: true,
      max_tokens: 4096,
      temperature: 0.7,
      top_p: 0.95,
      top_k: 20,
      chat_template_kwargs: { enable_thinking: false },
      abortSignal: signal,
    });
    let result = '';
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content || '';
      if (delta) { result += delta; onToken(delta, result); }
    }
    if (!result.trim()) throw new Error('Модель не вернула текст сцены.');
    return result;
  } finally {
    running = false;
  }
}

export function getModelState() {
  return { loaded: Boolean(engine), loading, running, vision: visionAvailable, mode: activeMode };
}

export async function unloadModel() {
  if (loading || running) throw new Error('Дождитесь завершения текущей операции.');
  const old = engine;
  engine = null;
  visionAvailable = false;
  localShards = [];
  localProjector = null;
  if (old) await old.exit();
}
