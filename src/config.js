/**
 * CHESSOUND configuration and musical vocabulary.
 *
 * This module is intentionally dependency-free and deterministic. It is the
 * single source of truth for defaults, scales, mode presets, voice character
 * and lakehouse persistence keys. Keeping this data declarative makes the
 * mapping engine testable without a browser or an audio context.
 */

export const APP_NAME = "CHESSOUND";
export const SCHEMA_VERSION = 1;
export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

export const STORAGE_KEYS = {
  preferences: "chessound.preferences.v1",
  compositions: "chessound.compositions.v1",
  audioHintDismissed: "chessound.audio-hint.v1",
};

/**
 * Root pitch classes use their preferred accidental spelling. MIDI note 60 is
 * C4 in this application.
 */
export const ROOT_NOTES = [
  { value: "C", label: "C", pitchClass: 0 },
  { value: "C#", label: "C♯ / D♭", pitchClass: 1 },
  { value: "D", label: "D", pitchClass: 2 },
  { value: "D#", label: "D♯ / E♭", pitchClass: 3 },
  { value: "E", label: "E", pitchClass: 4 },
  { value: "F", label: "F", pitchClass: 5 },
  { value: "F#", label: "F♯ / G♭", pitchClass: 6 },
  { value: "G", label: "G", pitchClass: 7 },
  { value: "G#", label: "G♯ / A♭", pitchClass: 8 },
  { value: "A", label: "A", pitchClass: 9 },
  { value: "A#", label: "A♯ / B♭", pitchClass: 10 },
  { value: "B", label: "B", pitchClass: 11 },
];

export const SCALES = {
  major: {
    label: "Major / Ionian",
    short: "Major",
    intervals: [0, 2, 4, 5, 7, 9, 11],
    character: "Open, luminous and consonant.",
  },
  naturalMinor: {
    label: "Natural minor / Aeolian",
    short: "Natural minor",
    intervals: [0, 2, 3, 5, 7, 8, 10],
    character: "Reflective, grounded and quietly dramatic.",
  },
  harmonicMinor: {
    label: "Harmonic minor",
    short: "Harmonic minor",
    intervals: [0, 2, 3, 5, 7, 8, 11],
    character: "Classical tension with a raised leading tone.",
  },
  dorian: {
    label: "Dorian",
    short: "Dorian",
    intervals: [0, 2, 3, 5, 7, 9, 10],
    character: "Modal, hopeful and slightly unresolved.",
  },
  pentatonicMajor: {
    label: "Major pentatonic",
    short: "Pentatonic",
    intervals: [0, 2, 4, 7, 9],
    character: "Airy and almost impossible to make harsh.",
  },
  pentatonicMinor: {
    label: "Minor pentatonic",
    short: "Minor pentatonic",
    intervals: [0, 3, 5, 7, 10],
    character: "Compact, soulful and minimal.",
  },
  chromatic: {
    label: "Chromatic (experimental)",
    short: "Chromatic",
    intervals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    character: "All twelve pitches; tension is part of the language.",
  },
};

/**
 * Each register contains a two-octave working span. Destination rank chooses
 * the lower or upper half of that span; the final MIDI value is clamped by the
 * engine so no voice can leave a safe, listenable range.
 */
export const REGISTERS = {
  low: { label: "Low · 2–4", baseOctave: 3, minMidi: 24, maxMidi: 84 },
  medium: { label: "Middle · 3–5", baseOctave: 4, minMidi: 36, maxMidi: 96 },
  high: { label: "High · 4–6", baseOctave: 5, minMidi: 48, maxMidi: 108 },
};

/**
 * Voice presets are synthesis recipes rather than samples, so they always work
 * offline. The audio engine turns the `synth` fields into oscillator graphs.
 */
