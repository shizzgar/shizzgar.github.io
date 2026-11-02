// Browser-local resumable model transfer. Each file has its own OPFS entry.
// Bytes are written in a dedicated worker using a synchronous access handle;
// no ArrayBuffer for the entire model is created. A strong ETag, accessible
// Content-Range and HTTP 206 are required before previously saved bytes are
// ever combined with a new response.
const workerCode = `
const aborter = new AbortController();
onmessage = event => { if (event.data?.type === 'abort') aborter.abort(); };
const send = (type, detail = {}) => postMessage({type, ...detail});
const strong = value => typeof value === 'string' && /^"[^"\\r\\n]+"$/.test(value) && !/^W\\//i.test(value);
function rangeInfo(value) {
  const m = /^bytes (\\d+)-(\\d+)\\/(\\d+)$/.exec(value || '');
  if (!m) return null;
  const [start,end,total] = m.slice(1).map(Number);
  if (![start,end,total].every(Number.isSafeInteger) || start > end || end >= total) return null;
  return {start,end,total};
}
async function metadataFile(dir, name) {
  try { return JSON.parse(await (await (await dir.getFileHandle(name)).getFile()).text()); }
  catch { return null; }
}
async function saveMetadata(dir, name, data) {
  const handle = await dir.getFileHandle(name,{create:true});
  const out = await handle.createWritable();
  try { await out.write(JSON.stringify(data)); await out.close(); }
  catch(e) { await out.abort().catch(()=>{}); throw e; }
}
async function stopResponse(response) { try { await response?.body?.cancel(); } catch {} }
function requestHeaders(token, extra={}) {
  return token ? {...extra, Authorization:'Bearer '+token} : extra;
}
async function fetchFull(url, token) {
  return fetch(url, {headers:requestHeaders(token), signal:aborter.signal, cache:'no-store'});
}
async function run({url, key, expectedBytes, hfToken}) {
  if (!navigator.storage?.getDirectory) throw Object.assign(new Error('Локальное хранилище недоступно в этом браузере.'), {code:'UNSUPPORTED'});
  let root;
  try { root = await navigator.storage.getDirectory(); }
  catch (error) {
    if (['NotSupportedError','SecurityError'].includes(error?.name)) throw Object.assign(new Error('Локальное хранилище недоступно в этом браузере.'), {code:'UNSUPPORTED'});
    throw error;
  }
  const dir = await root.getDirectoryHandle('forma-resume-v1',{create:true});
  const fileName = key + '.gguf';
  const metaName = key + '.json';
  const handle = await dir.getFileHandle(fileName,{create:true});
  if (typeof handle.createSyncAccessHandle !== 'function') throw Object.assign(new Error('Этот браузер не поддерживает сохранение частичной загрузки.'), {code:'UNSUPPORTED'});
  let access;
  try { access = await handle.createSyncAccessHandle(); }
  catch (error) {
    if (['NotSupportedError','SecurityError'].includes(error?.name)) throw Object.assign(new Error('Сохранение частичной загрузки недоступно: ' + (error?.message || error)), {code:'UNSUPPORTED'});
    if (['NoModificationAllowedError','InvalidStateError'].includes(error?.name)) throw Object.assign(new Error('Файл модели занят в другой вкладке: ' + (error?.message || error)), {code:'LOCKED'});
    throw error;
  }
  try {
    let meta = await metadataFile(dir,metaName);
    let offset = access.getSize();
    const expected = Number.isSafeInteger(expectedBytes) && expectedBytes > 0 ? expectedBytes : 0;
    const validMeta = meta && meta.url === url && strong(meta.etag) && Number.isSafeInteger(meta.total) && meta.total > 0 && (!expected || expected === meta.total);
    if (!validMeta || offset > meta.total) { access.truncate(0); offset=0; meta=null; }
    if (offset && validMeta && offset === meta.total && meta.complete === true) {
      // Resolve/main may change. Revalidate before reusing a complete file.
      try {
        const head = await fetch(url, {method:'HEAD',headers:requestHeaders(hfToken),signal:aborter.signal,cache:'no-store'});
        if (head.ok && head.headers.get('etag') === meta.etag) {
          send('progress',{loaded:offset,total:meta.total,cachedBytes:offset});
          return {fileName};
        }
      } catch (error) { if (aborter.signal.aborted) throw error; }
    }
    let response, resumed=false;
    if (offset && validMeta && offset < meta.total) {
      send('status',{detail:'Продолжаем загрузку сохранённой части…'});
      try {
        response = await fetch(url, {headers:requestHeaders(hfToken,{Range:'bytes='+offset+'-', 'If-Range':meta.etag}), signal:aborter.signal, cache:'no-store'});
      } catch (error) {
        if (aborter.signal.aborted) throw error;
        // CORS may reject If-Range. Keep bytes until a full request succeeds.
        response = await fetchFull(url,hfToken);
      }
      if (response.status === 206) {
        const part = rangeInfo(response.headers.get('content-range'));
        const currentEtag = response.headers.get('etag');
        if (part && part.start === offset && part.total === meta.total && part.end === part.total-1 && currentEtag === meta.etag) {
          resumed=true;
        } else {
          await stopResponse(response);
          response=await fetchFull(url,hfToken);
        }
      }
      if (!resumed && response.status !== 200) {
        await stopResponse(response);
        response=await fetchFull(url,hfToken);
      }
    } else {
      response=await fetchFull(url,hfToken);
    }
    if ((!resumed && response.status !== 200) || !response.ok || !response.body) throw new Error('Не удалось скачать файл: HTTP '+response.status);
    if (!resumed) {
      const lenText = response.headers.get('content-length');
      const len = lenText && /^\\d+$/.test(lenText) ? Number(lenText) : 0;
      const total = Number.isSafeInteger(len) && len>0 ? len : expected;
      if (expected && total && expected !== total) { await stopResponse(response); throw new Error('Размер файла не совпадает с размером модели.'); }
      const etag=response.headers.get('etag');
      access.truncate(0); access.flush(); offset=0;
      // Discard previous bytes first: a crash must never pair old bytes with
      // a new file identity.
      meta={url,etag:strong(etag)?etag:null,total:total || 0,complete:false};
      await saveMetadata(dir,metaName,meta);
      send('status',{detail: strong(etag) && total ? 'Скачиваем с возможностью продолжения при обрыве.' : 'Скачиваем; сервер не подтвердил возможность докачки.'});
    }
    const startOffset=offset;
    let lastFlush=offset;
    let lastMessage=0;
    send('progress',{loaded:offset,total:meta.total,cachedBytes:offset});
    const reader=response.body.getReader();
    try {
      while (true) {
        const {value,done}=await reader.read(); if(done) break;
        if (aborter.signal.aborted) throw new DOMException('Aborted','AbortError');
        if (!(value instanceof Uint8Array)) throw new Error('Некорректные данные загрузки.');
        if (meta.total && offset + value.byteLength > meta.total) throw new Error('Сервер прислал больше данных, чем ожидалось.');
        let written=0;
        while (written<value.byteLength) {
          const n=access.write(value.subarray(written),{at:offset});
          if (!n) throw new Error('Не удалось записать файл модели.');
          written+=n; offset+=n;
        }
        if (offset-lastFlush >= 4*1024*1024) { access.flush(); lastFlush=offset; }
        const now=Date.now();
        if(now-lastMessage>=100){send('progress',{loaded:offset,total:meta.total,cachedBytes:startOffset});lastMessage=now;}
      }
      if (meta.total && offset !== meta.total) throw new Error('Загрузка прервалась до получения всего файла.');
      if (expected && offset !== expected) throw new Error('Размер загруженного файла отличается от ожидаемого.');
      if (!offset) throw new Error('Получен пустой файл.');
      access.flush();
      meta.complete=true;
      // No known total means byte count can be shown but not verified against a declared size.
      if (!meta.total) meta.total=offset;
      await saveMetadata(dir,metaName,meta);
      send('progress',{loaded:offset,total:meta.total,cachedBytes:startOffset});
      return {fileName};
    } finally { reader.releaseLock(); }
  } finally {
    try { access.flush(); } catch {}
    try { access.close(); } catch {}
  }
}
onmessage = async event => {
  if (event.data?.type === 'abort') { aborter.abort(); return; }
  if (event.data?.type !== 'start') return;
  try { send('done',await run(event.data)); }
  catch(e) {
    const token=event.data.hfToken;
    const message=String(e?.message || e);
    send('error',{message:token ? message.split(token).join('[скрыто]') : message,code:aborter.signal.aborted ? 'ABORTED' : (e?.code || (e?.name==='AbortError' ? 'ABORTED' : 'DOWNLOAD_FAILED'))});
  }
};
`;

