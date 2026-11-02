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
 * Load 3D Coder and its image projector. Call only from a secure browser origin.
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
    const { Wllama } = await import(WLLAMA_ESM);
    instance = new Wllama({ default: WLLAMA_WASM }, { parallelDownloads: 3 });
    instance.setCompat('default', 'firefox_safari');
    onStatus('Загружаем модель и vision-компонент…');
    await instance.loadModelFromUrl({ url: resolvedModelUrl, mmprojUrl: projectorUrl }, {
      n_ctx: 8192,
      n_parallel: 1,
      // GitHub Pages does not send COOP/COEP headers, so explicitly use one CPU thread there.
      n_threads: globalThis.crossOriginIsolated ? Math.max(1, Math.min(4, Math.floor((navigator.hardwareConcurrency || 2) / 2))) : 1,
      n_gpu_layers: 99999,
      jinja: true,
      progressCallback: onProgress,
    });
    visionAvailable = instance.supportInputModality('image');
    if (!visionAvailable) throw new Error('Модель загрузилась, но движок не распознал vision-компонент.');
    engine = instance;
    onStatus('Модель готова');
    return { vision: true };
  } catch (error) {
    if (instance) await instance.exit().catch(() => {});
    throw error;
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
  return { loaded: Boolean(engine), loading, running, vision: visionAvailable };
}

export async function unloadModel() {
  if (loading || running) throw new Error('Дождитесь завершения текущей операции.');
  const old = engine;
  engine = null;
  visionAvailable = false;
  if (old) await old.exit();
}
