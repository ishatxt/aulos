/**
 * Offline WAV renderer.
 *
 * The browser renders the complete composition — the same synthesized voices,
 * note map and reverb topology used live — into an OfflineAudioContext, then
 * encodes a standard 16-bit stereo WAV. No server, conversion service or paid
 * codec is involved.
 */

import { createMixGraph, createVoice } from "./audio-engine.js";

const SAMPLE_RATE = 44_100;
const MAX_DURATION_SECONDS = 15 * 60;
const REVERB_TAIL_SECONDS = 3.1;
const YIELD_EVERY_FRAMES = 220_500;

class WavExportError extends Error {
  constructor(message, code = "export-failed") {
    super(message);
    this.name = "WavExportError";
    this.code = code;
  }
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export function estimateWavDuration(composition) {
  const tempo = Number(composition?.settings?.tempo) || 84;
  const beats = Number(composition?.beatCount) || 0;
  return (beats * 60) / tempo;
}

function writeString(view, offset, value) {
  for (let i = 0; i < value.length; i += 1) {
    view.setUint8(offset + i, value.charCodeAt(i));
  }
}

function analysePeak(audioBuffer) {
  let peak = 0;
  for (let channel = 0; channel < audioBuffer.numberOfChannels; channel += 1) {
    const data = audioBuffer.getChannelData(channel);
    for (let i = 0; i < data.length; i += 1) {
      const magnitude = Math.abs(data[i]);
      if (magnitude > peak) peak = magnitude;
    }
  }
  return peak;
}

/**
 * Encode an AudioBuffer to a RIFF/WAVE file. The writer yields periodically so
 * a long composition does not completely lock the browser UI.
 */
export async function encodeAudioBufferToWav(audioBuffer, { onProgress = () => {} } = {}) {
  const channels = Math.min(2, audioBuffer.numberOfChannels);
  const frames = audioBuffer.length;
  const bytesPerSample = 2;
  const dataSize = frames * channels * bytesPerSample;
  const totalSize = 44 + dataSize;
  const output = new ArrayBuffer(totalSize);
  const view = new DataView(output);

  writeString(view, 0, "RIFF");
  view.setUint32(4, totalSize - 8, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, audioBuffer.sampleRate, true);
  view.setUint32(28, audioBuffer.sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, "data");
  view.setUint32(40, dataSize, true);

  onProgress({ stage: "encoding", progress: 0 });
  const peak = analysePeak(audioBuffer);
  // Give the WAV healthy, consistent level while preserving dynamics. This is
  // independent of the monitoring volume in the studio.
  const normaliseGain = peak > 0.001 ? Math.min(3.5, 0.92 / peak) : 1;
  const channelData = [];
  for (let channel = 0; channel < channels; channel += 1) {
    channelData.push(audioBuffer.getChannelData(channel));
  }

  let offset = 44;
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const sample = Math.max(-1, Math.min(1, (channelData[channel][frame] ?? 0) * normaliseGain));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
    if (frame > 0 && frame % YIELD_EVERY_FRAMES === 0) {
      onProgress({ stage: "encoding", progress: frame / frames });
      await tick();
    }
  }
  onProgress({ stage: "encoding", progress: 1 });

  return {
    blob: new Blob([output], { type: "audio/wav" }),
    bytes: totalSize,
    peak,
    normaliseGain,
    sampleRate: audioBuffer.sampleRate,
    durationSec: frames / audioBuffer.sampleRate,
  };
}

/**
 * Render the composition with OfflineAudioContext. Since browsers do not expose
 * reliable render progress, callers receive meaningful stages: preparing,
 * scheduling, rendering and encoding.
 */
export async function renderCompositionToWav(composition, { onProgress = () => {} } = {}) {
  if (!composition?.events?.length) {
    throw new WavExportError("There are no moves to render yet.", "empty");
  }
  if (typeof OfflineAudioContext === "undefined") {
    throw new WavExportError(
      "This browser does not support offline audio rendering. Please try a recent Chromium-based browser.",
      "unsupported",
    );
  }

  const durationSec = estimateWavDuration(composition) + REVERB_TAIL_SECONDS;
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new WavExportError("The composition duration is invalid.", "invalid-duration");
  }
  if (durationSec > MAX_DURATION_SECONDS) {
    throw new WavExportError(
      `This composition would be ${Math.ceil(durationSec / 60)} minutes long. Browser WAV export is limited to ${MAX_DURATION_SECONDS / 60} minutes per file.`,
      "too-long",
    );
  }

  const frames = Math.ceil(durationSec * SAMPLE_RATE);
  let context;
  try {
    context = new OfflineAudioContext(2, frames, SAMPLE_RATE);
  } catch (error) {
    throw new WavExportError(`Could not create the offline audio context: ${error.message}`, "context");
  }

  onProgress({ stage: "preparing", progress: 0.02 });
  const settings = composition.settings;
  const graph = createMixGraph(context, settings, {
    withAnalyser: false,
    // The export is a deliverable, so it should not be silent just because the
    // monitor volume was turned down. Reverb and instrument balance still match.
    useUserVolume: false,
    masterLevel: 1,
    wetScale: 0.72,
  });

  const spb = 60 / (Number(settings.tempo) || 84);
  let noteCount = 0;
  for (const event of composition.events) {
    for (const note of event.notes) {
      const when = (event.startBeat + note.offset) * spb;
      const duration = note.duration * spb;
      createVoice(context, graph, note, when, duration, settings);
      noteCount += 1;
    }
    if (noteCount % 200 === 0) {
      onProgress({ stage: "scheduling", progress: 0.04 });
      await tick();
    }
  }
  onProgress({ stage: "rendering", progress: 0.06 });

  let rendered;
  try {
    rendered = await context.startRendering();
  } catch (error) {
    throw new WavExportError(`Offline rendering failed: ${error.message}`, "render");
  }

  onProgress({ stage: "encoding", progress: 0.08 });
  const encoded = await encodeAudioBufferToWav(rendered, {
    onProgress: (update) => {
      onProgress({
        stage: update.stage,
        progress: 0.08 + update.progress * 0.92,
      });
    },
  });

  return {
    ...encoded,
    noteCount,
    compositionId: composition.id,
    title: composition.title,
    durationSec: rendered.duration,
  };
}

export { WavExportError, MAX_DURATION_SECONDS };
