const $ = (id) => document.getElementById(id);
const messagesEl = $("messages");
const inputEl = $("input");
const composer = $("composer");
const dot = $("dot");
const statusText = $("statusText");
const memoryPanel = $("memoryPanel");
const memoryBtn = $("memoryBtn");
const settingsPanel = $("settingsPanel");
const settingsBtn = $("settingsBtn");
const profilePanel = $("profilePanel");
const profileBtn = $("profileBtn");
// Declared here (not in the Reminders section below) so the panel open/close
// handlers registered above the Reminders code see them — using a const
// before its declaration throws a ReferenceError in the browser.
const schedulePanel = $("schedulePanel");
const scheduleBtn = $("scheduleBtn");
const memoryList = $("memoryList");
const memoryChip = $("memoryChip");
const memoryChipText = $("memoryChipText");
// index.html's companion stage no longer has the old voice-strip controls
// (micBtn, voiceStrip, liveTranscript, …). Stub those with a detached node so
// the script still boots; their handlers are harmless on inert elements.
const stubEl = () => document.createElement("span");
const micBtn = $("micBtn") || stubEl();
const micIcon = $("micIcon") || stubEl();
const voiceStrip = $("voiceStrip") || stubEl();
const voiceStateText = $("voiceStateText") || stubEl();
const liveTranscript = $("liveTranscript") || stubEl();
const pauseListenBtn = $("pauseListenBtn") || stubEl();
const resumeListenBtn = $("resumeListenBtn") || stubEl();
const stopSpeakBtn = $("stopSpeakBtn") || stubEl();
const exitVoiceBtn = $("exitVoiceBtn") || stubEl();
const fullscreenBtn = $("fullscreenBtn");
const transcriptBtn = $("transcriptBtn");
const chatDrawer = $("chatDrawer");
const captionWrap = $("captions");
const captionText = $("captionText");
const companionEl = $("companion");
const bigMic = $("bigMic");
const bigMicIcon = $("bigMicIcon");
const stopSpeakReal = $("stopSpeak");
const portraitArt = $("companionArt");
const faceStateLabel = $("faceStateLabel");
const brainBox = $("brainBox");
const elStatus = $("elStatus");
const elVoices = $("elVoices");

let memorySuggestion = null;
let streaming = false;

// Voice state machine: "idle" | "listening" | "thinking" | "speaking"
let voiceMode = false;        // hands-free mode on/off
let machine = "idle";         // what ZENITH is doing
let userPausedListening = false;
let elConfigured = false;     // ElevenLabs key + selected voice
let speakTyped = false;       // Settings: also speak replies to typed messages
let speakThisTurn = false;    // whether the current reply is spoken at all
let meterFlagged = false;     // the mic meter saw the user talk over ZENITH
let cappedBannerShown = false;
let elBrokenThisTurn = false; // fall back to system voice if EL errors
let elWs = null;
let _elAudioEnded = false;
const sentenceQueue = []; // sentences awaiting an open ElevenLabs socket
let elWatchdog = null; // gives up on ElevenLabs and falls back after this long
let elStreamEnded = false;

// Per-turn ElevenLabs budget. The server enforces a HARD cap (default 420
// characters per reply) and counts the exact bytes it sends upstream — each
// clause plus its separator space (len + 1); the browser mirrors that
// arithmetic so each clause is routed atomically — never half on ElevenLabs
// and half on Kokoro — and once the cap forces a switch, the whole remainder
// of the reply stays on Kokoro. Reset per turn in ttsStart().
let elTurnChars = 0;
let elTurnCap = 420; // refreshed from /api/elevenlabs/status (local read)
let elTurnSwitched = false;

// Timing probe — read via window.ZT from devtools or tests. Always a plain
// window property (let/const globals are not window-visible).
window.ZT = null;
let previewAudio = null;

// ---------------------------------------------------------------------------
// Status UI
// ---------------------------------------------------------------------------

