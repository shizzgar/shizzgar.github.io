// Streaming, uncompressed classic ZIP writer. Files are read and written in
// small chunks; neither a complete entry nor the archive is buffered in RAM.
// ZIP64 is intentionally not implemented, so sentinel/overflow limits fail
// before a new entry is written rather than producing an invalid archive.
const ZIP32_MAX = 0xfffffffe;
const MAX_ENTRIES = 0xfffe;
const FLAGS = 0x0808; // UTF-8 filenames and trailing data descriptor
const encoder = new TextEncoder();

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let i = 0; i < 8; i++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();
function crcUpdate(crc, bytes) {
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
  return crc >>> 0;
}
function record(size, writer) {
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  writer(view);
  return bytes;
}
function u16(view, at, value) { view.setUint16(at, value, true); }
function u32(view, at, value) { view.setUint32(at, value >>> 0, true); }
function checkName(name) {
  if (typeof name !== 'string' || !name || name.startsWith('/') || name.includes('\\') || /[\x00-\x1f:]/.test(name) || name.split('/').some(x => !x || x === '.' || x === '..')) {
    throw new Error('Недопустимое имя файла в архиве.');
  }
  const bytes = encoder.encode(name);
  if (bytes.length > 0xffff) throw new Error('Слишком длинное имя файла для ZIP.');
  return bytes;
}
function abortError(signal) { return signal?.reason instanceof Error ? signal.reason : new Error('Создание архива отменено.'); }

/**
 * Write independent files into a streaming ZIP without compression.
 * `writable` is a Web WritableStream (e.g. FileSystemWritableFileStream) or a
 * writer with async write()/close()/abort(). Call close() to finalize.
 * add(name, blob, options) or addStream(name, readableStream, size, options).
 * onProgress receives {name, loaded, total}; signal can abort the operation.
 */
