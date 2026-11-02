// A deliberately narrow parser for the native model-loading INFO message in
// the llama.cpp revision used by wllama 3.8.1. Do not retain arbitrary log text.
// This reports what the runtime says about weight offload, not which GPU was
// selected or whether every operation executes on it.
export function createOffloadLogCollector() {
  let result = null;
  const logger = {
    debug(...args) {
      // wllama's worker converts native INFO to one console.debug string.
      if (args.length !== 1 || typeof args[0] !== 'string' || args[0].length > 100) return;
      const match = /^load_tensors: offloaded (\d{1,5})\/(\d{1,5}) layers to GPU\r?\n?$/.exec(args[0]);
      if (!match) return;
      const gpuLayers = Number(match[1]);
      const totalLayers = Number(match[2]);
      if (totalLayers < 1 || gpuLayers > totalLayers) return;
      result = { gpuLayers, totalLayers };
    },
    log() {}, warn() {}, error() {},
  };
  return { logger, getResult: () => result && { ...result } };
}