function setMachine(next) {
  machine = next;
  // Keep ZENITH's face in step with the same state machine.
  if (typeof syncFaceFromMachine === "function") syncFaceFromMachine();
  // Pill + dot
  const map = {
    idle: ["ready", "ready"],
    listening: ["listening", "listening…"],
    thinking: ["thinking", "thinking…"],
    speaking: ["speaking", "speaking…"],
    offline: ["offline", "offline"],
  };
  const [cls, label] = map[next] || map.idle;
  dot.className = "dot " + cls;
  statusText.textContent = label;

  // Caption display: lit while speaking or while recognized speech is shown.
  captionWrap.classList.toggle("dim", next === "idle" || next === "offline");
  if (next === "idle" || next === "listening") captionText.textContent = "";

  // Companion-stage visuals: scene class, mic button state, stop button.
  companionEl.classList.toggle("listening", next === "listening");
  companionEl.classList.toggle("speaking", next === "speaking");
  faceStateLabel.textContent = label;
  bigMicIcon.textContent = next === "listening" ? "⏸️" : "🎙️";
  bigMic.title =
    next === "listening"
      ? "Listening — tap to stop"
      : "Tap to listen hands-free; tap again to stop";
  stopSpeakReal.hidden = next !== "speaking";

  // Voice strip controls (only meaningful while voice mode is on)
  if (voiceMode) {
    voiceStrip.hidden = false;
    const stateLabels = { idle: "Ready — talk whenever", listening: "Listening", thinking: "Thinking", speaking: "Speaking" };
    voiceStateText.textContent = stateLabels[next] || "Ready";
    liveTranscript.hidden = next !== "listening";
    pauseListenBtn.hidden = userPausedListening || next === "speaking" || next === "thinking";
    resumeListenBtn.hidden = !userPausedListening;
    stopSpeakBtn.hidden = next !== "speaking";
    micIcon.textContent = "🎙️";
    micBtn.classList.add("active");
  } else {
    voiceStrip.hidden = true;
    micIcon.textContent = "🎙️";
    micBtn.classList.remove("active");
    liveTranscript.textContent = "";
  }
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addMessage(role, text) {
  const div = document.createElement("div");
  div.className = "message " + role;
  // sel-mark is invisible outside selection mode; CSS reveals it there.
  const mark = document.createElement("span");
  mark.className = "sel-mark";
  mark.setAttribute("aria-hidden", "true");
  div.appendChild(mark);
  const p = document.createElement("p");
  p.textContent = text;
  div.appendChild(p);
  messagesEl.appendChild(div);
  scrollToBottom();
  return p;
}

async function loadHistory() {
  try {
    const res = await fetch("/api/history");
    const history = await res.json();
    for (const m of history) addMessage(m.role, m.text);
    if (history.length) {
      lastSeenId = history[history.length - 1].id ?? null;
    }
    if (history.length === 0) {
      addMessage("assistant", "ZENITH here. Say hello — tell me what's on your mind, or what you'd like to work on.");
    }
  } catch {
    // Server may still be connecting; the status check will report it.
  }
}

// Reconcile the history pointer after our own turn — don't re-render what's
// already on screen, but never let a scheduled message slip in unnoticed.
async function reconcileHistory() {
  try {
    const res = await fetch("/api/history");
    const history = await res.json();
    if (history.length) lastSeenId = history[history.length - 1].id ?? lastSeenId;
  } catch {
    // ignore; the next watcher tick tries again
  }
}

// Scheduled check-ins and reminders: they arrive server-side while nobody is
// typing. Render them, and speak them aloud when voice mode is on.
let lastSeenId = null;

async function watchForScheduled() {
  if (streaming || machine === "thinking" || machine === "speaking") return;
  try {
    const res = await fetch("/api/history");
    const history = await res.json();
    if (!history.length) return;
    const idx = history.findIndex((m) => m.id === lastSeenId);
    const fresh = idx === -1 ? history : history.slice(idx + 1);
    if (!fresh.length) return;
    for (const m of fresh) addMessage(m.role, m.text);
    lastSeenId = history[history.length - 1].id;
    const assistants = fresh.filter((m) => m.role === "assistant");
    if (assistants.length) {
      if (voiceMode) {
        announce(assistants[assistants.length - 1].text);
      } else {
        addMessage("system", "(ZENITH spoke this while voice mode was off — scroll up to read it.)");
      }
    }
  } catch {
    // network blip; next tick retries
  }
}

function announce(text) {
  if (!text || !voiceMode) return;
  // Same sentence/voice pipeline as a streamed reply, just with all the text
  // available at once. Interruptible the same way (Stop speaking or talking).
  speakThisTurn = true;
  setMachine("speaking");
  meterStart();
  ttsStart();
  window.ZT = { t0: performance.now(), firstTextAt: performance.now(), firstAudioAt: null, wsOpenAt: null, sentences: 0, fallback: false };
  for (const sentence of sentenceChunks(text).sentences) {
    const clean = speakableText(sentence);
    if (clean) speakSentence(clean);
  }
  ttsEnd();
}

// ---------------------------------------------------------------------------
// Voice configuration — learn what voice is actually saved, without opening a drawer
// ---------------------------------------------------------------------------

async function refreshElConfig() {
  // Never flip the configuration mid-turn; it would mix voices.
  if (machine !== "idle") return;
  try {
    const res = await fetch("/api/elevenlabs/status");
    const st = await res.json();
    elConfigured = !!(st.configured && st.voiceId);
    speakTyped = st.speakTyped === true;
    elTurnCap = st.usage && Number.isFinite(st.usage.turnCap) ? st.usage.turnCap : elTurnCap;
    return st;
  } catch {
    // keep whatever we had
    return null;
  }
}

async function checkStatus() {
  // Don't clobber live voice states with the background poll
  if (voiceMode && (machine === "listening" || machine === "thinking" || machine === "speaking")) return;
  try {
    const res = await fetch("/api/status");
    const data = await res.json();
    if (!data.ok) {
      dot.className = "dot offline";
      statusText.textContent = "offline: " + (data.error || "not connected");
    } else if (machine === "idle") {
      dot.className = "dot ready";
      statusText.textContent = "ready";
    }
    if (data.model) {
      brainBox.innerHTML =
        `<b>Brain:</b> ${escapeHtml(data.model.providerID)} / ${escapeHtml(data.model.id)}` +
        (data.agent ? `<br><b>Agent profile:</b> ${escapeHtml(data.agent)}` : "");
    }
    return data.ok;
  } catch {
    dot.className = "dot offline";
    statusText.textContent = "offline";
    return false;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// ---------------------------------------------------------------------------
// Text normalisation helpers (echo filter + TTS)
// ---------------------------------------------------------------------------

function normalizeWords(text) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").split(/\s+/).filter(Boolean);
}

const recentSpoken = []; // sentences ZENITH is currently saying (echo guard)

function isEchoOfZenith(text) {
  const words = normalizeWords(text);
  if (words.length === 0) return true;
  if (words.length === 1) return false;
  const spoken = normalizeWords(recentSpoken.slice(-3).join(" "));
  if (spoken.length === 0) return false;
  const inSpoken = words.filter((w) => spoken.includes(w)).length;
  return inSpoken / words.length >= 0.6;
}

function speakableText(text) {
  return text
    .replace(/```[\s\S]*?```/g, " code block ")
    .replace(/\[(.*?)\]\((.*?)\)/g, "$1")
    .replace(/[*_`#>|]+/g, "")
    .replace(/https?:\/\/\S+/g, "a link")
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Audio playback — raw PCM 22050 from ElevenLabs, scheduled gap-free
// ---------------------------------------------------------------------------

let audioCtx = null;
const activeSources = [];
let nextStartTime = 0;

function ensureAudio() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) audioCtx = new Ctx();
  }
  if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}

// Telemetry so playback failures can never be silent. window.__audioHealth is
// intentionally a plain window property (let/const globals aren't window-visible).
window.__audioHealth = { chunksReceived: 0, played: 0, skippedSuspended: 0, errors: 0, peakLevel: 0 };

function showAudioBlockedBanner() {
  const banner = document.getElementById("elBanner");
  if (!banner) return;
  banner.querySelector(".el-banner-msg").textContent =
    "ZENITH's voice is blocked by the browser until you interact — click anywhere on the page (or the mic) to enable sound. Text replies still work.";
  banner.hidden = false;
  const retry = document.getElementById("elBannerRetry");
  if (retry) retry.hidden = true;
}

// Unlock audio on ANY first interaction (browsers require a gesture).
let audioUnlockArmed = false;
function armAudioUnlock() {
  if (audioUnlockArmed) return;
  audioUnlockArmed = true;
  const unlock = () => {
    ensureAudio();
    if (audioCtx && audioCtx.state === "running" && !document.getElementById("elBanner").hidden) {
      hideElBanner();
    }
    document.removeEventListener("pointerdown", unlock);
    document.removeEventListener("keydown", unlock);
  };
  document.addEventListener("pointerdown", unlock);
  document.addEventListener("keydown", unlock);
}

function pcmToAudioBuffer(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const frames = arrayBuffer.byteLength / 2;
  const channel = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const sample = view.getInt16(i * 2, true);
    channel[i] = sample < 0 ? sample / 32768 : sample / 32767;
  }
  return channel;
}

// Schedule a Float32 PCM chunk gap-free. Shared by ElevenLabs (22050) and
// Kokoro (24000) — the lip-sync of Stage 4 keys off these scheduled sources,
// so both engines animate the same way.
function playSamples(samples, sampleRate) {
  const ctx = ensureAudio();
  const H = window.__audioHealth;
  if (!ctx) {
    H.errors++;
    showAudioBlockedBanner();
    return;
  }
  if (ctx.state !== "running") {
    // The browser is holding audio back (no user gesture yet). Never silent:
    // tell the user once and keep the turn's text flowing.
    H.skippedSuspended++;
    showAudioBlockedBanner();
    armAudioUnlock();
    return;
  }
  try {
    const now = ctx.currentTime;
    // Drained queue: this source starts at `now` rather than chained onto a
    // still-playing one — e.g. the ElevenLabs→Kokoro handoff, or a chunk that
    // arrived after the previous audio finished. Fade the first ~4 ms in so
    // the mid-phase restart doesn't click.
    const drained = nextStartTime <= now;
    const startAt = Math.max(now, nextStartTime);
    let out = samples;
    if (drained) {
      const fade = Math.min(samples.length, Math.round(0.004 * sampleRate));
      out = samples.slice();
      for (let i = 0; i < fade; i++) out[i] *= i / fade;
    }
    const buffer = ctx.createBuffer(1, out.length, sampleRate);
    buffer.copyToChannel(out, 0);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const analyser = ensureAnalyser();
    source.connect(analyser);
    analyser.connect(ctx.destination);
    source.start(startAt);
    nextStartTime = startAt + buffer.duration;
    activeSources.push(source);
    H.played++;
    if (ZT && !ZT.firstAudioAt) ZT.firstAudioAt = performance.now();
    source.onended = () => {
      const idx = activeSources.indexOf(source);
      if (idx >= 0) activeSources.splice(idx, 1);
      maybeFinishSpeaking();
    };
  } catch (err) {
    H.errors++;
    showElBanner("Audio playback failed (" + (err.message || err) + ") — text replies still work.");
  }
}

function playPcmChunk(arrayBuffer) {
  playSamples(pcmToAudioBuffer(arrayBuffer), 22050);
}

// Master analyser taps the final mix, so the face reacts to whatever is
// actually playing — ElevenLabs, local Kokoro, or nothing (system voice).
let masterAnalyser = null;
let analyserData = null;
let audioLevel = 0;

function ensureAnalyser() {
  if (masterAnalyser || !audioCtx) return masterAnalyser;
  masterAnalyser = audioCtx.createAnalyser();
  masterAnalyser.fftSize = 256;
  analyserData = new Uint8Array(masterAnalyser.fftSize);
  return masterAnalyser;
}

function sampleAudioLevel() {
  if (!masterAnalyser) return 0;
  masterAnalyser.getByteTimeDomainData(analyserData);
  let sum = 0;
  for (let i = 0; i < analyserData.length; i++) {
    const v = (analyserData[i] - 128) / 128;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / analyserData.length);
  audioLevel = audioLevel * 0.8 + rms * 0.2;
  return audioLevel;
}

// Local Kokoro fallback path: synthesize one sentence, schedule it, stay
// interruptible via kokoroAborted.
async function kokoroEnqueue(clean) {
  kokoroPending++;
  kokoroTurnEnded = false;
  try {
    if (!kokoroMod) kokoroMod = await import("/kokoro.js");
    const { samples, sampleRate } = await kokoroMod.kokoroSentence(clean, KOKORO_VOICE);
    if (kokoroAborted) return; // the user interrupted — drop the stale audio
    playSamples(samples, sampleRate);
  } catch (err) {
    if (kokoroAborted) return;
    speakSystem(clean); // keep ZENITH talking even if the local model fails
    showElBanner("Local voice failed (" + (err.message || err) + ") — using the system voice for now.");
    showRetryInBanner(false);
  } finally {
    kokoroPending--;
    maybeFinishSpeaking();
  }
}

function stopAllPlayback() {
  for (const s of activeSources) {
    try {
      s.stop();
    } catch {
      // already ended
    }
  }
  activeSources.length = 0;
  nextStartTime = 0;
}

// ---------------------------------------------------------------------------
// Mic meter — detects that the user is talking while ZENITH speaks (barge-in)
// ---------------------------------------------------------------------------

let meterStream = null;
let meterAnalyser = null;
let meterRAF = null;
let meterHoldSince = 0;

async function meterStart() {
  try {
    meterStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const ctx = ensureAudio();
    const source = ctx.createMediaStreamSource(meterStream);
    meterAnalyser = ctx.createAnalyser();
    meterAnalyser.fftSize = 512;
    source.connect(meterAnalyser);
    meterHoldSince = 0;
    const data = new Uint8Array(meterAnalyser.fftSize);
    // Slow-moving floor = ZENITH's own voice leaking from the speakers into
    // the mic. A real interruption has to rise clearly above that floor and
    // stay there, so he stops cutting himself off on laptop speakers.
    let floor = 0;
    const tick = () => {
      if (!meterAnalyser) return;
      meterAnalyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / data.length);
      floor = floor * 0.98 + rms * 0.02;
      const threshold = Math.max(0.045, floor * 2.2);
      if (rms > threshold) {
        if (!meterHoldSince) meterHoldSince = performance.now();
        else if (performance.now() - meterHoldSince > 450) {
          // The user is clearly talking over ZENITH — interrupt.
          meterFlagged = true;
          interruptZenith("voice");
          meterStop();
          return;
        }
      } else {
        meterHoldSince = 0;
      }
      meterRAF = requestAnimationFrame(tick);
    };
    tick();
  } catch {
    // mic permission for the meter is separate from SpeechRecognition; ignore
  }
}

function meterStop() {
  if (meterRAF) cancelAnimationFrame(meterRAF);
  meterRAF = null;
  meterAnalyser = null;
  if (meterStream) {
    for (const track of meterStream.getTracks()) track.stop();
    meterStream = null;
  }
}

// ---------------------------------------------------------------------------
// Streaming TTS: ElevenLabs (streaming PCM) with system-voice fallback
// ---------------------------------------------------------------------------

let ttsPending = ""; // text buffer before a sentence boundary
// Per-turn recovery state: if ElevenLabs dies without ever sending audio, the
// text that was already displayed but never spoken is re-spoken with the
// system voice, so a TTS failure can never leave a silent reply.
let elChunksThisTurn = false;
let elSpokenThisTurn = "";
let elRecovered = false;

function sentenceChunks(text) {
  const out = [];
  let rest = text;
  // Sentence boundaries end a speaking unit, but a long reply often
  // streams for 30s+ with no sentence terminator at all (voice-style replies
  // end on "okay?", "right", or nothing). Holding all text until a period
  // starves the ElevenLabs stream, whose upstream socket has a 30s inactivity
  // timeout — so also release at clause boundaries (comma/semicolon/newline),
  // and flush a trailing fragment once it is long enough to be worth saying.
  // Any remainder stays buffered until ttsEnd().
  const re = /[^.!?।]+[.!?।]+(?:\s|$)|[^,;\n]+[,;\n](?:\s|$)|[^.!?।,;\n]{24,}$/g;
  let m;
  while ((m = re.exec(rest))) out.push(m[0].trim());
  const consumed = out.join(" ");
  const leftover = rest.slice(consumed ? consumed.length : 0).trim();
  return { sentences: out.filter((s) => s.length), leftover };
}

function ttsReset() {
  ttsPending = "";
  recentSpoken.length = 0;
}

// ---------------------------------------------------------------------------
// ElevenLabs error banner — visible, dismissible, never silent
// ---------------------------------------------------------------------------

function showElBanner(message) {
  const banner = document.getElementById("elBanner");
  if (!banner) return;
  banner.querySelector(".el-banner-msg").textContent = message;
  banner.hidden = false;
}

function hideElBanner() {
  const banner = document.getElementById("elBanner");
  if (banner) banner.hidden = true;
}

// ---------------------------------------------------------------------------
// Voice engine selection: ElevenLabs while credits last; local Kokoro when the
// API reports quota exhaustion. Never switches on ordinary network errors.
// ---------------------------------------------------------------------------

let engine = "elevenlabs"; // "elevenlabs" | "kokoro"
let kokoroMod = null;
let kokoroPending = 0;
let kokoroTurnEnded = false;
let kokoroAborted = false;
const KOKORO_VOICE = "am_michael"; // male; alternatives: am_fenrir, am_puck, bm_george

function looksLikeQuota(msg) {
  return /quota|insufficient credits|out of credits|balance|character limit|exceeded your/i.test(String(msg || ""));
}

async function refreshEngine() {
  try {
    const s = await (await fetch("/api/voice/status")).json();
    if (machine === "idle") engine = s.engine || "elevenlabs";
    renderVoiceLabel(s);
    if (s.quotaExhaustedAt && machine === "idle") {
      showElBanner("ElevenLabs credits are exhausted — ZENITH is speaking with the local Kokoro voice (slower, but no subscription needed).");
      showRetryInBanner(true);
    } else {
      // Recovered (or never exhausted): clear any stale quota banner.
      if (!s.quotaExhaustedAt && machine === "idle") {
        hideElBanner();
        showRetryInBanner(false);
      }
    }
    return s;
  } catch {
    return null;
  }
}

function renderVoiceLabel(s) {
  const label = document.getElementById("voiceLabel");
  if (!label) return;
  if (engine === "kokoro") {
    label.textContent = "Voice: Kokoro (local)";
    label.className = "voice-label local";
  } else {
    label.textContent = "Voice: " + (s?.voiceName || "ElevenLabs");
    label.className = "voice-label";
  }
}

function showRetryInBanner(show) {
  const btn = document.getElementById("elBannerRetry");
  if (btn) btn.hidden = !show;
}

async function retryElevenLabs() {
  try {
    await fetch("/api/voice/retry", { method: "POST" });
  } catch {}
  engine = "elevenlabs";
  hideElBanner();
  await refreshEngine();
}

// ---------------------------------------------------------------------------
// TTS engine: ElevenLabs streaming PCM with system-voice fallback
// ---------------------------------------------------------------------------

function ttsStart() {
  meterFlagged = false;
  elBrokenThisTurn = false;
  elStreamEnded = false;
  elChunksThisTurn = false;
  elSpokenThisTurn = "";
  elRecovered = false;
  // Fresh ElevenLabs budget for this turn (hard cap; whole clauses only).
  // The +1 mirrors the single-space protocol frame the server sends once per
  // upstream stream open (counted locally there; not confirmed billed), so a
  // "fits" decision here matches the server's accounting.
  elTurnChars = engine === "elevenlabs" && elConfigured ? 1 : 0;
  elTurnSwitched = false;
  sentenceQueue.length = 0;
  kokoroAborted = false;
  kokoroTurnEnded = false;
  if (elWatchdog) {
    clearTimeout(elWatchdog);
    elWatchdog = null;
  }
  hideElBanner();
  ttsReset();
  if (engine === "kokoro") {
    // Precache the local model so the first sentence doesn't wait on the load.
    import("/kokoro.js")
      .then((m) => m.getKokoroTTS({ onStatus: () => {} }))
      .catch(() => {});
    return;
  }
  if (elConfigured) {
    // Open the ElevenLabs socket at the START of the turn (not on first byte)
    // so the first sentence faces no connection delay.
    try {
      elWs = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/voice`);
      elWs.binaryType = "arraybuffer";
      elWs.onopen = () => {
        if (ZT) ZT.wsOpenAt = performance.now();
        try {
          elWs.send(JSON.stringify({ type: "start" }));
        } catch {
          // will surface via onerror/onclose
        }
        // Send anything that piled up while we were connecting.
        for (const s of sentenceQueue.splice(0)) sendElText(s);
        if (elStreamEnded) {
          try {
            elWs.send(JSON.stringify({ type: "end" }));
          } catch {}
        }
      };
      elWs.onerror = () => {
        // The close handler runs right after; that's where we recover.
      };
      elWs.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          // Raw PCM frame from ElevenLabs → schedule playback right away.
          window.__audioHealth.chunksReceived++;
          elChunksThisTurn = true;
          playPcmChunk(event.data);
          return;
        }
        try {
          const frame = JSON.parse(event.data);
          if (frame.type === "error") {
            elBrokenThisTurn = true;
            flushQueueToFallback();
            if (looksLikeQuota(frame.message)) {
              // Genuine quota exhaustion — switch to local Kokoro now.
              engine = "kokoro";
              renderVoiceLabel();
              showElBanner("ElevenLabs credits are exhausted — switching to the local Kokoro voice (slower, no subscription needed). You can retry from here after topping up.");
              showRetryInBanner(true);
            } else {
              showElBanner("ElevenLabs failed (" + (frame.message || "upstream error") + ") — using the system voice for now.");
              showRetryInBanner(false);
            }
          } else if (frame.type === "capped") {
            // Over the per-reply or monthly ElevenLabs budget: the local voice
            // finishes this sentence so ZENITH never goes quiet. The server's
            // count is authoritative — once it says the cap is reached, the
            // rest of this reply stays on Kokoro too.
            elTurnSwitched = true;
            if (frame.reason === "month" && !cappedBannerShown) {
              cappedBannerShown = true;
              showElBanner("Monthly ElevenLabs budget reached — ZENITH is using the local voice until the month resets (raise the cap in data/settings.json if you topped up).");
            }
            if (frame.text) kokoroEnqueue(frame.text);
          } else if (frame.type === "audio_end") {
            // Normal end of a healthy stream. If no audio ever arrived, the
            // upstream timed out or was rejected — recover the spoken text.
            elMaybeRecoverSilent();
            _elAudioEnded = true;
            maybeFinishSpeaking();
          }
        } catch {
          // ignore non-JSON control frames
        }
      };
      elWs.onclose = () => {
        elMaybeRecoverSilent();
        if (elWs && !elBrokenThisTurn && elWs.readyState !== WebSocket.OPEN && sentenceQueue.length) {
          // Closed early with unsent sentences → fall back rather than go silent.
          elBrokenThisTurn = true;
          flushQueueToFallback();
          showElBanner("ElevenLabs connection dropped — using the system voice for now.");
        }
        _elAudioEnded = true;
        maybeFinishSpeaking();
      };
      _elAudioEnded = false;
      // If the socket never opens, don't leave the user in silence.
      elWatchdog = setTimeout(() => {
        if (elWs && elWs.readyState !== WebSocket.OPEN && sentenceQueue.length) {
          elBrokenThisTurn = true;
          flushQueueToFallback();
          showElBanner("ElevenLabs didn't open in time — using the system voice for now.");
        }
      }, 3500);
    } catch {
      elBrokenThisTurn = true;
    }
  }
}

