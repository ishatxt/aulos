/**
 * Browser audio engine for CHESSOUND.
 *
 * All instruments are synthesized locally with the Web Audio API — there are no
 * samples, API keys or network requests. The same voice-building function is
 * reused by realtime playback and the offline WAV exporter in wav-export.js.
 */

import { VOICE_PRESETS } from "./config.js";

const REVERB_SECONDS = 2.7;
const SCHEDULE_AHEAD = 0.035;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** Stable pseudo-noise for the impulse response: same build, same reverb bed. */
function makeSeededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A generated stereo impulse response avoids external reverb assets. Damping
 * the tail and decorrelating left/right creates a room without metallic noise.
 */
export function createReverbImpulse(context, seconds = REVERB_SECONDS) {
  const length = Math.max(1, Math.round(context.sampleRate * seconds));
  const impulse = context.createBuffer(2, length, context.sampleRate);
  for (let channel = 0; channel < 2; channel += 1) {
    const data = impulse.getChannelData(channel);
    const random = makeSeededRandom(channel === 0 ? 0xa17e5 : 0x3c6ef);
    let smoothed = 0;
    for (let i = 0; i < length; i += 1) {
      const progress = i / length;
      const early = progress < 0.08 ? 0.35 : 1;
      const decay = (1 - progress) ** 2.7 * early;
      smoothed = smoothed * 0.72 + (random() * 2 - 1) * 0.28;
      data[i] = smoothed * decay * 0.52;
    }
  }
  return impulse;
}

/**
 * Build the shared dry/wet mix graph for both realtime and offline contexts.
 * Returning the destination buses lets the note scheduler reuse this exactly.
 */
export function createMixGraph(context, settings, options = {}) {
  const master = context.createGain();
  const dry = context.createGain();
  const reverbInput = context.createGain();
  const convolver = context.createConvolver();
  const wet = context.createGain();
  const compressor = context.createDynamicsCompressor();

  const masterLevel = options.masterLevel ?? 0.9;
  const volume = settings.masterVolume ?? 0.72;
  master.gain.value = options.useUserVolume === false ? masterLevel : masterLevel * volume ** 1.25;
  dry.gain.value = 0.88;
  wet.gain.value = clamp(settings.reverb ?? 0.3, 0, 1) * (options.wetScale ?? 0.72);
  compressor.threshold.value = -20;
  compressor.knee.value = 22;
  compressor.ratio.value = 3.6;
  compressor.attack.value = 0.004;
  compressor.release.value = 0.28;

  convolver.buffer = createReverbImpulse(context);
  dry.connect(master);
  reverbInput.connect(convolver);
  convolver.connect(wet);
  wet.connect(master);
  master.connect(compressor);

  let analyser = null;
  if (options.withAnalyser) {
    analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.78;
    compressor.connect(analyser);
    analyser.connect(context.destination);
  } else {
    compressor.connect(context.destination);
  }

  return { master, dry, reverbInput, convolver, wet, compressor, analyser };
}

/**
 * Schedule one synthesized note into any BaseAudioContext.
 * Returns a cancellable handle for realtime notes and null for offline notes.
 */
