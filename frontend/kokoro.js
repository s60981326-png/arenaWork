// Local Kokoro TTS fallback. Loads once from Hugging Face (cached in the
// browser after that), then synthesizes fully on this machine — no servers,
// no key, no uploads. Used when ElevenLabs reports that credits are exhausted.
//
// Honest performance note (measured on this machine): RTF ≈ 2.7 on CPU/WASM
// and ≈ 1.0 on WebGPU, so each sentence takes roughly its own length to
// synthesize before it can play. Quality is good but below ElevenLabs.

let tts = null;
let loadingPromise = null;

export function kokoroDevice() {
  return typeof navigator !== "undefined" && navigator.gpu ? "webgpu" : "wasm";
}

export async function getKokoroTTS({ onStatus } = {}) {
  if (tts) return tts;
  if (!loadingPromise) {
    loadingPromise = (async () => {
      const { KokoroTTS } = await import("/lib/kokoro/kokoro.web.js");
      const device = kokoroDevice();
      const dtype = device === "webgpu" ? "fp32" : "q8";
      onStatus?.(`loading local voice (${device})…`);
      tts = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", { dtype, device });
      onStatus?.("local voice ready");
      return tts;
    })();
    loadingPromise.catch(() => {
      loadingPromise = null;
    });
  }
  return loadingPromise;
}

// Synthesize one sentence. Returns { samples: Float32Array, sampleRate: 24000 }.
export async function kokoroSentence(text, voice) {
  const model = await getKokoroTTS();
  const audio = await model.generate(text, { voice: voice || "am_michael" });
  const buf = await (await audio.toBlob()).arrayBuffer();
  return decodeWavPcm(new DataView(buf));
}

// Minimal RIFF/WAV parser for 16-bit mono PCM (Kokoro output format).
function decodeWavPcm(view) {
  if (view.getUint32(0, true) !== 0x46464952 /* "RIFF" */) {
    throw new Error("unexpected audio format from Kokoro");
  }
  let offset = 12;
  let sampleRate = 24000;
  let dataStart = 0;
  let dataLen = 0;
  while (offset + 8 <= view.byteLength) {
    const id = view.getUint32(offset, true);
    const size = view.getUint32(offset + 4, true);
    if (id === 0x20746d66 /* "fmt " */) {
      sampleRate = view.getUint32(offset + 12, true);
    } else if (id === 0x61746164 /* "data" */) {
      dataStart = offset + 8;
      dataLen = size;
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (!dataLen) throw new Error("no audio data in Kokoro output");
  const frames = Math.min(dataLen, view.byteLength - dataStart) / 2;
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const s = view.getInt16(dataStart + i * 2, true);
    samples[i] = s < 0 ? s / 32768 : s / 32767;
  }
  return { samples, sampleRate };
}