// text that was displayed but never heard is re-spoken with the system voice.

function elMaybeRecoverSilent() {
  if (elRecovered || elBrokenThisTurn) return;
  // Only when the turn is still expecting speech and no audio ever arrived.
  if (!streaming && machine !== "speaking") return;
  if (elChunksThisTurn) return;
  const tail = ttsPending.trim();
  const lost = [elSpokenThisTurn, tail].map((s) => speakableText(s).trim()).filter(Boolean);
  if (!lost.length && !sentenceQueue.length) return;
  elRecovered = true;
  elBrokenThisTurn = true;
  flushQueueToFallback();
  for (const text of lost) speakSystem(text);
  ttsPending = "";
  showElBanner("The ElevenLabs stream went silent before any audio arrived — finishing this reply with the system voice. Text was not affected.");
  maybeFinishSpeaking();
}

function sendElText(text) {
  if (elWs && elWs.readyState === WebSocket.OPEN && !elBrokenThisTurn) {
    elWs.send(JSON.stringify({ type: "text", text }));
    elSpokenThisTurn += " " + text;
    return true;
  }
  sentenceQueue.push(text);
  return false;
}

function flushQueueToFallback() {
  if (elWatchdog) {
    clearTimeout(elWatchdog);
    elWatchdog = null;
  }
  const queued = sentenceQueue.splice(0);
  for (const sentence of queued) speakSystem(sentence);
  if (ZT) ZT.fallback = true;
}