export function createVoice(context, graph, note, when, durationSec, settings = {}) {
  const voice = VOICE_PRESETS[note.voiceId] ?? VOICE_PRESETS.ivory;
  const start = Math.max(0, when);
  const duration = Math.max(0.08, durationSec);
  const intensity = clamp(settings.instrumentIntensity ?? 0.6, 0, 1);
  const mode = settings.mode ?? "classical";
  const role = note.role ?? "base";

  const primary = context.createOscillator();
  const overtone = context.createOscillator();
  const filter = context.createBiquadFilter();
  const envelope = context.createGain();
  const panner = context.createStereoPanner();
  const overtoneGain = context.createGain();

  primary.type = voice.synth.waveform;
  primary.frequency.setValueAtTime(Math.max(20, note.frequency), start);
  const colourDetune = note.color === "b" ? 2 : -2;
  primary.detune.setValueAtTime(voice.synth.detune + colourDetune, start);

  overtone.type = voice.synth.overtone;
  overtone.frequency.setValueAtTime(
    clamp(note.frequency * voice.synth.overtoneRatio, 20, context.sampleRate / 2 - 80),
    start,
  );
  overtone.detune.setValueAtTime(-voice.synth.detune + colourDetune, start);
  overtoneGain.gain.value = voice.synth.overtoneGain * (0.55 + intensity * 0.65);

  filter.type = "lowpass";
  filter.Q.value = 0.55;
  const cutoffBase = voice.synth.filter * (0.68 + intensity * 0.56);
  const cutoff = clamp(cutoffBase, 240, context.sampleRate / 2 - 200);
  filter.frequency.setValueAtTime(cutoff, start);
  // A gentle closing filter makes plucks feel physical without changing pitch.
  filter.frequency.exponentialRampToValueAtTime(
    Math.max(220, cutoff * 0.46),
    start + Math.max(0.18, duration + 0.15),
  );

  const velocity = clamp(note.velocity ?? 0.6, 0.02, 1);
  const roleBoost = role === "cadence" ? 1.12 : role === "tension" ? 0.9 : 1;
  const peak = Math.min(0.34, (0.085 + velocity * 0.2) * roleBoost);
  const attack = Math.min(voice.synth.attack * (mode === "ambient" ? 1.5 : 1), duration * 0.32);
  const decay = Math.min(voice.synth.decay, duration * 0.45);
  const sustain = Math.max(0.08, voice.synth.sustain);
  const release = clamp(
    voice.synth.release * (0.7 + (settings.noteLength ?? 1) * 0.25),
    0.12,
    3.2,
  );
  const noteEnd = start + duration;
  const attackEnd = start + Math.max(0.002, attack);
  const decayEnd = Math.min(attackEnd + decay, noteEnd);

  envelope.gain.setValueAtTime(0.0001, start);
  envelope.gain.linearRampToValueAtTime(peak, attackEnd);
  envelope.gain.linearRampToValueAtTime(Math.max(0.0002, peak * sustain), decayEnd);
  if (decayEnd < noteEnd) {
    envelope.gain.setValueAtTime(Math.max(0.0002, peak * sustain), noteEnd);
  }
  envelope.gain.exponentialRampToValueAtTime(0.0001, noteEnd + release);

  // Keep the two voices centred as a unit, then offset by musical colour/voice.
  const pan = clamp((voice.pan ?? 0) + (note.color === "b" ? 0.05 : -0.05), -0.8, 0.8);
  panner.pan.value = pan;

  primary.connect(filter);
  overtone.connect(overtoneGain);
  overtoneGain.connect(filter);
  filter.connect(envelope);
  envelope.connect(panner);
  panner.connect(graph.dry);
  panner.connect(graph.reverbInput);

  primary.start(start);
  overtone.start(start);
  const stopAt = noteEnd + release + 0.05;
  primary.stop(stopAt);
  overtone.stop(stopAt);

  let ended = false;
  let cancelled = false;
  const nodes = [primary, overtone, overtoneGain, filter, envelope, panner];

  const disconnectAll = () => {
    if (ended) return;
    ended = true;
    for (const node of nodes) {
      try {
        node.disconnect();
      } catch {
        // Nodes can already be disconnected after an immediate cancellation.
      }
    }
  };
  primary.onended = disconnectAll;

  return {
    note,
    start,
    stopAt,
    get ended() {
      return ended;
    },
    cancel(fadeSeconds = 0.025) {
      if (ended || cancelled) return;
      cancelled = true;
      const now = context.currentTime;
      try {
        envelope.gain.cancelScheduledValues(now);
        if (typeof envelope.gain.cancelAndHoldAtTime === "function") {
          envelope.gain.cancelAndHoldAtTime(now);
        }
        envelope.gain.setTargetAtTime(0.0001, now, Math.max(0.004, fadeSeconds / 3));
        const stopNow = Math.max(now + fadeSeconds + 0.01, start);
        primary.stop(stopNow);
        overtone.stop(stopNow);
      } catch {
        // A source that has already stopped cannot be stopped again.
      }
      setTimeout(disconnectAll, (fadeSeconds + 0.08) * 1000);
    },
  };
}

export class AudioEngine {
  constructor() {
    this.context = null;
    this.graph = null;
    this.settings = null;
    this.stateListeners = new Set();
    this.handles = new Set();
    this.analyserData = null;
    this.waveformData = null;
    this._onContextState = () => {
      this._notifyState();
    };
  }

