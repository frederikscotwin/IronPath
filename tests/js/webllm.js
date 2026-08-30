// webllm.js — optional on-device model via WebGPU (MLC WebLLM), lazy-loaded
// from a CDN only when the user turns it on. Same OpenAI-style messages/response
// shape as the cloud path, so the coach code doesn't care which engine ran.
// Note: the first use downloads model weights (hundreds of MB–GBs) and needs a
// WebGPU-capable browser. Everything is guarded so the app never breaks without it.

let enginePromise = null;
let currentModel = null;

export function webgpuAvailable() {
  return typeof navigator !== 'undefined' && 'gpu' in navigator;
}

export async function ensureEngine(modelId, onProgress) {
  if (enginePromise && currentModel === modelId) return enginePromise;
  currentModel = modelId;
  enginePromise = (async () => {
    if (!webgpuAvailable()) throw new Error('This device/browser has no WebGPU, so the on-device model can\'t run. Use the cloud endpoint instead.');
    const webllm = await import('https://esm.run/@mlc-ai/web-llm');
    return webllm.CreateMLCEngine(modelId, { initProgressCallback: onProgress });
  })();
  try { return await enginePromise; }
  catch (e) { enginePromise = null; throw e; }
}

export async function chatLocal(modelId, messages, onProgress) {
  const engine = await ensureEngine(modelId, onProgress);
  const res = await engine.chat.completions.create({ messages, temperature: 0.4, stream: false });
  return res.choices?.[0]?.message?.content ?? '';
}