function speakSystem(text) {
  if (!("speechSynthesis" in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  u.onstart = () => {
    if (machine === "thinking") setMachine("speaking");
  };
  u.onend = maybeFinishSpeaking;
  window.speechSynthesis.speak(u);
}

function speakSentence(clean) {
  recentSpoken.push(clean);
  if (ZT) ZT.sentences++;
  if (engine === "kokoro" || elTurnSwitched) {
    kokoroEnqueue(clean);
  } else if (elConfigured && !elBrokenThisTurn) {
    // Whole-clause ElevenLabs budgeting, matched 1:1 with the server's
    // accounting: the clause plus the separator space counts as the cost
    // (len + 1), so a "fits" decision here is not rejected there.
    const cost = clean.length + 1;
    if (elTurnChars + cost <= elTurnCap) {
      elTurnChars += cost;
      sendElText(clean); // queues internally if the socket isn't open yet
    } else {
      elTurnSwitched = true;
      kokoroEnqueue(clean);
    }
  } else {
    speakSystem(clean);
    if (ZT) ZT.fallback = true;
  }
  if (machine === "thinking") {
    setMachine("speaking");
    if (sttMode !== "server") meterStart(); // listen for the user cutting in
  }
}

function ttsFeed(delta) {
  if (ZT && !ZT.firstTextAt) ZT.firstTextAt = performance.now();
  ttsPending += delta;
  const { sentences, leftover } = sentenceChunks(ttsPending);
  ttsPending = leftover;
  for (const sentence of sentences) {
    const clean = speakableText(sentence);
    if (!clean) continue;
    speakSentence(clean);
  }
}

function ttsEnd() {
  // Flush any trailing text that never reached a sentence boundary.
  const tail = ttsPending.trim();
  ttsPending = "";
  if (tail) {
    const clean = speakableText(tail);
    if (clean) speakSentence(clean);
  }
  elStreamEnded = true;
  if (engine === "kokoro") {
    kokoroTurnEnded = true;
    maybeFinishSpeaking();
    return;
  }
  if (elConfigured && elWs && elWs.readyState === WebSocket.OPEN) {
    elWs.send(JSON.stringify({ type: "end" }));
  }
  // If the socket is still connecting, onopen will send "end" after flushing.
}

function ttsStop() {
  stopAllPlayback();
  meterStop();
  if (elWatchdog) {
    clearTimeout(elWatchdog);
    elWatchdog = null;
  }
  sentenceQueue.length = 0;
  kokoroAborted = true; // drop any in-flight Kokoro synthesis for this turn
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  if (elWs) {
    try {
      if (elWs.readyState === WebSocket.OPEN) elWs.send(JSON.stringify({ type: "stop" }));
      elWs.close();
    } catch {
      // already closed
    }
    elWs = null;
  }
  recentSpoken.length = 0;
  ttsPending = "";
}

function maybeFinishSpeaking() {
  // Playback truly done when nothing scheduled and no synthesis in flight.
  if (machine !== "speaking") return;
  if (streaming) return; // more of the reply is still coming
  if (activeSources.length > 0) return;
  if (kokoroPending > 0) return;
  if (engine === "kokoro") {
    if (!kokoroTurnEnded) return;
  } else {
    if (elConfigured && !elBrokenThisTurn && !_elAudioEnded) return;
    if (elConfigured && elWs && (elWs.readyState === WebSocket.OPEN || elWs.readyState === WebSocket.CONNECTING) && !_elAudioEnded) return;
    if ("speechSynthesis" in window && window.speechSynthesis.speaking) return;
  }
  if (sttMode !== "server") meterStop();
  if (voiceMode) {
    if (sttMode !== "server" && recognition && !recognizing) safeStartRecognition();
    maybeRestartServerStt();
  }
  setMachine(voiceMode ? "listening" : "idle");
}

function interruptZenith(reason) {
  // Stop ZENITH's voice immediately; recognition is already live.
  ttsStop();
  if (machine === "speaking" || machine === "thinking") setMachine(voiceMode ? "listening" : "idle");
  liveTranscript.textContent = "";
}


// ---------------------------------------------------------------------------
// Server-side speech-to-text (preferred when a STT provider is configured).
// Records the user's voice continuously in voice mode, detects the end of an
// utterance by silence, and uploads the clip to /api/stt, which forwards it to
// the configured provider. The browser Web Speech API stays as a fallback.
// ---------------------------------------------------------------------------

const STT_SILENCE_MS = 1100;
let sttMode = "web"; // "web" | "server" | "none" — resolved at boot
let sttRecorder = null;
let sttStream = null;
let sttAudioCtx = null;
let sttAnalyser = null;
let sttRAF = null;
let sttChunks = [];
let sttMime = "";
let sttFloor = 0;
let sttHasSpeech = false;
let sttLastSpeechAt = 0;
let sttHoldSince = 0;
let sttTranscribing = false;

async function resolveSttMode() {
  let configured = false;
  try {
    const r = await fetch("/api/stt/status");
    const st = await r.json();
    configured = !!st?.configured;
  } catch {
    configured = false;
  }
  const canRecord =
    !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) &&
    !!window.MediaRecorder;
  if (configured && canRecord) sttMode = "server";
  else if (window.SpeechRecognition || window.webkitSpeechRecognition) sttMode = "web";
  else sttMode = "none";
  return sttMode;
}

function stopServerSttRecorder() {
  if (sttRAF) {
    cancelAnimationFrame(sttRAF);
    sttRAF = null;
  }
  if (sttRecorder) {
    try {
      if (sttRecorder.state !== "inactive") sttRecorder.stop();
    } catch {}
    sttRecorder = null;
  }
  if (sttStream) {
    for (const track of sttStream.getTracks()) track.stop();
    sttStream = null;
  }
  if (sttAudioCtx) {
    sttAudioCtx.close().catch(() => {});
    sttAudioCtx = null;
  }
  sttAnalyser = null;
  sttHasSpeech = false;
  sttLastSpeechAt = 0;
  sttHoldSince = 0;
  sttFloor = 0;
  sttChunks = [];
}

let sttArming = false;

async function startServerStt() {
  if (sttMode !== "server") return;
  if (sttRecorder || sttTranscribing || sttArming) return;
  if (!voiceMode || userPausedListening) return;
  sttArming = true;
  try {
    let domStream;
    try {
      domStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      captionText.classList.remove("you");
      captionText.textContent =
        "🎤 Microphone blocked or missing — allow mic permission in your browser, then tap the mic again.";
      return;
    }
    sttStream = domStream;

    try {
      const mime =
        ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"].find((t) =>
          window.MediaRecorder?.isTypeSupported?.(t)
        ) || "";
      sttMime = mime;
      sttAudioCtx = new AudioContext();
      const source = sttAudioCtx.createMediaStreamSource(sttStream);
      sttAnalyser = sttAudioCtx.createAnalyser();
      sttAnalyser.fftSize = 1024;
      source.connect(sttAnalyser);
      sttChunks = [];
      sttFloor = 0;
      sttHasSpeech = false;
      sttLastSpeechAt = 0;
      sttHoldSince = 0;

      const recorder = mime ? new MediaRecorder(sttStream, { mimeType: mime }) : new MediaRecorder(sttStream);
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size) sttChunks.push(e.data);
      };
      recorder.start(250);
      sttRecorder = recorder;

      const data = new Uint8Array(sttAnalyser.fftSize);
      const tick = () => {
        if (!sttAnalyser || !sttRecorder) {
          sttRAF = null;
          return;
        }
        sttAnalyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / data.length);
        sttFloor = sttFloor * 0.98 + rms * 0.02;
        const threshold = Math.max(0.03, sttFloor * 2.2);
        const now = performance.now();
        const talking = machine === "speaking" || machine === "thinking";
        if (!talking) {
          if (rms > threshold) {
            sttHasSpeech = true;
            sttLastSpeechAt = now;
          } else if (sttHasSpeech && now - sttLastSpeechAt > STT_SILENCE_MS) {
            sttHasSpeech = false;
            uploadServerStt(); // never blocks — it tears down the recorder itself
          }
        } else {
          // While ZENITH speaks: interrupt only if the user is clearly louder than the leak.
          if (rms > threshold) {
            if (!sttHoldSince) sttHoldSince = now;
            else if (now - sttHoldSince > 450) {
              meterFlagged = true;
              sttHoldSince = 0;
              sttFloor = 0;
              sttHasSpeech = false;
              interruptZenith("voice");
            }
          } else {
            sttHoldSince = 0;
          }
        }
        sttRAF = requestAnimationFrame(tick);
      };
      sttRAF = requestAnimationFrame(tick);
    } catch (err) {
      // Recorder unsupported — degrade gracefully to the browser speech engine.
      stopServerSttRecorder();
      sttMode = "web";
      captionText.classList.remove("you");
      captionText.textContent =
        "🎤 Server-side recording unavailable — using the browser speech engine instead.";
      safeStartRecognition();
    }
  } finally {
    sttArming = false;
  }
}