export const VOICE_PRESETS = {
  ivory: {
    id: "ivory",
    label: "Ivory piano",
    description: "Warm felt-piano body with a soft, rounded attack.",
    octaveShift: 0,
    pan: -0.08,
    synth: {
      waveform: "triangle",
      overtone: "sine",
      overtoneRatio: 2,
      overtoneGain: 0.22,
      attack: 0.012,
      decay: 0.22,
      sustain: 0.35,
      release: 1.15,
      filter: 4200,
      detune: 2,
    },
  },
  onyx: {
    id: "onyx",
    label: "Onyx piano",
    description: "Dark, close piano with a muted lower register.",
    octaveShift: -1,
    pan: 0.14,
    synth: {
      waveform: "triangle",
      overtone: "sine",
      overtoneRatio: 1.5,
      overtoneGain: 0.3,
      attack: 0.018,
      decay: 0.28,
      sustain: 0.3,
      release: 1.35,
      filter: 2400,
      detune: -4,
    },
  },
  glass: {
    id: "glass",
    label: "Glass celesta",
    description: "Bright bell-like partials with a long shimmering tail.",
    octaveShift: 1,
    pan: 0.22,
    synth: {
      waveform: "sine",
      overtone: "sine",
      overtoneRatio: 3,
      overtoneGain: 0.4,
      attack: 0.004,
      decay: 0.4,
      sustain: 0.15,
      release: 2.2,
      filter: 7000,
      detune: 5,
    },
  },
  velvet: {
    id: "velvet",
    label: "Velvet strings",
    description: "Bowed, breathing texture that blooms rather than strikes.",
    octaveShift: 0,
    pan: -0.2,
    synth: {
      waveform: "sawtooth",
      overtone: "triangle",
      overtoneRatio: 1.01,
      overtoneGain: 0.22,
      attack: 0.22,
      decay: 0.35,
      sustain: 0.58,
      release: 1.8,
      filter: 1600,
      detune: 7,
    },
  },
  reed: {
    id: "reed",
    label: "Reed organ",
    description: "A gently buzzing chamber organ with hollow overtones.",
    octaveShift: 0,
    pan: 0.04,
    synth: {
      waveform: "square",
      overtone: "sine",
      overtoneRatio: 2.01,
      overtoneGain: 0.18,
      attack: 0.08,
      decay: 0.18,
      sustain: 0.5,
      release: 0.8,
      filter: 2600,
      detune: 0,
    },
  },
  cello: {
    id: "cello",
    label: "Deep cello",
    description: "Low, resonant bowed tone for the opposing voice.",
    octaveShift: -1,
    pan: 0.18,
    synth: {
      waveform: "sawtooth",
      overtone: "sine",
      overtoneRatio: 0.5,
      overtoneGain: 0.3,
      attack: 0.08,
      decay: 0.5,
      sustain: 0.48,
      release: 1.6,
      filter: 1050,
      detune: -6,
    },
  },
  pluck: {
    id: "pluck",
    label: "Nylon pluck",
    description: "Short, intimate pluck with a woody decay.",
    octaveShift: 0,
    pan: 0.1,
    synth: {
      waveform: "triangle",
      overtone: "sine",
      overtoneRatio: 2,
      overtoneGain: 0.12,
      attack: 0.002,
      decay: 0.12,
      sustain: 0.08,
      release: 0.55,
      filter: 3200,
      detune: 0,
    },
  },
  pulse: {
    id: "pulse",
    label: "Pure pulse",
    description: "A clean sine pluck for minimal, uncluttered lines.",
    octaveShift: 0,
    pan: -0.05,
    synth: {
      waveform: "sine",
      overtone: "sine",
      overtoneRatio: 2,
      overtoneGain: 0.08,
      attack: 0.005,
      decay: 0.1,
      sustain: 0.2,
      release: 0.7,
      filter: 5000,
      detune: 0,
    },
  },
};

/**
 * Modes are complete starting points, not locked effects. Choosing a mode sets
 * the documented defaults; every resulting setting remains editable.
 */
export const MODES = {
  classical: {
    id: "classical",
    label: "Classical",
    subtitle: "Piano recital",
    description:
      "A clear melodic line with restrained harmonic doubling and a recital-hall tail.",
    tempo: 84,
    reverb: 0.32,
    noteLength: 1,
    intensity: 0.62,
    scale: "major",
    rhythm: "flow",
    whiteVoice: "ivory",
    blackVoice: "onyx",
    accent: "#d6bd8a",
  },
  cinematic: {
    id: "cinematic",
    label: "Cinematic",
    subtitle: "Low strings & drama",
    description:
      "Layered low registers, wider capture chords and slow-blooming dramatic accents.",
    tempo: 64,
    reverb: 0.52,
    noteLength: 1.24,
    intensity: 0.88,
    scale: "harmonicMinor",
    rhythm: "flow",
    whiteVoice: "ivory",
    blackVoice: "cello",
    accent: "#b69be8",
  },
  ambient: {
    id: "ambient",
    label: "Ambient",
    subtitle: "Slow air",
    description:
      "Spacious pentatonic gestures, long releases and a distant, meditative hall.",
    tempo: 52,
    reverb: 0.8,
    noteLength: 1.6,
    intensity: 0.38,
    scale: "pentatonicMajor",
    rhythm: "spacious",
    whiteVoice: "glass",
    blackVoice: "velvet",
    accent: "#9fcfc0",
  },
  minimal: {
    id: "minimal",
    label: "Minimal",
    subtitle: "Plucks & space",
    description:
      "One clear pulse per move, almost no doubling, dry and intimate. Every note counts.",
    tempo: 100,
    reverb: 0.18,
    noteLength: 0.62,
    intensity: 0.34,
    scale: "pentatonicMinor",
    rhythm: "steady",
    whiteVoice: "pulse",
    blackVoice: "pluck",
    accent: "#e2aa82",
  },
  experimental: {
    id: "experimental",
    label: "Experimental",
    subtitle: "Chromatic study",
    description:
      "A twelve-tone grid, syncopated rests and controlled tritone tension. Strange on purpose.",
    tempo: 108,
    reverb: 0.24,
    noteLength: 0.64,
    intensity: 0.74,
    scale: "chromatic",
    rhythm: "syncopated",
    whiteVoice: "reed",
    blackVoice: "glass",
    accent: "#ef8d8d",
  },
};

