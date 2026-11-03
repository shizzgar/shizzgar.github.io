// Probe only whether a tiny fresh WebGL context can currently be created.
// This is not a rendering test, a VRAM measurement, or a diagnosis of the
// preceding loss. A temporary loss may clear after the check completes.
export async function probeWebGLRecovery({doc = globalThis.document, signal, waitMs = 300} = {}) {
  const aborted = () => {
    if (signal?.aborted) throw new DOMException('Проверка отменена.', 'AbortError');
  };
  const probe = () => {
    let uncertain = false;
    for (const name of ['webgl2', 'webgl', 'experimental-webgl']) {
      let canvas, gl;
      try {
        // A canvas that already owns one context type cannot necessarily be
        // reused to test another type, so use a fresh one for every attempt.
        canvas = doc?.createElement?.('canvas');
        if (!canvas || typeof canvas.getContext !== 'function') return 'unknown';
        canvas.width = canvas.height = 1;
        gl = canvas.getContext(name);
        if (!gl) continue;
        if (typeof gl.isContextLost === 'function' && gl.isContextLost()) continue;
        return 'available';
      } catch { uncertain = true; }
      finally { try { gl?.getExtension?.('WEBGL_lose_context')?.loseContext(); } catch { /* best effort */ } }
    }
    return uncertain ? 'unknown' : 'unavailable';
  };
  aborted();
  const first = probe();
  if (first === 'available') return {state:first};
  // Give the browser a short opportunity to recover after context loss.
  await new Promise((resolve, reject) => {
    const done = () => { signal?.removeEventListener('abort', cancel); resolve(); };
    const timer = setTimeout(done, Math.max(0, Math.min(1000, waitMs)));
    const cancel = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); reject(new DOMException('Проверка отменена.', 'AbortError')); };
    signal?.addEventListener('abort', cancel, {once:true});
    if (signal?.aborted) cancel();
  });
  aborted();
  const second = probe();
  // An exception prevents a confident conclusion even if the other try
  // returned null. Be conservative and never invent a cause for the loss.
  return {state:second === 'available' ? 'available' : first === 'unknown' || second === 'unknown' ? 'unknown' : 'unavailable'};
}