export class ResumableDownloadError extends Error {
  constructor(message, code = 'DOWNLOAD_FAILED') { super(message); this.name = 'ResumableDownloadError'; this.code = code; }
}

/**
 * Download one file to private OPFS with checkpoints, returning a file-backed
 * Blob. Only pass trusted model URLs; no credentials are sent to app servers.
 * onProgress gets {loaded,total,cachedBytes}; total may be zero.
 * The caller should fall back to its normal download when code=UNSUPPORTED.
 */
export async function downloadResumable(url, {expectedBytes=0,onProgress=()=>{},onStatus=()=>{},signal,hfToken=''} = {}) {
  if (signal?.aborted) throw new ResumableDownloadError('Загрузка отменена.','ABORTED');
  if (hfToken) {
    if (typeof hfToken !== 'string' || /[\r\n]/.test(hfToken)) throw new ResumableDownloadError('Неверный токен доступа.','INVALID_TOKEN');
    let parsed;
    try { parsed = new URL(url); } catch { throw new ResumableDownloadError('Неверный адрес файла модели.','UNTRUSTED_URL'); }
    let decodedPath;
    try { decodedPath = decodeURIComponent(parsed.pathname); } catch { throw new ResumableDownloadError('Неверный адрес файла модели.','UNTRUSTED_URL'); }
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'huggingface.co' || parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname.includes('%') || parsed.href.includes(hfToken) || decodedPath.includes(hfToken)) {
      throw new ResumableDownloadError('Токен разрешено передавать только на huggingface.co по HTTPS.','UNTRUSTED_URL');
    }
  }
  if (!globalThis.isSecureContext || !navigator.storage?.getDirectory || typeof Worker !== 'function' || !globalThis.crypto?.subtle) {
    throw new ResumableDownloadError('Сохранение частичной загрузки недоступно в этом браузере.','UNSUPPORTED');
  }
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(url));
  const key=Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
  const workerUrl=URL.createObjectURL(new Blob([workerCode],{type:'text/javascript'}));
  let worker;
  try { worker=new Worker(workerUrl); } catch { URL.revokeObjectURL(workerUrl); throw new ResumableDownloadError('Не удалось запустить обработчик загрузки.','UNSUPPORTED'); }
  let abort;
  try {
    const result=await new Promise((resolve,reject)=>{
      abort=()=>worker.postMessage({type:'abort'});
      signal?.addEventListener('abort',abort,{once:true});
      worker.onerror=e=>{ e.preventDefault?.(); reject(new ResumableDownloadError('Ошибка обработчика загрузки.')); };
      worker.onmessage=e=>{
        const d=e.data || {};
        if(d.type==='progress') onProgress({loaded:d.loaded,total:d.total,cachedBytes:d.cachedBytes});
        else if(d.type==='status') onStatus(d.detail);
        else if(d.type==='done') resolve(d);
        else if(d.type==='error') reject(new ResumableDownloadError(d.message,d.code));
      };
      worker.postMessage({type:'start',url,key,expectedBytes,hfToken});
      if(signal?.aborted) abort();
    });
    const root=await navigator.storage.getDirectory();
    const dir=await root.getDirectoryHandle('forma-resume-v1');
    return await (await dir.getFileHandle(result.fileName)).getFile();
  } finally {
    signal?.removeEventListener('abort',abort);
    worker.terminate();
    URL.revokeObjectURL(workerUrl);
  }
}