export const PIECE_PROFILES = {
  p: {
    label: "Pawn",
    character: "A single, honest seed tone.",
    octaveShift: 0,
    velocity: 0.68,
    articulation: 0.8,
    harmonic: 0,
  },
  n: {
    label: "Knight",
    character: "A springy, lifted staccato one octave above the pawn line.",
    octaveShift: 1,
    velocity: 0.78,
    articulation: 0.58,
    harmonic: 0,
  },
  b: {
    label: "Bishop",
    character: "An airy upper voice with a longer shimmer.",
    octaveShift: 1,
    velocity: 0.72,
    articulation: 0.9,
    harmonic: 1,
  },
  r: {
    label: "Rook",
    character: "A grounded lower tone with broad, stable weight.",
    octaveShift: -1,
    velocity: 0.84,
    articulation: 1.1,
    harmonic: 1,
  },
  q: {
    label: "Queen",
    character: "The richest voice: full body and a diatonic third above.",
    octaveShift: 0,
    velocity: 0.9,
    articulation: 1.15,
    harmonic: 2,
  },
  k: {
    label: "King",
    character: "A warm low centre with a slow, deliberate envelope.",
    octaveShift: -1,
    velocity: 0.8,
    articulation: 1.35,
    harmonic: 1,
  },
};

export const RHYTHMS = {
  flow: {
    label: "Flowing",
    description: "Move type shapes the length; captures and castles breathe longer.",
  },
  steady: {
    label: "Steady pulse",
    description: "Every chess move advances the same amount of musical time.",
  },
  spacious: {
    label: "Spacious",
    description: "Long, unhurried move durations with room around each gesture.",
  },
  syncopated: {
    label: "Syncopated",
    description: "A repeating pattern of short and long steps creates asymmetric accents.",
  },
};

export const DEFAULT_SETTINGS = {
  mode: "classical",
  rootNote: "C",
  scale: "major",
  register: "medium",
  tempo: 84,
  rhythm: "flow",
  noteLength: 1,
  reverb: 0.32,
  instrumentIntensity: 0.62,
  masterVolume: 0.72,
  whiteVoice: "ivory",
  blackVoice: "onyx",
  effectCaptures: true,
  effectChecks: true,
  effectPromotions: true,
  effectCheckmate: true,
  showWaveform: true,
  showPiano: true,
  reduceMotion: false,
  autoScrollMoves: true,
};

const NUMBER_LIMITS = {
  tempo: [36, 180],
  noteLength: [0.35, 2.4],
  reverb: [0, 1],
  instrumentIntensity: [0, 1],
  masterVolume: [0, 1],
};

/**
 * Local storage can contain old or hand-edited data. Normalize every field and
 * discard unknown keys so the audio engine always receives safe values.
 */
export function sanitizeSettings(input = {}) {
  const settings = { ...DEFAULT_SETTINGS };
  const source = input && typeof input === "object" ? input : {};

  for (const [key, [min, max]] of Object.entries(NUMBER_LIMITS)) {
    const value = Number(source[key]);
    settings[key] = Number.isFinite(value)
      ? Math.min(max, Math.max(min, value))
      : DEFAULT_SETTINGS[key];
  }

  for (const [key, allowed] of [
    ["mode", Object.keys(MODES)],
    ["scale", Object.keys(SCALES)],
    ["register", Object.keys(REGISTERS)],
    ["rhythm", Object.keys(RHYTHMS)],
    ["whiteVoice", Object.keys(VOICE_PRESETS)],
    ["blackVoice", Object.keys(VOICE_PRESETS)],
  ]) {
    settings[key] = allowed.includes(source[key]) ? source[key] : DEFAULT_SETTINGS[key];
  }

  settings.rootNote = ROOT_NOTES.some((note) => note.value === source.rootNote)
    ? source.rootNote
    : DEFAULT_SETTINGS.rootNote;

  for (const key of [
    "effectCaptures",
    "effectChecks",
    "effectPromotions",
    "effectCheckmate",
    "showWaveform",
    "showPiano",
    "reduceMotion",
    "autoScrollMoves",
  ]) {
    settings[key] = typeof source[key] === "boolean" ? source[key] : DEFAULT_SETTINGS[key];
  }

  return settings;
}

/**
 * Apply a mode's documented starting values while retaining the player's root
 * note. The user can override anything afterwards in Settings.
 */
export function applyModePreset(settings, modeId) {
  const mode = MODES[modeId];
  if (!mode) return sanitizeSettings(settings);
  return sanitizeSettings({
    ...settings,
    mode: mode.id,
    scale: mode.scale,
    tempo: mode.tempo,
    reverb: mode.reverb,
    noteLength: mode.noteLength,
    instrumentIntensity: mode.intensity,
    rhythm: mode.rhythm,
    whiteVoice: mode.whiteVoice,
    blackVoice: mode.blackVoice,
  });
}

export const PIECE_GLYPHS = {
  p: "♟",
  n: "♞",
  b: "♝",
  r: "♜",
  q: "♛",
  k: "♚",
};

export function midiToNoteName(midi) {
  const names = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];
  const safeMidi = Math.round(midi);
  return `${names[((safeMidi % 12) + 12) % 12]}${Math.floor(safeMidi / 12) - 1}`;
}