export class ZipStreamWriter {
  constructor(writable) {
    const writer = writable && typeof writable.getWriter === 'function' ? writable.getWriter() : writable;
    if (!writer || typeof writer.write !== 'function' || typeof writer.close !== 'function' || typeof writer.abort !== 'function') throw new TypeError('Ожидается поток записи файла.');
    this.writer = writer;
    this.offset = 0;
    this.entries = [];
    this.names = new Set();
    this.centralSize = 0;
    this.state = 'open';
    this.busy = false;
  }
  async write(bytes) {
    await this.writer.write(bytes);
    this.offset += bytes.byteLength;
  }
  async add(name, blob, options = {}) {
    if (this.state !== 'open' || this.busy) throw new Error('Архив недоступен для записи.');
    try {
      if (!blob || typeof blob.stream !== 'function') throw new TypeError('Ожидается Blob или File.');
      if (!Number.isSafeInteger(blob.size) || blob.size < 0 || blob.size > ZIP32_MAX) throw new Error('Файл слишком велик для этого формата ZIP.');
      const filename = checkName(name);
      if (this.offset + 30 + filename.length + blob.size + 16 + this.centralSize + 46 + filename.length + 22 > ZIP32_MAX) throw new Error('Архив превышает допустимый размер 4 ГиБ.');
      return await this.addStream(name, blob.stream(), blob.size, options);
    } catch (err) { await this.abort(err); throw err; }
  }
  async addStream(name, stream, size, { onProgress = () => {}, signal } = {}) {
    if (this.state !== 'open' || this.busy) throw new Error('Архив недоступен для записи.');
    let filename;
    const knownSize = size !== null && size !== undefined;
    try {
      filename = checkName(name);
      if (this.names.has(name)) throw new Error('В архиве уже есть файл с таким именем.');
      if (knownSize && (!Number.isSafeInteger(size) || size < 0 || size > ZIP32_MAX)) throw new Error('Файл слишком велик для этого формата ZIP.');
      if (!stream || typeof stream.getReader !== 'function') throw new TypeError('Ожидается поток чтения файла.');
      if (this.entries.length >= MAX_ENTRIES) throw new Error('Слишком много файлов для этого формата ZIP.');
      // Reserve space for the complete central directory and end record.
      const projected = this.offset + 30 + filename.length + (knownSize ? size : 0) + 16 + this.centralSize + 46 + filename.length + 22;
      if (projected > ZIP32_MAX) throw new Error('Архив превышает допустимый размер 4 ГиБ.');
      if (signal?.aborted) throw abortError(signal);
    } catch (err) { await this.abort(err); throw err; }
    this.busy = true;
    const entry = { name, filename, size: knownSize ? size : 0, offset: this.offset, crc: 0 };
    let reader, cancelOnAbort;
    try {
      const local = record(30, v => {
        u32(v, 0, 0x04034b50); u16(v, 4, 20); u16(v, 6, FLAGS);
        u16(v, 8, 0); u16(v, 10, 0); u16(v, 12, 33); // Jan 1, 1980
        u16(v, 26, filename.length); u16(v, 28, 0);
      });
      await this.write(local);
      await this.write(filename);
      reader = stream.getReader();
      cancelOnAbort = () => { reader.cancel(abortError(signal)).catch(() => {}); };
      signal?.addEventListener('abort', cancelOnAbort, { once: true });
      if (signal?.aborted) cancelOnAbort();
      let loaded = 0, crc = 0xffffffff;
      onProgress({ name, loaded, total: knownSize ? size : 0 });
      while (true) {
        if (signal?.aborted) throw abortError(signal);
        const { done, value } = await reader.read();
        if (done) break;
        if (!(value instanceof Uint8Array)) throw new TypeError('Некорректные данные файла.');
        if (knownSize && loaded + value.byteLength > size) throw new Error('Размер файла больше ожидаемого.');
        if (this.offset + value.byteLength + 16 + this.centralSize + 46 + filename.length + 22 > ZIP32_MAX) throw new Error('Архив превышает допустимый размер 4 ГиБ.');
        crc = crcUpdate(crc, value);
        await this.write(value);
        loaded += value.byteLength;
        onProgress({ name, loaded, total: knownSize ? size : 0 });
      }
      if (signal?.aborted) throw abortError(signal);
      if (knownSize && loaded !== size) throw new Error('Файл загружен не полностью.');
      entry.size = loaded;
      entry.crc = (crc ^ 0xffffffff) >>> 0;
      await this.write(record(16, v => { u32(v, 0, 0x08074b50); u32(v, 4, entry.crc); u32(v, 8, loaded); u32(v, 12, loaded); }));
      this.entries.push(entry);
      this.names.add(name);
      this.centralSize += 46 + filename.length;
    } catch (err) {
      try { await reader?.cancel(err); } catch {}
      await this.abort(err);
      throw err;
    } finally {
      if (cancelOnAbort) signal?.removeEventListener('abort', cancelOnAbort);
      try { reader?.releaseLock(); } catch {}
      this.busy = false;
    }
  }
  async close() {
    if (this.state !== 'open' || this.busy) throw new Error('Архив недоступен для завершения.');
    this.state = 'closing';
    try {
      const start = this.offset;
      for (const entry of this.entries) {
        const central = record(46, v => {
          u32(v, 0, 0x02014b50); u16(v, 4, 20); u16(v, 6, 20); u16(v, 8, FLAGS);
          u16(v, 10, 0); u16(v, 12, 0); u16(v, 14, 33);
          u32(v, 16, entry.crc); u32(v, 20, entry.size); u32(v, 24, entry.size);
          u16(v, 28, entry.filename.length); u16(v, 30, 0); u16(v, 32, 0);
          u16(v, 34, 0); u16(v, 36, 0); u32(v, 38, 0); u32(v, 42, entry.offset);
        });
        await this.write(central);
        await this.write(entry.filename);
      }
      const length = this.offset - start;
      if (this.offset + 22 > ZIP32_MAX) throw new Error('Архив превышает допустимый размер 4 ГиБ.');
      await this.write(record(22, v => {
        u32(v, 0, 0x06054b50); u16(v, 4, 0); u16(v, 6, 0);
        u16(v, 8, this.entries.length); u16(v, 10, this.entries.length);
        u32(v, 12, length); u32(v, 16, start); u16(v, 20, 0);
      }));
      await this.writer.close();
      this.state = 'closed';
      this.writer.releaseLock?.();
    } catch (err) {
      await this.abort(err);
      throw err;
    }
  }
  async abort(error = new Error('Создание архива отменено.')) {
    if (this.state === 'closed' || this.state === 'aborted') return;
    this.state = 'aborted';
    try { await this.writer.abort(error); } catch {}
    try { this.writer.releaseLock?.(); } catch {}
  }
}