// Tear down the recorder (keeps the clip), upload it, then re-arm listening.
async function uploadServerStt() {
  if (!sttRecorder || sttTranscribing) return;
  sttTranscribing = true;
  const chunks = sttChunks.slice();
  const mime = sttMime;
  stopServerSttRecorder(); // cancel rAF, stop recorder, stop tracks
  try {
    const blob = new Blob(chunks, { type: mime || "audio/webm" });
    if (blob.size >= 1500) {
      const form = new FormData();
      form.append("file", blob, "audio.webm");
      let text = "";
      let error = null;
      try {
        const res = await fetch("/api/stt", { method: "POST", body: form });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data || data.error) {
          error = data?.error || `Speech recognition failed (HTTP ${res.status})`;
        } else {
          text = String(data?.text || "").trim();
        }
      } catch (err) {
        error = "Speech recognition could not reach the server.";
      }
      if (error) {
        captionText.classList.remove("you");
        captionText.textContent = "🎤 " + error + " — holding on.";
      } else if (text) {
        const heard = text;
        liveTranscript.textContent = heard;
        if (isEchoOfZenith(heard)) {
          // That was ZENITH's own audio leaking into the mic — ignore.
        } else {
          submitUtterance(heard);
        }
      }
    }
  } catch (err) {
    captionText.classList.remove("you");
    captionText.textContent = "🎤 " + (err?.message || "Speech recognition failed.");
  } finally {
    sttTranscribing = false;
    if (voiceMode && !userPausedListening) {
      startServerStt().catch(() => {});
    }
  }
}

// Restart listening when the machine is idle (after a turn completes).
function maybeRestartServerStt() {
  if (sttMode !== "server") return;
  if (!voiceMode || userPausedListening) return;
  if (streaming || machine === "speaking" || machine === "thinking") return;
  if (sttRecorder || sttTranscribing) return;
  startServerStt();
}

// ---------------------------------------------------------------------------
// Recognition — continuous listening while voice mode is on
// ---------------------------------------------------------------------------

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let recognizing = false;
let restartTimer = null;
let lastRestartAt = 0;

if (SpeechRecognition) {
  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;

  recognition.onstart = () => {
    recognizing = true;
    lastRestartAt = 0;
  };

  recognition.onend = () => {
    recognizing = false;
    // Auto-restart so listening survives recognition's internal timeouts —
    // unless the user explicitly paused or exited voice mode.
    if (voiceMode && !userPausedListening && !streaming) {
      const now = performance.now();
      if (!lastRestartAt || now - lastRestartAt > 1000) {
        lastRestartAt = now;
        restartTimer = setTimeout(() => safeStartRecognition(), 120);
      } else if (!recognizing) {
        restartTimer = setTimeout(() => safeStartRecognition(), 1500);
      }
    } else if (voiceMode && userPausedListening) {
      setMachine("idle");
    }
    if (!voiceMode) liveTranscript.textContent = "";
  };

  recognition.onerror = (event) => {
    if (event.error === "not-allowed" || event.error === "service-not-allowed") {
      exitVoiceMode();
      statusText.textContent = "microphone blocked — allow mic permission, then try again";
      dot.className = "dot offline";
      captionText.classList.remove("you");
      captionText.textContent =
        "🎤 Microphone blocked — allow mic permission for this site in your browser settings, then tap the mic again.";
    } else if (event.error === "audio-capture") {
      exitVoiceMode();
      statusText.textContent = "no microphone found";
      dot.className = "dot offline";
      captionText.classList.remove("you");
      captionText.textContent =
        "🎤 No microphone found — connect a mic, then tap the mic again.";
    } else if (event.error === "network") {
      captionText.classList.remove("you");
      captionText.textContent =
        "🎤 Speech recognition hit a network error — listening will retry.";
    }
    // no-speech / aborted: onend will restart us
  };

  recognition.onresult = (event) => {
    let interim = "";
    let final = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      if (event.results[i].isFinal) final += event.results[i][0].transcript;
      else interim += event.results[i][0].transcript;
    }
    if (voiceMode) {
      const heard = (final || interim).trim();
      liveTranscript.textContent = heard;
      // Make the user's recognized speech visible on the main stage.
      captionText.classList.add("you");
      captionText.textContent = heard;
    }
    if (final.trim()) submitUtterance(final.trim());
  };
}

function safeStartRecognition() {
  if (!recognition || recognizing) return;
  try {
    recognition.lang = "en-IN";
    recognition.start();
  } catch {
    // thrown when start() races the previous stop
  }
}

function submitUtterance(text) {
  if (!text) return;
  if (machine === "speaking" && !meterFlagged) {
    // Nobody talked over him (the meter would have flagged it): this is
    // ZENITH's own voice leaking into the mic. Ignore it.
    liveTranscript.textContent = "";
    return;
  }
  if (isEchoOfZenith(text)) {
    // That was ZENITH's own speech coming back through the mic — ignore it.
    liveTranscript.textContent = "";
    return;
  }
  liveTranscript.textContent = "";
  // If ZENITH was mid-sentence, the user just cut it off. Keep listening after.
  interruptZenith("new-utterance");
  sendTurn(text);
}

// ---------------------------------------------------------------------------
// Chat turn (shared by voice and typing)
// ---------------------------------------------------------------------------

function sendTurn(text) {
  if (streaming) return;
  addMessage("user", text);
  streamChat(text);
}

async function streamChat(text) {
  streaming = true;
  selectBtn.disabled = true; // selection resumes when the reply finishes
  if (selectionMode) exitSelectionMode();
  // Timing probe: turn start → first text → first audio, and fallback flags.
  window.ZT = { t0: performance.now(), firstTextAt: null, firstAudioAt: null, wsOpenAt: null, sentences: 0, fallback: false, errors: [] };
  ZT.error = null;
  if (voiceMode) setMachine("thinking");
  else dot.className = "dot thinking";
  // Speak only when voice mode is on (or Settings says to speak typed replies):
  // every spoken character costs ElevenLabs credits.
  speakThisTurn = voiceMode || speakTyped;
  // Open the ElevenLabs socket NOW, while the brain is still thinking.
  if (speakThisTurn) ttsStart();
  const para = addMessage("assistant", "");
  let received = "";
  let firstByte = true;
  let doneSeen = false; // a well-formed turn always ends with a "done" event
  let errorSeen = false; // server reported a hard error mid-stream
  let reader = null;

  // One exit for every failure shape — refused/dropped connection, reader
  // throw, or a body that ends without "done": show the real reason, stop any
  // TTS turn in progress, and ALWAYS release the turn's locks (streaming flag,
  // voice state machine, disabled message box) so the app is never stuck.
  const failTurn = (detail) => {
    const reason = detail || "the reply was interrupted before it finished";
    para.textContent = received ? received + " ⚠ (" + reason + ")" : "⚠ " + reason;
    captionText.classList.remove("you");
    captionText.textContent = para.textContent;
    if (ZT) ZT.error = reason;
    if (speakThisTurn) ttsStop();
    try { reader?.cancel(); } catch {}
    streaming = false;
    selectBtn.disabled = false;
    setMachine(voiceMode ? "listening" : "idle");
    inputEl.disabled = false;
    inputEl.focus();
  };

  let res;
  try {
    res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch (err) {
    failTurn(err?.message || String(err));
    return;
  }

  if (!res.ok) {
    let detail = "Request failed.";
    try {
      const body = await res.json();
      detail = body?.error || detail;
    } catch {
      // non-JSON error body (proxy 502, empty response)
      detail = `Request failed (HTTP ${res.status}).`;
    }
    failTurn(detail);
    return;
  }

  const decoder = new TextDecoder();
  let buffer = "";

  const handleChunk = (event, data) => {
    if (event === "delta") {
      if (firstByte) {
        firstByte = false;
        ZT.firstDeltaAt = performance.now();
      }
      received += data.delta;
      para.textContent = received;
      captionText.classList.remove("you");
      captionText.textContent = received; // captions follow the spoken reply
      scrollToBottom();
      if (speakThisTurn) ttsFeed(data.delta);
    } else if (event === "done") {
      doneSeen = true;
      // The server's error path still sends "done" afterwards with whatever
      // text it has — don't clobber the real reason already on screen.
      if (errorSeen) {
        if (speakThisTurn) ttsEnd();
        return;
      }
      received = data.text || received;
      para.textContent = received;
      captionText.textContent = received;
      if (speakThisTurn) ttsEnd();
      if (data.suggestion) showMemoryChip(data.suggestion);
    } else if (event === "error") {
      errorSeen = true;
      const reason = data.error || "Something went wrong.";
      para.textContent = received ? received + " ⚠ (" + reason + ")" : "⚠ " + reason;
      captionText.classList.remove("you");
      captionText.textContent = para.textContent;
      if (speakThisTurn) ttsStop(); // a failed turn has nothing left worth saying
    }
  };

  try {
    reader = res.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() ?? "";
      for (const chunk of chunks) {
        let event = null;
        let data = "";
        for (const line of chunk.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (event) handleChunk(event, data ? JSON.parse(data) : {});
      }
    }
  } catch (err) {
    failTurn(err?.message || String(err));
    return;
  }

  if (!doneSeen) {
    // The stream ended without the session finishing — server crash, killed
    // process, or a dropped SSE connection. Mark it, don't fake completion.
    failTurn(null);
    return;
  }

  if (!received && !errorSeen) {
    para.textContent = "(no reply received — check the status indicator above)";
  }
  // Mark this turn as seen so the scheduled-message watcher doesn't re-render it.
  reconcileHistory();
  streaming = false;
  selectBtn.disabled = false;
  if (!voiceMode) setMachine("idle");
  inputEl.disabled = false;
  inputEl.focus();
}

composer.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = inputEl.value.trim();
  if (!text || streaming) return;
  ensureAudio(); // a keypress/click just happened — unlock the audio context
  interruptZenith("typed");
  inputEl.value = "";
  autoGrow();
  inputEl.disabled = true;
  sendTurn(text);
});

