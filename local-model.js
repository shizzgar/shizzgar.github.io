// Utilities for loading user-selected GGUF files without a model download.
// A GGUF split is a set created by llama-gguf-split, not arbitrary file chunks.
// These checks only validate headers and names; wllama validates actual contents.
const SPLIT_NAME = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/i;
const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;

async function checkGGUF(file, label) {
  if (!file || typeof file.name !== 'string' || typeof file.slice !== 'function' || !Number.isSafeInteger(file.size)) {
    throw new Error(`${label}: файл не выбран.`);
  }
  if (!/\.gguf$/i.test(file.name)) throw new Error(`${label}: выбери файл формата GGUF.`);
  if (file.size < 4) throw new Error(`${label}: файл пуст или повреждён.`);
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(`${label}: файл больше 2 ГиБ. Для wllama раздели модель с помощью llama-gguf-split и выбери все полученные части.`);
  }
  const header = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  if (header[0] !== 0x47 || header[1] !== 0x47 || header[2] !== 0x55 || header[3] !== 0x46) {
    throw new Error(`${label}: неверный заголовок GGUF.`);
  }
}

/**
 * Validate and return sorted File[] for one model (single file or all numbered
 * shards from llama-gguf-split). Projector must be selected separately.
 * This does not verify model architecture, provenance, hashes, or compatibility.
 */
export async function validateModelFiles(input) {
  const files = Array.from(input || []);
  if (!files.length) throw new Error('Выбери GGUF-модель или все части разделённой модели.');
  for (const file of files) {
    await checkGGUF(file, 'Модель');
    if (/mmproj/i.test(file.name)) throw new Error('Файл mmproj выбери отдельно как компонент для картинок.');
  }
  const parts = files.map(file => ({ file, match: file.name.match(SPLIT_NAME) }));
  if (parts.length === 1 && !parts[0].match) return [parts[0].file];
  if (parts.some(part => !part.match)) throw new Error('Выбери одну модель: либо один GGUF, либо все её пронумерованные части.');
  const prefix = parts[0].match[1];
  const count = Number(parts[0].match[3]);
  if (!count || parts.some(({ match }) => match[1] !== prefix || Number(match[3]) !== count)) {
    throw new Error('Части относятся к разным моделям или имеют разное количество частей.');
  }
  const ordered = parts.map(({ file, match }) => ({ file, index: Number(match[2]) })).sort((a, b) => a.index - b.index);
  if (ordered.length !== count || ordered.some(({ index }, i) => index !== i + 1)) {
    throw new Error(`Нужны все части модели: выбрано ${ordered.length} из ${count}; проверь пропущенные или повторяющиеся файлы.`);
  }
  return ordered.map(({ file }) => file);
}

/** Validate an optional separately selected vision projector. */
export async function validateProjectorFile(file) {
  if (!file) return null;
  await checkGGUF(file, 'Компонент для картинок');
  // wllama checks the actual GGUF architecture when it prepares the blobs.
  return file;
}

/** Combine validated model shards and optional projector for wllama.loadModel. */
export async function prepareLocalModel(modelFiles, projectorFile = null) {
  const shards = await validateModelFiles(modelFiles);
  const projector = await validateProjectorFile(projectorFile);
  return { shards, projector, files: projector ? [...shards, projector] : shards };
}
