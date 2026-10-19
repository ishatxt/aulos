/**
 * Visualizer — a genuinely analyser-driven spectrum, waveform and piano field.
 *
 * The canvas reads the live AnalyserNode connected to the audio graph. When
 * sound is disabled it draws an honest, quiet idle field rather than fake
 * motion. The generated piano spans C2–C7 and highlights the exact MIDI notes
 * currently sounding, including the ornament layers of the mapping.
 */

const PIANO_LOW_MIDI = 36; // C2
const PIANO_HIGH_MIDI = 96; // C7
const BLACK_PITCH_CLASSES = new Set([1, 3, 6, 8, 10]);
const NOTE_NAMES = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];
const IDLE_FRAME_INTERVAL = 100; // reduced-motion canvas refresh, ms

function midiLabel(midi) {
  return `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
}

function uniqueSorted(notes) {
  return [...new Set(notes.map((note) => Math.round(note.midi)).filter(Number.isFinite))].sort(
    (a, b) => a - b,
  );
}

export class Visualizer {
  constructor({
    canvas,
    piano,
    analyserReadout = null,
    timbreReadout = null,
    overlay = null,
    getAnalyserData = () => ({ frequency: null, waveform: null }),
    getSampleRate = () => 44_100,
    getAudioReady = () => false,
    reducedMotion = false,
    showWaveform = true,
    showPiano = true,
  }) {
    this.canvas = canvas;
    this.piano = piano;
    this.analyserReadout = analyserReadout;
    this.timbreReadout = timbreReadout;
    this.overlay = overlay;
    this.getAnalyserData = getAnalyserData;
    this.getSampleRate = getSampleRate;
    this.getAudioReady = getAudioReady;
    this.reducedMotion = reducedMotion;
    this.showWaveform = showWaveform;
    this.showPiano = showPiano;
    this.activeMidi = [];
    this.smoothed = new Float32Array(96);
    this.context = canvas.getContext("2d", { alpha: true });
    this.frame = null;
    this.lastDraw = 0;
    this.lastReadout = 0;
    this.destroyed = false;

    this.buildPiano();
    this.setShowPiano(showPiano);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement || canvas);
    window.addEventListener("resize", this.handleResize);
    this.resize();

    this.loop = this.loop.bind(this);
    this.frame = requestAnimationFrame(this.loop);
  }

  handleResize = () => this.resize();

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    if (width === this.width && height === this.height && dpr === this.dpr) return;
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.context.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  buildPiano() {
    if (!this.piano) return;
    const fragment = document.createDocumentFragment();
    let whiteIndex = -1;
    let whiteCount = 0;

    // Count white keys first so black-key positions are exact percentages.
    for (let midi = PIANO_LOW_MIDI; midi <= PIANO_HIGH_MIDI; midi += 1) {
      if (!BLACK_PITCH_CLASSES.has(midi % 12)) whiteCount += 1;
    }
    const whiteWidth = 100 / whiteCount;

    for (let midi = PIANO_LOW_MIDI; midi <= PIANO_HIGH_MIDI; midi += 1) {
      const black = BLACK_PITCH_CLASSES.has(midi % 12);
      const key = document.createElement("span");
      key.className = `piano-key ${black ? "black" : "white"}`;
      key.dataset.midi = String(midi);
      key.setAttribute("aria-hidden", "true");
      if (black) {
        key.style.left = `${(whiteIndex + 1) * whiteWidth}%`;
        key.style.transform = "translateX(-50%)";
      } else {
        whiteIndex += 1;
        if (midi % 12 === 0) {
          const label = document.createElement("span");
          label.className = "piano-label";
          label.textContent = midiLabel(midi);
          key.appendChild(label);
        }
      }
      fragment.appendChild(key);
    }
    this.piano.replaceChildren(fragment);
    this.piano.style.setProperty("--white-keys", String(whiteCount));
    this.whiteCount = whiteCount;
  }

  setActiveNotes(notes = []) {
    const next = uniqueSorted(Array.isArray(notes) ? notes : []);
    if (
      next.length === this.activeMidi.length &&
      next.every((midi, index) => midi === this.activeMidi[index])
    ) {
      return;
    }
    this.activeMidi = next;

    if (this.piano) {
      const active = new Set(next.map(String));
      this.piano.querySelectorAll(".piano-key").forEach((key) => {
        key.classList.toggle("is-active", active.has(key.dataset.midi));
      });
    }
    this.updateTimbreReadout();
  }

  updateTimbreReadout() {
    if (!this.timbreReadout) return;
    const count = this.activeMidi.length;
    this.timbreReadout.textContent = `${count} voice${count === 1 ? "" : "s"}`;
  }

  setShowWaveform(show) {
    this.showWaveform = Boolean(show);
  }

  setShowPiano(show) {
    this.showPiano = Boolean(show);
    const shell = this.piano?.closest(".piano-shell");
    if (shell) shell.hidden = !this.showPiano;
  }

  setReducedMotion(reduce) {
    this.reducedMotion = Boolean(reduce);
  }

  setAudioReady(ready) {
    if (this.overlay) {
      this.overlay.classList.toggle("is-hidden", Boolean(ready));
      this.overlay.textContent = ready
        ? "Analyser live · output routed locally"
        : "Enable sound to wake the analyser";
    }
    if (!ready) {
      this.activeMidi = [];
      if (this.piano) {
        this.piano.querySelectorAll(".piano-key.is-active").forEach((key) => {
          key.classList.remove("is-active");
        });
      }
      this.updateTimbreReadout();
    }
  }

  loop(timestamp) {
    if (this.destroyed) return;
    const interval = this.reducedMotion ? IDLE_FRAME_INTERVAL : 0;
    if (!interval || timestamp - this.lastDraw >= interval) {
      if (!document.hidden) this.draw(timestamp);
      this.lastDraw = timestamp;
    }
    this.frame = requestAnimationFrame(this.loop);
  }

  draw(timestamp) {
    const { context, width, height } = this;
    if (!context || !width || !height) return;
    context.clearRect(0, 0, width, height);

    const ready = this.getAudioReady();
    const data = ready ? this.getAnalyserData() : { frequency: null, waveform: null };
    const frequency = data?.frequency;
    const waveform = data?.waveform;

    // The shell is already a warm near-black; the canvas only adds luminous ink.
    if (!frequency || !frequency.length) {
      this.drawIdle();
      this.updateReadout(null);
      return;
    }

    this.drawSpectrum(frequency);
    if (this.showWaveform && waveform?.length) this.drawWaveform(waveform);
    this.updateReadout(frequency, timestamp);
  }

  drawIdle() {
    const { context, width, height } = this;
    const baseline = height - 20;
    context.save();
    const gradient = context.createLinearGradient(0, baseline - 1, width, baseline + 1);
    gradient.addColorStop(0, "rgba(214, 189, 138, 0)");
    gradient.addColorStop(0.25, "rgba(214, 189, 138, 0.2)");
    gradient.addColorStop(0.72, "rgba(182, 160, 239, 0.16)");
    gradient.addColorStop(1, "rgba(182, 160, 239, 0)");
    context.strokeStyle = gradient;
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(10, baseline);
    context.lineTo(width - 10, baseline);
    context.stroke();

    context.fillStyle = "rgba(236, 224, 203, 0.16)";
    const ticks = Math.max(12, Math.floor(width / 48));
    for (let i = 0; i < ticks; i += 1) {
      const x = 12 + (i / (ticks - 1)) * (width - 24);
      const tickHeight = i % 4 === 0 ? 5 : 2;
      context.fillRect(x, baseline - tickHeight, 1, tickHeight);
    }
    context.restore();
  }

  drawSpectrum(frequency) {
    const { context, width, height } = this;
    const barCount = Math.max(30, Math.min(88, Math.floor(width / 5.5)));
    if (this.smoothed.length !== barCount) this.smoothed = new Float32Array(barCount);

    const usableBins = Math.max(24, Math.floor(frequency.length * 0.56));
    const gap = Math.max(1, Math.min(3, width / barCount / 4.4));
    const barWidth = width / barCount - gap;
    const baseline = height - 19;
    const maximum = height - 42;

    const gradient = context.createLinearGradient(0, baseline, 0, baseline - maximum);
    gradient.addColorStop(0, "rgba(214, 189, 138, 0.18)");
    gradient.addColorStop(0.34, "rgba(214, 189, 138, 0.7)");
    gradient.addColorStop(0.8, "rgba(241, 221, 175, 0.94)");
    gradient.addColorStop(1, "rgba(182, 160, 239, 0.9)");

    context.save();
    context.fillStyle = gradient;
    context.shadowColor = "rgba(214, 189, 138, 0.22)";
    context.shadowBlur = 12;

    for (let index = 0; index < barCount; index += 1) {
      // A gentle power curve gives low fundamentals room without wasting most
      // of the display on near-silent high bins.
      const start = Math.floor((index / barCount) ** 1.55 * usableBins);
      const end = Math.max(start + 1, Math.floor(((index + 1) / barCount) ** 1.55 * usableBins));
      let sum = 0;
      for (let bin = start; bin < end; bin += 1) sum += frequency[bin] || 0;
      const average = sum / Math.max(1, end - start) / 255;
      const target = Math.pow(average, 1.25);
      this.smoothed[index] = Math.max(target, this.smoothed[index] * 0.78);

      const barHeight = Math.max(2, this.smoothed[index] * maximum);
      const x = index * (barWidth + gap) + gap / 2;
      const y = baseline - barHeight;
      context.beginPath();
      if (typeof context.roundRect === "function") {
        context.roundRect(x, y, Math.max(1, barWidth), barHeight, Math.min(2.5, barWidth / 2));
      } else {
        context.rect(x, y, Math.max(1, barWidth), barHeight);
      }
      context.fill();
    }
    context.restore();

    // A quiet zero line anchors the spectrum.
    context.fillStyle = "rgba(236, 224, 203, 0.09)";
    context.fillRect(10, baseline + 1, width - 20, 1);
  }

  drawWaveform(waveform) {
    const { context, width, height } = this;
    const middle = height * 0.46;
    const amplitude = height * 0.37;
    context.save();
    context.beginPath();
    const steps = Math.min(waveform.length, Math.max(120, Math.floor(width)));
    for (let index = 0; index < steps; index += 1) {
      const value = (waveform[Math.floor((index / steps) * waveform.length)] - 128) / 128;
      const x = (index / (steps - 1)) * width;
      const y = middle + value * amplitude;
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.strokeStyle = "rgba(182, 160, 239, 0.42)";
    context.lineWidth = 1;
    context.shadowColor = "rgba(182, 160, 239, 0.24)";
    context.shadowBlur = 5;
    context.stroke();
    context.restore();
  }

  updateReadout(frequency, timestamp = 0) {
    if (timestamp - this.lastReadout < 240) return;
    this.lastReadout = timestamp;

    if (this.analyserReadout) {
      if (!frequency) {
        this.analyserReadout.textContent = "FFT standby";
      } else {
        let peakBin = 0;
        let peakValue = 0;
        for (let bin = 0; bin < frequency.length; bin += 1) {
          if (frequency[bin] > peakValue) {
            peakValue = frequency[bin];
            peakBin = bin;
          }
        }
        if (peakValue < 6) {
          this.analyserReadout.textContent = "FFT · silent";
        } else {
          const sampleRate = this.getSampleRate();
          const frequencyHz = (peakBin / frequency.length) * (sampleRate / 2);
          this.analyserReadout.textContent =
            frequencyHz >= 1000
              ? `Peak ${(frequencyHz / 1000).toFixed(1)} kHz`
              : `Peak ${Math.round(frequencyHz)} Hz`;
        }
      }
    }

    this.updateTimbreReadout();
  }

  destroy() {
    this.destroyed = true;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.resizeObserver?.disconnect();
    window.removeEventListener("resize", this.handleResize);
  }
}

export { PIANO_LOW_MIDI, PIANO_HIGH_MIDI, midiLabel };