function autoGrow() {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + "px";
}
inputEl.addEventListener("input", autoGrow);
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    composer.requestSubmit();
  }
});

// ---------------------------------------------------------------------------
// Voice mode controls
// ---------------------------------------------------------------------------

function enterVoiceMode() {
  if (sttMode === "none") return;
  voiceMode = true;
  userPausedListening = false;
  ensureAudio(); // user gesture: unlocks AudioContext for TTS playback
  setMachine("listening");
  if (sttMode === "server") startServerStt();
  else safeStartRecognition();
}

function exitVoiceMode() {
  voiceMode = false;
  userPausedListening = false;
  if (sttMode === "server") stopServerSttRecorder();
  if (recognizing) {
    try {
      recognition.stop();
    } catch {
      // fine
    }
  }
  interruptZenith("exit");
  setMachine("idle");
}

micBtn.addEventListener("click", () => {
  if (voiceMode) exitVoiceMode();
  else enterVoiceMode();
});

exitVoiceBtn.addEventListener("click", exitVoiceMode);

pauseListenBtn.addEventListener("click", () => {
  userPausedListening = true;
  if (sttMode === "server") stopServerSttRecorder();
  if (recognizing) {
    try {
      recognition.stop();
    } catch {}
  }
  liveTranscript.textContent = "";
  setMachine("idle");
});

resumeListenBtn.addEventListener("click", () => {
  userPausedListening = false;
  setMachine("listening");
  if (sttMode === "server") startServerStt();
  else safeStartRecognition();
});

stopSpeakBtn.addEventListener("click", () => interruptZenith("stop-button"));

// Companion mic (the clickable orb under the face): tap to talk hands-free,
// tap again to stop. Never auto-sends — only actual recognized speech is sent.
bigMic.addEventListener("click", () => {
  if (sttMode === "none") {
    captionText.classList.remove("you");
    captionText.textContent =
      "🎤 Speech recognition isn't available in this browser — type to ZENITH in Chat & transcript instead.";
    return;
  }
  if (voiceMode) exitVoiceMode();
  else enterVoiceMode();
});
stopSpeakReal.addEventListener("click", () => interruptZenith("stop-button"));

// ---------------------------------------------------------------------------
// Companion-stage controls: full-screen + transcript drawer
// ---------------------------------------------------------------------------

// Full-screen starts ONLY from this button — never automatically.
fullscreenBtn.addEventListener("click", () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.();
});
document.addEventListener("fullscreenchange", () => {
  fullscreenBtn.textContent = document.fullscreenElement
    ? "⛶ Exit full-screen"
    : "⛶ Full-screen";
});

// Transcript drawer: toggle from the header, close with the ✕.
transcriptBtn.addEventListener("click", () => {
  chatDrawer.hidden = !chatDrawer.hidden;
  if (!chatDrawer.hidden) inputEl.focus();
});
$("chatCloseBtn").addEventListener("click", () => {
  chatDrawer.hidden = true;
});

// ---------------------------------------------------------------------------
// Portrait motion — the artwork is a single static image, so this is
// APPROXIMATE audio-reactive movement scaled by how loud the live voice is,
// NOT lip-sync (no alternate mouth frames are layered over it).
// ElevenLabs and Kokoro both play through playSamples → the master analyser,
// so sampleAudioLevel() measures the audio that is actually playing. The
// system-voice fallback bypasses the AudioContext and can't be measured, so
// while it speaks we fall back to a gentle constant sway instead.
// ---------------------------------------------------------------------------

let portraitRAF = null;
let portraitT = 0;

function portraitTick() {
  portraitT += 0.016;
  // Base scale stays a hair above 1 so tiny translations never expose edges.
  let scale = 1.02;
  let tx = 0;
  let ty = 0;

  if (machine === "speaking") {
    const measured = sampleAudioLevel();
    const e = measured > 0.004 ? Math.min(1, measured * 12) : 0.12; // floor = system voice
    scale += e * 0.025;
    tx = Math.sin(portraitT * 11) * e * 1.7;
    ty = Math.cos(portraitT * 8) * e * 1.3;
  } else {
    // idle: slow breathing
    scale += Math.sin(portraitT * 0.9) * 0.006;
    ty = Math.sin(portraitT * 0.5) * 0.8;
  }

  portraitArt.style.transform =
    `translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px) scale(${scale.toFixed(4)})`;
  portraitRAF = requestAnimationFrame(portraitTick);
}

if (portraitArt) portraitTick();

// ---------------------------------------------------------------------------
// Memory panel
// ---------------------------------------------------------------------------