  get supported() {
    return typeof window !== "undefined" && Boolean(window.AudioContext || window.webkitAudioContext);
  }

  get ready() {
    return Boolean(this.context && this.graph);
  }

  get state() {
    return this.context?.state ?? "uninitialized";
  }

  subscribeState(listener) {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  _notifyState() {
    this.stateListeners.forEach((listener) => {
      try {
        listener(this.state);
      } catch (error) {
        console.error("Audio state listener failed", error);
      }
    });
  }

  /**
   * Must be called from a user gesture the first time. Subsequent calls simply
   * resume a suspended context, which is safe and idempotent.
   */
  async enable(settings) {
    if (!this.supported) {
      throw new Error("This browser does not support the Web Audio API.");
    }
    if (settings) this.settings = settings;

    if (!this.context) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      this.context = new AudioContextClass({ latencyHint: "interactive" });
      this.graph = createMixGraph(this.context, settings ?? {}, {
        withAnalyser: true,
        useUserVolume: true,
        masterLevel: 1,
      });
      this.analyserData = new Uint8Array(this.graph.analyser.frequencyBinCount);
      this.waveformData = new Uint8Array(this.graph.analyser.fftSize);
      this.context.addEventListener("statechange", this._onContextState);
      this._notifyState();
    }

    if (this.context.state !== "running") {
      await this.context.resume();
    }
    if (settings) this.updateSettings(settings);
    return this.state;
  }

  updateSettings(settings) {
    this.settings = settings;
    if (!this.context || !this.graph) return;
    const now = this.context.currentTime;
    const volume = clamp(settings.masterVolume ?? 0.72, 0, 1) ** 1.25;
    this.graph.master.gain.cancelScheduledValues(now);
    this.graph.master.gain.setTargetAtTime(volume, now, 0.035);
    this.graph.wet.gain.cancelScheduledValues(now);
    this.graph.wet.gain.setTargetAtTime(
      clamp(settings.reverb ?? 0.3, 0, 1) * 0.72,
      now,
      0.05,
    );
  }

  /**
   * Schedule all notes of one musical event at a given beat tempo.
   * Used for live moves and by the composition player via scheduleNote.
   */
  playEvent(event, bpm, settings = this.settings) {
    if (!this.ready || this.state !== "running" || !event?.notes?.length) return [];
    const spb = 60 / clamp(Number(bpm) || 84, 20, 300);
    const baseTime = this.context.currentTime + SCHEDULE_AHEAD;
    const handles = [];
    for (const note of event.notes) {
      const when = baseTime + note.offset * spb;
      handles.push(this.scheduleNote(note, when, note.duration * spb, settings));
    }
    return handles;
  }

  scheduleNote(note, when, durationSec, settings = this.settings) {
    if (!this.ready) return null;
    const handle = createVoice(this.context, this.graph, note, when, durationSec, settings);
    this.handles.add(handle);
    const originalEnd = handle.stopAt;
    // Release references after the note has certainly finished.
    const delay = Math.max(0, (originalEnd - this.context.currentTime) * 1000 + 250);
    setTimeout(() => {
      this.handles.delete(handle);
    }, delay);
    return handle;
  }

  getAnalyserData() {
    if (!this.ready) return { frequency: null, waveform: null };
    this.graph.analyser.getByteFrequencyData(this.analyserData);
    this.graph.analyser.getByteTimeDomainData(this.waveformData);
    return {
      frequency: this.analyserData,
      waveform: this.waveformData,
    };
  }

  stopAll(fadeSeconds = 0.04) {
    for (const handle of this.handles) {
      try {
        handle.cancel(fadeSeconds);
      } catch {
        // Cancellation is best-effort during page teardown.
      }
    }
    this.handles.clear();
  }

  async suspend() {
    if (!this.context) return;
    if (this.context.state === "running") await this.context.suspend();
  }

  async resume() {
    if (!this.context) return;
    if (this.context.state !== "running") await this.context.resume();
  }

  destroy() {
    this.stopAll(0.01);
    if (this.context) {
      this.context.removeEventListener("statechange", this._onContextState);
      this.context.close().catch(() => {});
    }
    this.context = null;
    this.graph = null;
    this.stateListeners.clear();
  }
}
