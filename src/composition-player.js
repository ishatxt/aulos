/**
 * CompositionPlayer — a cancellable, beat-based look-ahead scheduler.
 *
 * Why beats instead of pre-scheduled seconds? Tempo can change mid-playback and
 * seeking must remain exact. Notes are scheduled only a short horizon ahead and
 * every realtime handle is tracked, so pause, seek and tempo changes can cancel
 * pending audio without duplicate notes.
 *
 * UI animation reads a snapshot derived from AudioContext.currentTime, keeping
 * the chessboard, piano, timeline and audible music on the same clock.
 */

import { eventIndexAtBeat } from "./music-mapping.js";

const LOOKAHEAD_SECONDS = 0.32;
const TIMER_INTERVAL_MS = 40;
const EPSILON = 0.0005;

function firstNoteAtOrAfter(notes, beat) {
  let low = 0;
  let high = notes.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (notes[mid].onsetBeat < beat - EPSILON) low = mid + 1;
    else high = mid;
  }
  return low;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export class CompositionPlayer {
  constructor({ audio, onUpdate = () => {} }) {
    this.audio = audio;
    this.onUpdate = onUpdate;
    this.composition = null;
    this.events = [];
    this.flatNotes = [];
    this.totalBeats = 0;
    this.bpm = 84;
    this.playing = false;
    this.frozenBeat = 0;
    this.anchorBeat = 0;
    this.anchorCtxTime = 0;
    this.noteCursor = 0;
    this.timer = null;
    this.raf = null;
    this.handles = new Set();
    this.generation = 0;
    this.lastState = "uninitialized";
    this.interrupted = false;

    this._unsubscribeAudio = this.audio.subscribeState((state) => {
      this.lastState = state;
      // A suspended/closed context cannot advance. Preserve the exact beat and
      // let the UI ask the user to resume audio before continuing.
      if (this.playing && state !== "running") {
        this.interrupted = true;
        this.pause();
      }
    });

    this._onVisibilityChange = () => {
      if (document.hidden && this.playing) {
        this.interrupted = true;
        this.pause();
      }
    };
    document.addEventListener("visibilitychange", this._onVisibilityChange);
  }

  get secondsPerBeat() {
    return 60 / clamp(this.bpm, 20, 300);
  }

  get durationSeconds() {
    return this.totalBeats * this.secondsPerBeat;
  }

  get currentBeat() {
    if (!this.playing || !this.audio.ready) return this.frozenBeat;
    const elapsed = Math.max(0, this.audio.context.currentTime - this.anchorCtxTime);
    return clamp(this.anchorBeat + elapsed * (this.bpm / 60), 0, this.totalBeats);
  }

  get currentEventIndex() {
    if (!this.events.length) return -1;
    return eventIndexAtBeat(this.events, this.currentBeat);
  }

  /**
   * Replace the loaded composition. Any existing sound is cancelled first; the
   * transport returns to the beginning. UI changes during playback should call
   * setTempo for tempo-only edits or reload explicitly.
   */
  load(composition, { emit = true } = {}) {
    this._clearTransport();
    this._cancelHandles();
    this.composition = composition ?? null;
    this.events = composition?.events ?? [];
    this.bpm = clamp(Number(composition?.settings?.tempo) || 84, 20, 300);
    this.totalBeats = Number(composition?.beatCount) || 0;
    this.frozenBeat = 0;
    this.noteCursor = 0;
    this.interrupted = false;
    this.flatNotes = this.events
      .flatMap((event, eventIndex) =>
        event.notes.map((note) => ({
          ...note,
          eventIndex,
          onsetBeat: event.startBeat + note.offset,
          endBeat: event.startBeat + note.offset + note.duration,
        })),
      )
      .sort((a, b) => a.onsetBeat - b.onsetBeat || a.midi - b.midi);
    if (emit) this._emit();
  }

  /**
   * Start or resume from the preserved beat. At the very end, Play restarts.
   * Returns false if audio is unavailable or there is nothing to play.
   */
  async play() {
    if (!this.events.length || this.totalBeats <= 0) return false;
    if (!this.audio.ready) return false;
    if (this.playing) return true;
    await this.audio.resume();
    if (!this.audio.ready || this.audio.context.state !== "running") return false;

    const atEnd = this.frozenBeat >= this.totalBeats - 0.01;
    const startBeat = atEnd ? 0 : clamp(this.frozenBeat, 0, this.totalBeats);
    this.interrupted = false;
    this._beginAt(startBeat);
    return true;
  }

  _beginAt(startBeat) {
    this._cancelHandles();
    this.playing = true;
    this.anchorBeat = startBeat;
    this.anchorCtxTime = this.audio.context.currentTime + 0.055;
    this.frozenBeat = startBeat;
    this.noteCursor = firstNoteAtOrAfter(this.flatNotes, startBeat);
    this._startTransport();
    this._scheduleAhead();
    this._emit();
  }

  pause() {
    if (!this.playing) return;
    const beat = this.currentBeat;
    this.playing = false;
    this.frozenBeat = clamp(beat, 0, this.totalBeats);
    this._clearTransport();
    this._cancelHandles();
    this._emit();
  }

  stop() {
    const hadState = this.playing || this.frozenBeat > 0;
    this.playing = false;
    this._clearTransport();
    this._cancelHandles();
    this.frozenBeat = 0;
    this.noteCursor = 0;
    this.interrupted = false;
    if (hadState || this.composition) this._emit();
  }

  /**
   * Seek to an exact beat. When called during playback, audio continues from a
   * freshly reset schedule anchored at the destination.
   */
  seek(beat, { keepPlaying = this.playing } = {}) {
    const target = clamp(Number(beat) || 0, 0, this.totalBeats);
    const wasPlaying = this.playing;
    this.playing = false;
    this._clearTransport();
    this._cancelHandles();
    this.frozenBeat = target;
    this.noteCursor = firstNoteAtOrAfter(this.flatNotes, target);
    this.interrupted = false;

    if (wasPlaying && keepPlaying && target < this.totalBeats - 0.01) {
      this._beginAt(target);
    } else {
      this._emit();
    }
  }

  nextEvent() {
    if (!this.events.length) return;
    const current = Math.max(0, this.currentEventIndex);
    const next = Math.min(this.events.length - 1, current + 1);
    this.seek(this.events[next].startBeat, { keepPlaying: this.playing });
  }

  previousEvent() {
    if (!this.events.length) return;
    const current = Math.max(0, this.currentEventIndex);
    const event = this.events[current];
    const atEventStart = this.currentBeat <= event.startBeat + 0.28;
    const targetIndex = atEventStart ? Math.max(0, current - 1) : current;
    this.seek(this.events[targetIndex].startBeat, { keepPlaying: this.playing });
  }

  seekToEvent(index, { keepPlaying = this.playing } = {}) {
    if (!this.events.length) return;
    const safeIndex = clamp(Math.round(index), 0, this.events.length - 1);
    this.seek(this.events[safeIndex].startBeat, { keepPlaying });
  }

  /**
   * Change tempo without changing the note mapping. If a composition is
   * playing, its current beat is preserved and future notes are rescheduled.
   */
  setTempo(bpm) {
    const next = clamp(Number(bpm) || this.bpm, 36, 180);
    if (Math.abs(next - this.bpm) < 0.01) {
      this._emit();
      return;
    }
    const wasPlaying = this.playing;
    const beat = this._beatValue();
    this.playing = false;
    this._clearTransport();
    this._cancelHandles();
    this.bpm = next;
    this.frozenBeat = beat;
    this.noteCursor = firstNoteAtOrAfter(this.flatNotes, beat);

    if (wasPlaying && beat < this.totalBeats - 0.01) {
      this._beginAt(beat);
    } else {
      this._emit();
    }
  }

  _beatValue() {
    if (!this.playing) return this.frozenBeat;
    return this.currentBeat;
  }

  _startTransport() {
    this._clearTransport();
    this._startTimer();
    this._startAnimation();
    this.lastState = this.audio.state;
  }

  _startTimer() {
    this.timer = window.setInterval(() => {
      this._scheduleAhead();
      if (this.playing && this.currentBeat >= this.totalBeats - 0.005) this._finish();
    }, TIMER_INTERVAL_MS);
  }

  _startAnimation() {
    const frame = () => {
      if (!this.playing) return;
      this._emit();
      if (this.playing) this.raf = window.requestAnimationFrame(frame);
    };
    this.raf = window.requestAnimationFrame(frame);
  }

  _clearTransport() {
    if (this.timer) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    if (this.raf) {
      window.cancelAnimationFrame(this.raf);
      this.raf = null;
    }
  }

  _scheduleAhead() {
    if (!this.playing || !this.audio.ready || this.audio.context.state !== "running") return;
    const spb = this.secondsPerBeat;
    const instant = this.audio.context.currentTime;
    const current = this.currentBeat;
    if (current >= this.totalBeats - 0.005) {
      this._finish();
      return;
    }

    const horizonBeat = current + LOOKAHEAD_SECONDS / spb;
    while (this.noteCursor < this.flatNotes.length) {
      const item = this.flatNotes[this.noteCursor];
      if (item.onsetBeat > horizonBeat) break;
      const when = this.anchorCtxTime + (item.onsetBeat - this.anchorBeat) * spb;
      // Skip a sliver that is already in the past instead of stacking it onto
      // the present; this only occurs after throttled background timers.
      if (when >= instant - 0.03) {
        const handle = this.audio.scheduleNote(
          item,
          Math.max(instant + 0.006, when),
          item.duration * spb,
          this.composition.settings,
        );
        if (handle) this.handles.add(handle);
      }
      this.noteCursor += 1;
    }
  }

  _finish() {
    if (!this.playing) return;
    this.playing = false;
    this.frozenBeat = this.totalBeats;
    this._clearTransport();
    this._emit();
  }

  _cancelHandles() {
    for (const handle of this.handles) {
      try {
        handle.cancel(0.03);
      } catch {
        // Handles may have completed between ticks.
      }
    }
    this.handles.clear();
  }

  _activeNotesAt(beat) {
    if (!this.flatNotes.length) return [];
    const active = [];
    for (const item of this.flatNotes) {
      if (item.onsetBeat > beat + EPSILON) break;
      if (item.endBeat >= beat - EPSILON) active.push(item);
    }
    return active;
  }

  getSnapshot() {
    const beat = this.playing ? this.currentBeat : this.frozenBeat;
    const safeBeat = clamp(beat, 0, this.totalBeats);
    const eventIndex = this.events.length
      ? eventIndexAtBeat(this.events, Math.min(safeBeat, Math.max(0, this.totalBeats - 0.0001)))
      : -1;
    const activeNotes = this._activeNotesAt(safeBeat);
    const durationSec = this.durationSeconds;
    return {
      compositionId: this.composition?.id ?? null,
      playing: this.playing,
      interrupted: this.interrupted,
      ended:
        !this.playing &&
        this.totalBeats > 0 &&
        safeBeat >= this.totalBeats - 0.005,
      beat: Number(safeBeat.toFixed(4)),
      totalBeats: this.totalBeats,
      bpm: this.bpm,
      secondsPerBeat: Number(this.secondsPerBeat.toFixed(5)),
      elapsedSec: Number((safeBeat * this.secondsPerBeat).toFixed(2)),
      durationSec: Number(durationSec.toFixed(2)),
      progress: this.totalBeats > 0 ? Math.min(1, safeBeat / this.totalBeats) : 0,
      eventIndex,
      currentEvent: this.events[eventIndex] ?? null,
      activeNotes,
      audioState: this.audio.state,
      hasComposition: Boolean(this.composition),
    };
  }

  _emit() {
    try {
      this.onUpdate(this.getSnapshot());
    } catch (error) {
      console.error("Composition UI update failed", error);
    }
  }

  destroy() {
    this.playing = false;
    this._clearTransport();
    this._cancelHandles();
    this._unsubscribeAudio?.();
    document.removeEventListener("visibilitychange", this._onVisibilityChange);
  }
}