async function loadMemory() {
  try {
    const res = await fetch("/api/memory");
    const items = await res.json();
    memoryList.innerHTML = "";
    if (items.length === 0) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = "Nothing saved yet. Ask ZENITH to remember something, or add an entry above.";
      memoryList.appendChild(li);
      return;
    }
    for (const item of items) {
      const li = document.createElement("li");
      const body = document.createElement("div");
      body.className = "mem-body";
      const tags = document.createElement("div");
      tags.className = "mem-tags";
      tags.textContent = `${item.type} · ${item.date} · ${item.confidence}`;
      const text = document.createElement("div");
      text.className = "mem-text";
      text.textContent = item.text;
      body.appendChild(tags);
      body.appendChild(text);
      const actions = document.createElement("div");
      actions.className = "mem-actions";
      const edit = document.createElement("button");
      edit.className = "small ghost";
      edit.textContent = "Edit";
      edit.addEventListener("click", async () => {
        const next = window.prompt("Edit this memory:", item.text);
        if (next === null) return;
        const trimmed = next.trim();
        if (!trimmed) return;
        await fetch(`/api/memory/${item.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: trimmed }),
        });
        loadMemory();
      });
      const del = document.createElement("button");
      del.className = "small ghost";
      del.textContent = "Delete";
      del.addEventListener("click", async () => {
        if (!window.confirm("Forget this permanently?")) return;
        await fetch(`/api/memory/${item.id}`, { method: "DELETE" });
        loadMemory();
      });
      actions.appendChild(edit);
      actions.appendChild(del);
      li.appendChild(body);
      li.appendChild(actions);
      memoryList.appendChild(li);
    }
  } catch {
    memoryList.innerHTML = '<li class="empty">Could not load memory.</li>';
  }
}

$("memoryAdd").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("memoryText").value.trim();
  if (!text) return;
  await fetch("/api/memory", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, type: $("memoryType").value }),
  });
  $("memoryText").value = "";
  loadMemory();
});

// Panel management: one helper opens a panel and closes the others, so the
// header buttons, the ✕ buttons, and Escape all behave the same way. The
// side panels are full-height drawers; close buttons are sticky so they stay
// reachable while the panel scrolls on a narrow screen.

const SIDE_PANELS = [
  { panel: () => memoryPanel, btn: () => memoryBtn, onOpen: () => loadMemory() },
  { panel: () => profilePanel, btn: () => profileBtn, onOpen: () => loadProfilePanel() },
  { panel: () => schedulePanel, btn: () => scheduleBtn, onOpen: () => loadSchedulePanel() },
  { panel: () => settingsPanel, btn: () => settingsBtn, onOpen: () => loadSettingsPanel() },
];

function closeSidePanels(except) {
  for (const { panel, btn } of SIDE_PANELS) {
    if (panel() === except) continue;
    panel().hidden = true;
    btn().classList.remove("active");
  }
}

function openSidePanel(which) {
  const { panel, btn, onOpen } = which;
  const opening = panel().hidden;
  closeSidePanels(panel());
  panel().hidden = !opening; // toggle: clicking an open panel's header button closes it
  btn().classList.toggle("active", panel().hidden === false);
  if (!panel().hidden && onOpen) onOpen();
}

memoryBtn.addEventListener("click", () => openSidePanel(SIDE_PANELS[0]));
profileBtn.addEventListener("click", () => openSidePanel(SIDE_PANELS[1]));
scheduleBtn.addEventListener("click", () => openSidePanel(SIDE_PANELS[2]));
settingsBtn.addEventListener("click", () => openSidePanel(SIDE_PANELS[3]));

$("memoryCloseBtn").addEventListener("click", () => { memoryPanel.hidden = true; memoryBtn.classList.remove("active"); });
$("profileCloseBtn").addEventListener("click", () => { profilePanel.hidden = true; profileBtn.classList.remove("active"); });
$("scheduleCloseBtn").addEventListener("click", () => { schedulePanel.hidden = true; scheduleBtn.classList.remove("active"); });
$("settingsCloseBtn").addEventListener("click", () => { settingsPanel.hidden = true; settingsBtn.classList.remove("active"); });

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (e.target === document.body || e.target === null) { /* plain page */ }
  // Don't hijack Escape while the user is typing in a field — it should
  // still work normally for text areas, and closing a panel under a form
  // would be rude. Only close when focus isn't in an editor.
  const tag = (e.target && e.target.tagName) || "";
  if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT") {
    // In the chat drawer, Escape in the input also exits selection mode.
    if (e.target === inputEl && selectionMode) exitSelectionMode();
    return;
  }
  if (selectionMode) { exitSelectionMode(); return; }
  const open = SIDE_PANELS.find(({ panel }) => !panel().hidden);
  if (open) {
    open.panel().hidden = true;
    open.btn().classList.remove("active");
    return;
  }
  if (!chatDrawer.hidden) chatDrawer.hidden = true;
});

// ---------------------------------------------------------------------------
// Memory suggestion chip — appears when ZENITH proposes saving something.
// Declining dismisses it permanently; nothing is stored.
// ---------------------------------------------------------------------------

function showMemoryChip(suggestion) {
  memorySuggestion = suggestion;
  memoryChipText.textContent = suggestion;
  memoryChip.hidden = false;
}

$("memoryChipSave").addEventListener("click", async () => {
  if (!memorySuggestion) return;
  await fetch("/api/memory", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: memorySuggestion, type: "user-approved fact" }),
  });
  memoryChip.hidden = true;
  memorySuggestion = null;
});

$("memoryChipDrop").addEventListener("click", () => {
  memoryChip.hidden = true;
  memorySuggestion = null;
});

// ---------------------------------------------------------------------------
// Personal profile panel — editable copy of data/profile.md.
// Only relevant sections ride with a chat request (see the privacy note in
// the panel itself). Editing here edits the file; nothing upstream changes
// voice settings, memory, or reminders.
// ---------------------------------------------------------------------------

const profileTextEl = $("profileText");
const profileWarnEl = $("profileWarn");
let profileLoaded = "";
let profileSaving = false;

async function loadProfilePanel() {
  profileWarnEl.textContent = "";
  try {
    const res = await fetch("/api/profile");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "could not load profile");
    profileLoaded = data.text || "";
    profileTextEl.value = profileLoaded;
    profileTextEl.placeholder = "(empty — nothing here yet)";
    if (data.missing) profileWarnEl.textContent = data.hint || "";
  } catch (err) {
    profileTextEl.value = "";
    profileTextEl.placeholder = "Could not load the profile file.";
    profileWarnEl.textContent = String(err.message || err);
  }
}

$("profileSave").addEventListener("click", async () => {
  if (profileSaving) return;
  const next = profileTextEl.value;
  if (next.trim() === profileLoaded.trim()) {
    profileWarnEl.textContent = "Nothing changed — the file already matches this text.";
    return;
  }
  profileSaving = true;
  profileWarnEl.textContent = "Saving…";
  try {
    const res = await fetch("/api/profile", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: next }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "save failed");
    profileLoaded = next;
    profileWarnEl.textContent = `Saved (${data.chars} characters) to data/profile.md.`;
  } catch (err) {
    profileWarnEl.textContent = "Could not save: " + String(err.message || err);
  } finally {
    profileSaving = false;
  }
});

// ---------------------------------------------------------------------------
// Save selected conversation to memory
// ---------------------------------------------------------------------------

// Select messages in the chat drawer, review one editable note built from
// them, then save it through the same /api/memory every other memory uses —
// so it shows up in the Memory panel with normal Edit/Delete controls. Never
// automatic: nothing is saved until the Save button is pressed. No brain
// ElevenLabs call is involved anywhere on this path.

const selectBtn = $("selectBtn");
const selectBar = $("selectBar");
const selectCount = $("selectCount");
const selectEditor = $("selectEditor");
const selectNote = $("selectNote");
const selectType = $("selectType");
const selectWarn = $("selectWarn");

let selectionMode = false;

function enterSelectionMode() {
  if (streaming) return; // don't fight an in-flight reply
  selectionMode = true;
  messagesEl.classList.add("selecting");
  for (const div of messagesEl.querySelectorAll(".message")) {
    div.classList.remove("selected");
  }
  selectBar.hidden = false;
  selectEditor.hidden = true;
  updateSelectCount();
  selectBtn.classList.add("active");
}

function exitSelectionMode() {
  selectionMode = false;
  messagesEl.classList.remove("selecting");
  for (const div of messagesEl.querySelectorAll(".message")) {
    div.classList.remove("selected");
  }
  selectBar.hidden = true;
  selectEditor.hidden = true;
  selectBtn.classList.remove("active");
  selectWarn.textContent = "";
}

function selectedMessages() {
  return [...messagesEl.querySelectorAll(".message.selected")];
}

function updateSelectCount() {
  const n = selectedMessages().length;
  selectCount.textContent = `${n} selected`;
  $("selectReview").disabled = n === 0;
}

messagesEl.addEventListener("click", (e) => {
  if (!selectionMode) return;
  const div = e.target.closest(".message");
  if (!div || !messagesEl.contains(div)) return;
  div.classList.toggle("selected");
  updateSelectCount();
});

selectBtn.addEventListener("click", () => {
  if (selectionMode) exitSelectionMode();
  else enterSelectionMode();
});

$("selectCancel").addEventListener("click", exitSelectionMode);

$("selectReview").addEventListener("click", () => {
  const picked = selectedMessages();
  if (!picked.length) return;
  // Build the draft note from what was selected, role-labelled so context
  // survives; the user edits it before anything is saved.
  const parts = picked.map((div) => {
    const role = div.classList.contains("user") ? "You" : "ZENITH";
    const text = div.querySelector("p")?.textContent?.trim() || "";
    return `${role}: ${text}`;
  });
  selectNote.value = parts.join("\n\n");
  selectWarn.textContent = "";
  selectEditor.hidden = false;
  selectBar.hidden = true;
  selectNote.focus();
});

$("selectBack").addEventListener("click", () => {
  selectEditor.hidden = true;
  selectBar.hidden = false;
  updateSelectCount();
});

$("selectSave").addEventListener("click", async () => {
  const text = selectNote.value.trim();
  if (!text) {
    selectWarn.textContent = "The note is empty — add something, or cancel.";
    return;
  }
  $("selectSave").disabled = true;
  selectWarn.textContent = "Saving…";
  try {
    const res = await fetch("/api/memory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, type: selectType.value }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "save failed");
    exitSelectionMode();
    // Show the saved item in Memory, where it can be edited or deleted.
    closeSidePanels(null);
    memoryPanel.hidden = false;
    memoryBtn.classList.add("active");
    await loadMemory();
    selectWarn.textContent = "";
  } catch (err) {
    selectWarn.textContent = "Could not save: " + String(err.message || err);
  } finally {
    $("selectSave").disabled = false;
  }
});

// ---------------------------------------------------------------------------
// ElevenLabs banner dismiss
// ---------------------------------------------------------------------------

$("elBannerClose").addEventListener("click", hideElBanner);
$("elBannerRetry").addEventListener("click", retryElevenLabs);

// ---------------------------------------------------------------------------
// Reasoning effort — medium by default, high available for hard questions
// ---------------------------------------------------------------------------

async function loadEffort() {
  const box = $("effortBox");
  try {
    const res = await fetch("/api/effort");
    const data = await res.json();
    const brainName = data.model ? `${data.provider || "?"} / ${data.model}` : "unknown";
    box.innerHTML = `<b>Brain:</b> ${escapeHtml(brainName)}<br><b>Effort:</b> ${escapeHtml(data.variant)}`;
    paintEffortButtons(data.variant);
  } catch {
    box.textContent = "could not load effort setting";
  }
}

function paintEffortButtons(variant) {
  for (const btn of document.querySelectorAll("#effortRow button")) {
    const on = btn.dataset.variant === variant;
    btn.classList.toggle("active", on);
    btn.disabled = on;
  }
}

for (const btn of document.querySelectorAll("#effortRow button")) {
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      const res = await fetch("/api/effort", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variant: btn.dataset.variant }),
      });
      const data = await res.json();
      const brainName = data.model ? `${data.provider || "?"} / ${data.model}` : "unknown";
      $("effortBox").innerHTML = `<b>Brain:</b> ${escapeHtml(brainName)}<br><b>Effort:</b> ${escapeHtml(data.variant)}`;
      paintEffortButtons(data.variant);
    } catch {
      btn.disabled = false;
      $("effortBox").textContent = "switch failed — try again";
    }
  });
}

// ---------------------------------------------------------------------------
// Settings drawer — ElevenLabs voice selection, preview, persistence
// ---------------------------------------------------------------------------

async function loadSettingsPanel() {
  // Brain line comes from /api/status (called by checkStatus); refresh it here.
  await checkStatus();
  await loadEffort();
  const st = await refreshElConfig();

  elStatus.innerHTML = "Loading…";
  elVoices.innerHTML = "";
  try {
    if (!st || !st.configured) {
      elConfigured = false;
      elStatus.innerHTML =
        `<b>Not configured — using the system voice.</b><br><br>` +
        `ElevenLabs is an optional, separate service and needs its own account (free tier ≈ 10,000 characters/month).` +
        `<br><br>To enable it:<br>` +
        `1. Create an account at <b>elevenlabs.io</b> and copy your API key (Profile → API Keys).<br>` +
        `2. Open this file in Notepad:<br><code>C:\\Users\\HP\\Documents\\ZENITH\\secrets\\elevenlabs.key</code><br>` +
        `3. Paste the key, save the file, and restart ZENITH.<br><br>` +
        `Your key stays on this PC. Never paste it into chat or into the app.`;
      return;
    }
    elStatus.innerHTML = `Connected with key <code>${escapeHtml(st.keyHint)}</code>.<br>` +
      (st.voiceName ? `Current voice: <b>${escapeHtml(st.voiceName)}</b>` : `No voice selected yet — pick one below.`);
    elConfigured = !!st.voiceId;
    await loadVoiceList(st.voiceId);
  } catch (err) {
    elStatus.textContent = "Could not contact the server: " + (err.message || err);
  }
}

async function loadVoiceList(selectedId) {
  elVoices.innerHTML = "Loading voices…";
  try {
    const res = await fetch("/api/elevenlabs/voices");
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      elVoices.innerHTML = `<span class="note">${escapeHtml(data.error || "could not list voices")}</span>`;
      return;
    }
    const data = await res.json();
    elVoices.innerHTML = "";
    for (const v of data.voices.slice(0, 30)) {
      const li = document.createElement("div");
      li.className = "el-voice";
      const meta = document.createElement("div");
      meta.className = "el-meta";
      meta.innerHTML = `<b>${escapeHtml(v.name)}</b> <span class="note">${escapeHtml(v.category || "")} ${escapeHtml(Object.values(v.labels || {}).join(" "))}</span>`;
      const actions = document.createElement("div");
      actions.className = "mem-actions";
      const preview = document.createElement("button");
      preview.className = "small ghost";
      preview.textContent = "Preview";
      preview.addEventListener("click", () => {
        if (previewAudio) {
          previewAudio.pause();
          previewAudio = null;
        }
        previewAudio = new Audio(v.preview_url);
        previewAudio.play().catch(() => {
          statusText.textContent = "preview blocked";
        });
      });
      const use = document.createElement("button");
      use.className = "small";
      use.textContent = selectedId === v.voice_id ? "✓ Selected" : "Use this voice";
      if (selectedId === v.voice_id) use.disabled = true;
      use.addEventListener("click", async () => {
        await fetch("/api/settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ voiceId: v.voice_id, voiceName: v.name }),
        });
        elConfigured = true;
        elStatus.innerHTML = `Connected. Current voice: <b>${escapeHtml(v.name)}</b>`;
        loadVoiceList(v.voice_id);
      });
      actions.appendChild(preview);
      actions.appendChild(use);
      li.appendChild(meta);
      li.appendChild(actions);
      elVoices.appendChild(li);
    }
  } catch (err) {
    elVoices.innerHTML = `<span class="note">${escapeHtml(err.message || "could not list voices")}</span>`;
  }
}

// Settings and Reminders panels are opened through openSidePanel() above; the
// dedicated close buttons live next to that code.

// ---------------------------------------------------------------------------
// Reminders & check-ins (Stage 3)
// ---------------------------------------------------------------------------

// schedulePanel / scheduleBtn are declared at the top of the file with the
// other panel elements — the panel open/close handlers run before this line.
const reminderList = $("reminderList");
const reminderWarn = $("reminderWarn");
const checkinWarn = $("checkinWarn");

let currentReminders = [];

// The Reminders panel's open/close logic also lives with openSidePanel(); only
// its data loading stays here.

async function loadSchedulePanel() {
  await loadSchedule();
  // Highlight the fields the user should fill when nothing is set yet.
}

async function loadSchedule() {
  reminderWarn.textContent = "";
  checkinWarn.textContent = "";
  try {
    const res = await fetch("/api/schedule");
    const data = await res.json();
    currentReminders = data.reminders || [];
    renderReminders(currentReminders);
    renderCheckinStatus(data.checkins, data.checkinWarnings || []);
    const c = data.checkins || {};
    $("checkinEnabled").checked = !!c.enabled;
    $("checkinMorning").value = c.morning || "08:00";
    $("checkinEvening").value = c.evening || "21:00";
    if ((data.checkinWarnings || []).length) {
      checkinWarn.textContent = "Check-ins could not be scheduled: " + data.checkinWarnings[0];
    }
    return data;
  } catch (err) {
    reminderWarn.textContent = "could not load schedule: " + (err.message || err);
    return null;
  }
}

function renderCheckinStatus(c, warnings) {
  const box = $("checkinStatus");
  if (!box) return;
  if (!c) return;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const rows = [];
  for (const [label, key] of [["Morning", "morningSchedule"], ["Evening", "eveningSchedule"]]) {
    const s = c[key];
    if (!s) {
      rows.push(`<div>${label}: <b>off</b></div>`);
      continue;
    }
    const next = s.nextDueAt
      ? new Date(s.nextDueAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
      : "—";
    rows.push(`<div>${label}: <b>${s.status}</b> · next ${next} <span class="note">(${tz})</span></div>`);
  }
  rows.push(`<div class="mem-tags">Reminders and check-ins fire only while ZENITH is running — they do not buzz your phone and do not work when the app is closed.</div>`);
  box.innerHTML = rows.join("") + (warnings.length ? `<div class="mem-tags" style="color:var(--danger)">${escapeHtml(warnings[0])}</div>` : "");
}

function renderReminders(reminders) {
  reminderList.innerHTML = "";
  if (!reminders.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No reminders yet. Add one above.";
    reminderList.appendChild(li);
    return;
  }
  for (const r of reminders) {
    const li = document.createElement("li");
    const body = document.createElement("div");
    body.className = "mem-body";
    const tags = document.createElement("div");
    tags.className = "mem-tags";
    const next = r.nextDueAt ? new Date(r.nextDueAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
    tags.textContent = `${r.status} · next: ${next}${r.lastOutcome ? " · last: " + r.lastOutcome : ""}`;
    const text = document.createElement("div");
    text.className = "mem-text";
    text.textContent = `${r.name} (${r.whenText || ""})`;
    body.appendChild(tags);
    body.appendChild(text);
    const actions = document.createElement("div");
    actions.className = "mem-actions";
    const edit = document.createElement("button");
    edit.className = "small ghost";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => fillReminderForm(r));
    const toggle = document.createElement("button");
    toggle.className = "small ghost";
    toggle.textContent = r.status === "paused" ? "Resume" : "Pause";
    toggle.addEventListener("click", async () => {
      const action = r.status === "paused" ? "resume" : "pause";
      const res = await fetch(`/api/schedule/${r.id}/${action}`, { method: "PATCH" });
      if (res.ok) loadSchedule();
      else reminderWarn.textContent = (await res.json().catch(() => ({}))).error || "could not update";
    });
    const del = document.createElement("button");
    del.className = "small ghost";
    del.textContent = "Delete";
    del.addEventListener("click", async () => {
      if (!window.confirm(`Delete reminder "${r.name}"?`)) return;
      const res = await fetch(`/api/schedule/${r.id}`, { method: "DELETE" });
      if (res.ok) loadSchedule();
      else reminderWarn.textContent = (await res.json().catch(() => ({}))).error || "could not delete";
    });
    actions.appendChild(edit);
    actions.appendChild(toggle);
    actions.appendChild(del);
    li.appendChild(body);
    li.appendChild(actions);
    reminderList.appendChild(li);
  }
}

// Edit: the API has no partial update, so "edit" = create the new version, then
// delete the old one — and only after the new one exists.
let editingId = null;

function fillReminderForm(r) {
  editingId = r.id;
  $("reminderName").value = r.name;
  const w = r.when || {};
  if (w.type === "cron") {
    const parts = String(w.cron || "").split(/\s+/);
    const m = String(parts[0] || "0").padStart(2, "0");
    const h = String(parts[1] || "8").padStart(2, "0");
    $("reminderKind").value = parts[4] === "*" ? "daily" : "weekly";
    $("reminderTime").value = `${h}:${m}`;
    $("reminderDate").value = "";
  } else if (w.type === "at") {
    const d = new Date(w.at);
    $("reminderKind").value = "once";
    const p = (n) => String(n).padStart(2, "0");
    $("reminderDate").value = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    $("reminderTime").value = `${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  $("reminderSubmitBtn").textContent = "Save changes";
  $("reminderCancelEditBtn").hidden = false;
  $("reminderName").focus();
}

function resetReminderForm() {
  editingId = null;
  $("reminderName").value = "";
  $("reminderTime").value = "";
  $("reminderDate").value = "";
  $("reminderSubmitBtn").textContent = "Add reminder";
  $("reminderCancelEditBtn").hidden = true;
}

$("reminderCancelEditBtn").addEventListener("click", resetReminderForm);

$("reminderForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("reminderName").value.trim();
  const kind = $("reminderKind").value;
  const time = $("reminderTime").value || "08:00";
  const date = $("reminderDate").value;
  reminderWarn.textContent = "";
  if (!name) return (reminderWarn.textContent = "Give the reminder a name.");
  if (kind === "once" && !date) return (reminderWarn.textContent = "One-off reminders need a date.");
  const res = await fetch("/api/schedule", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, kind, time, date }),
  });
  if (res.ok) {
    if (editingId) {
      // New version exists now — remove the old one.
      await fetch(`/api/schedule/${editingId}`, { method: "DELETE" }).catch(() => {});
      resetReminderForm();
    } else {
      $("reminderName").value = "";
      $("reminderTime").value = "";
      $("reminderDate").value = "";
    }
    loadSchedule();
  } else {
    reminderWarn.textContent = (await res.json().catch(() => ({}))).error || "could not add";
  }
});

$("checkinForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const enabled = $("checkinEnabled").checked;
  await fetch("/api/settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      checkinEnabled: enabled,
      checkinMorning: $("checkinMorning").value,
      checkinEvening: $("checkinEvening").value,
    }),
  });
  loadSchedule();
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

if (!SpeechRecognition && !navigator.mediaDevices?.getUserMedia) {
  bigMic.disabled = true;
  bigMic.title = "Speech recognition isn't available in this browser";
}

(async () => {
  try {
    await resolveSttMode();
    if (sttMode === "none" && bigMic && !bigMic.disabled) {
      bigMic.disabled = true;
      bigMic.title = "Speech recognition isn't available in this browser";
    }
  } catch {}
})();

loadHistory();
checkStatus();
refreshElConfig();
refreshEngine();
setInterval(checkStatus, 30_000);
setInterval(refreshElConfig, 30_000);
setInterval(refreshEngine, 60_000);
setInterval(watchForScheduled, 15_000);
reconcileHistory(); // sync the pointer right after load, before any turn
armAudioUnlock(); // browsers need a gesture before any sound can play
inputEl.focus();
