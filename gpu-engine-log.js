// A deliberately narrow parser for the native model-loading INFO message in
// the llama.cpp revision used by wllama 3.8.1. Do not retain arbitrary log text.
// This reports what the runtime says about weight offload, not which GPU was
// selected or whether every operation executes on it.
export function createOffloadLogCollector() {
  let result = null;
  let webgpuInitialized = null;
  const modelBuffers = [];
  const logger = {
    debug(...args) {
      // wllama's worker converts native INFO to one console.debug string.
      if (args.length !== 1 || typeof args[0] !== 'string' || args[0].length > 1024) return;
      const line = args[0];
      const match = /^load_tensors: offloaded (\d{1,5})\/(\d{1,5}) layers to GPU\r?\n?$/.exec(line);
      if (match) {
        const gpuLayers = Number(match[1]);
        const totalLayers = Number(match[2]);
        if (totalLayers >= 1 && gpuLayers <= totalLayers) result = { gpuLayers, totalLayers };
        return;
      }
      // llama_model_base::load_tensors emits this once per allocated backend
      // buffer. WebGPU is the exact backend name in the pinned ggml build.
      // The MiB value is model-buffer size, not total or free device memory.
      const buffer = /^load_tensors:\s+(WebGPU|CPU|CPU_Mapped) model buffer size =\s*(\d{1,7}(?:\.\d{1,2})?) MiB\r?\n?$/.exec(line);
      if (buffer && modelBuffers.length < 16) {
        const mib = Number(buffer[2]);
        if (Number.isFinite(mib) && mib >= 0 && mib <= 1000000) modelBuffers.push({backend:buffer[1], mib});
        return;
      }
      // This confirms only that the native WebGPU backend reported its adapter.
      // Never retain identifiers, user content, arbitrary errors or raw logs.
      if (/^ggml_webgpu: adapter_info: vendor_id: \d+ \| vendor: [^|\r\n]{0,120} \| architecture: [^|\r\n]{0,120} \| device_id: \d+ \| name: [^|\r\n]{0,120} \| device_desc: [^\r\n]{0,120}\r?\n?$/.test(line)) webgpuInitialized = true;
    },
    log() {}, warn() {}, error() {},
  };
  return {
    logger,
    getResult: () => result && { ...result },
    getDiagnostics: () => ({ webgpuInitialized, modelBuffers: modelBuffers.map(item => ({...item})) }),
  };
}
