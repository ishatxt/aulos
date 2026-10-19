/**
 * CHESSOUND's deterministic chess-to-music engine.
 *
 * Mapping contract (also surfaced in the UI):
 *   file a-h  -> scale degrees 0-7, in order
 *   rank 1-4  -> lower octave; rank 5-8 -> upper octave of the selected register
 *   piece     -> register offset, velocity, articulation and harmonic tendency
 *   colour    -> assigned voice, a darker octave for Black and stereo position
 *   move type -> rhythmic length and documented ornament (capture/check/etc.)
 *
 * There is no randomness and no wall-clock input in this module. Composition
 * playback and offline WAV rendering both consume exactly these note objects.
 */

import {
  MIDI_SAFE_MAX,
  MIDI_SAFE_MIN,
  MODES,
  PIECE_PROFILES,
  REGISTERS,
  ROOT_NOTES,
  SCALES,
  VOICE_PRESETS,
  midiToNoteName,
  sanitizeSettings,
} from "./config.js";

const FILE_ORDER = ["a", "b", "c", "d", "e", "f", "g", "h"];
const SYNC_PATTERN = [1, 0.75, 1.25, 0.5, 1.5, 1, 0.875];

export const MAPPING_RULES = [
  {
    key: "file",
    label: "File → scale degree",
    detail: "Files a–h are the seven diatonic steps (an eighth file continues into the next octave).",
  },
  {
    key: "rank",
    label: "Rank → register",
    detail: "Ranks 1–4 sit in the lower half of the chosen register; ranks 5–8 in the upper half.",
  },
  {
    key: "piece",
    label: "Piece → character",
    detail: "Each piece has its own octave offset, attack, velocity and harmonic tendency.",
  },
  {
    key: "colour",
    label: "Colour → voice",
    detail: "White and Black use the two assigned voices; Black also sits one octave lower.",
  },
  {
    key: "event",
    label: "Move type → gesture",
    detail: "Captures add harmony, checks add a tension sting, castles roll a chord, promotions flourish, mate cadences.",
  },
  {
    key: "rhythm",
    label: "Rhythm → time",
    detail: "Rhythm style and move type set quantized beat lengths. Tempo converts beats to seconds.",
  },
];

export function midiToFrequency(midi) {
  return 440 * 2 ** ((midi - 69) / 12);
}

export function squareToCoordinates(square) {
  return {
    file: square.charAt(0),
    fileIndex: FILE_ORDER.indexOf(square.charAt(0)),
    rank: Number(square.charAt(1)),
  };
}

/**
 * Convert a scale degree + octave to a MIDI note. Degrees can go negative or
 * beyond the scale length; octave wrapping is handled explicitly.
 */
export function scaleDegreeToMidi(settings, degree, octave) {
  const safe = sanitizeSettings(settings);
  const root = ROOT_NOTES.find((note) => note.value === safe.rootNote) ?? ROOT_NOTES[0];
  const scale = SCALES[safe.scale] ?? SCALES.major;
  const count = scale.intervals.length;
  const octaveWrap = Math.floor(degree / count);
  const index = ((degree % count) + count) % count;
  return 12 * (octave + 1) + root.pitchClass + scale.intervals[index] + octaveWrap * 12;
}

function clampMidi(midi, settings) {
  const register = REGISTERS[settings.register] ?? REGISTERS.medium;
  return Math.max(
    MIDI_SAFE_MIN,
    Math.min(MIDI_SAFE_MAX, Math.max(register.minMidi, Math.min(register.maxMidi, midi))),
  );
}

/**
 * The base destination pitch is deliberately simple to make the mapping
 * transparent: file chooses the degree, rank chooses the register.
 */
export function destinationPitch(settings, square, piece = "p", color = "w") {
  const { fileIndex, rank } = squareToCoordinates(square);
  const register = REGISTERS[settings.register] ?? REGISTERS.medium;
  const pieceProfile = PIECE_PROFILES[piece] ?? PIECE_PROFILES.p;
  const voice = VOICE_PRESETS[color === "w" ? settings.whiteVoice : settings.blackVoice] ?? VOICE_PRESETS.ivory;
  const upperHalf = rank >= 5 ? 1 : 0;
  const colourShift = color === "b" ? -1 : 0;
  const octave = register.baseOctave + upperHalf + pieceProfile.octaveShift + voice.octaveShift + colourShift;
  const unclamped = scaleDegreeToMidi(settings, fileIndex, octave);
  const midi = clampMidi(unclamped, settings);
  return {
    midi,
    note: midiToNoteName(midi),
    file: FILE_ORDER[fileIndex],
    fileIndex,
    rank,
    scaleDegree: fileIndex,
    octave,
    upperHalf,
    pieceShift: pieceProfile.octaveShift,
    voiceShift: voice.octaveShift,
    colourShift,
    clamped: midi !== Math.max(register.minMidi, Math.min(register.maxMidi, unclamped)),
    voiceId: color === "w" ? settings.whiteVoice : settings.blackVoice,
  };
}

function voiceFor(settings, color) {
  return VOICE_PRESETS[color === "w" ? settings.whiteVoice : settings.blackVoice] ?? VOICE_PRESETS.ivory;
}

function velocityFor(settings, move, role = "base") {
  const piece = PIECE_PROFILES[move.piece] ?? PIECE_PROFILES.p;
  const intensity = 0.72 + settings.instrumentIntensity * 0.28;
  const colour = move.color === "b" ? 0.96 : 1;
  const roleFactor = {
    base: 1,
    harmonic: 0.58,
    capture: 0.7,
    tension: 0.42,
    flourish: 0.58,
    cadence: 0.7,
    pedal: 0.35,
    air: 0.3,
  }[role] ?? 1;
  return Math.max(0.08, Math.min(0.98, piece.velocity * intensity * colour * roleFactor));
}

function moveDurationBeats(settings, move, isCheckmate) {
  const rhythm = settings.rhythm;
  const check = Boolean(move.check);
  const capture = Boolean(move.capture);
  const castle = Boolean(move.castle);
  const promotion = Boolean(move.promotion);
  let beats;

  if (rhythm === "steady") {
    beats = 1.1;
  } else if (rhythm === "spacious") {
    beats = 2.1;
  } else if (rhythm === "syncopated") {
    beats = SYNC_PATTERN[(move.ply - 1) % SYNC_PATTERN.length];
  } else {
    beats = 1.45;
  }

  if (capture) beats += 0.28;
  if (castle) beats += 0.42;
  if (promotion) beats += 0.52;
  if (check) beats += 0.2;

  if (isCheckmate && settings.effectCheckmate) {
    return 5.2;
  }
  return Number(beats.toFixed(3));
}

function noteDuration(settings, move, role, eventBeats) {
  const piece = PIECE_PROFILES[move.piece] ?? PIECE_PROFILES.p;
  const modeFactor = settings.mode === "ambient" ? 1.35 : settings.mode === "minimal" ? 0.62 : 1;
  const roleFactor = role === "base" ? 1 : role === "tension" ? 0.32 : 0.82;
  const beats = eventBeats * 0.72 * piece.articulation * settings.noteLength * modeFactor * roleFactor;
  return Math.max(0.22, Math.min(3.2, Number(beats.toFixed(3))));
}

function note(settings, move, midi, options = {}) {
  const safeMidi = clampMidi(Math.round(midi), settings);
  const voiceId = options.voiceId ?? voiceFor(settings, move.color).id;
  return {
    midi: safeMidi,
    note: midiToNoteName(safeMidi),
    frequency: Number(midiToFrequency(safeMidi).toFixed(4)),
    offset: Number((options.offset ?? 0).toFixed(3)),
    duration: Number((options.duration ?? 0.7).toFixed(3)),
    velocity: Number((options.velocity ?? velocityFor(settings, move, options.role)).toFixed(3)),
    voiceId,
    role: options.role ?? "base",
    color: move.color,
  };
}

function baseNoteFor(settings, move, destination, duration) {
  return note(settings, move, destination.midi, {
    role: "base",
    duration,
    voiceId: destination.voiceId,
  });
}

/**
 * Add the small, restrained ornaments that make each move type recognizable.
 * Ornaments are opt-in through Settings except for castling, which is part of
 * the core chess-to-music promise.
 */
function addMoveOrnaments(settings, move, destination, eventBeats, add) {
  const mode = MODES[settings.mode] ?? MODES.classical;
  const isMate = Boolean(move.checkmate);
  const captureEnabled = !move.capture || settings.effectCaptures;

  // Checks use an intentionally chromatic tension interval. It is quiet, short,
  // and the following move often resolves it by step.
  if (move.check && !isMate && settings.effectChecks) {
    add(destination.midi + 1, {
      role: "tension",
      offset: Math.min(0.22, eventBeats * 0.2),
      duration: Math.max(0.16, eventBeats * 0.28),
      velocity: velocityFor(settings, move, "tension") * (mode.id === "ambient" ? 0.5 : 1),
      voiceId: destination.voiceId,
    });
    if (mode.id !== "ambient") {
      add(destination.midi + 6, {
        role: "tension",
        offset: Math.min(0.35, eventBeats * 0.32),
        duration: Math.max(0.14, eventBeats * 0.2),
        velocity: velocityFor(settings, move, "tension") * 0.72,
        voiceId: voiceFor(settings, move.color === "w" ? "b" : "w").id,
      });
    }
  }

  // Captures bloom into a diatonic third above the landing tone plus a low body.
  if (move.capture && settings.effectCaptures && !isMate) {
    const third = scaleDegreeToMidi(settings, destination.fileIndex + 2, destination.octave);
    add(third, {
      role: "capture",
      offset: 0.04,
      duration: noteDuration(settings, move, "harmonic", eventBeats) * 1.08,
      velocity: velocityFor(settings, move, "capture"),
      voiceId: destination.voiceId,
    });
    if (mode.id === "cinematic" || settings.instrumentIntensity > 0.74) {
      add(destination.midi - 12, {
        role: "capture",
        offset: 0.01,
        duration: noteDuration(settings, move, "harmonic", eventBeats) * 1.3,
        velocity: velocityFor(settings, move, "capture") * 0.7,
        voiceId: settings.blackVoice,
      });
    }
  }

  // Castling rolls a quick root–fifth–octave figure into the landing note. The
  // base note is placed on the final beat of the phrase.
  if (move.castle) {
    const roll = [0, 7, 12];
    const duration = Math.max(0.28, eventBeats * 0.52);
    roll.slice(0, 2).forEach((interval, index) => {
      add(destination.midi + interval, {
        role: "flourish",
        offset: index * 0.13,
        duration,
        velocity: velocityFor(settings, move, "flourish") * (index === 0 ? 0.8 : 1),
        voiceId: destination.voiceId,
      });
    });
  }

  // Promotion is a rising fourth/fifth bloom that lands on the new piece. The
  // top note is doubled an octave above to make the promotion unmistakable.
  if (move.promotion && settings.effectPromotions) {
    const phrase = [destination.midi - 12, destination.midi - 7, destination.midi - 4];
    phrase.forEach((midi, index) => {
      add(midi, {
        role: "flourish",
        offset: index * 0.12,
        duration: Math.max(0.24, eventBeats * 0.36),
        velocity: velocityFor(settings, move, "flourish"),
        voiceId: destination.voiceId,
      });
    });
    add(destination.midi + 12, {
      role: "flourish",
      offset: 0.37,
      duration: Math.max(0.4, eventBeats * 0.48),
      velocity: velocityFor(settings, move, "flourish") * 0.8,
      voiceId: destination.voiceId,
    });
  }

  // A queen's third and a rook's low fifth give each major piece a memorable
  // signature without overpowering the melody.
  if (move.piece === "q" && settings.instrumentIntensity > 0.38) {
    add(scaleDegreeToMidi(settings, destination.fileIndex + 2, destination.octave), {
      role: "harmonic",
      offset: 0.05,
      duration: noteDuration(settings, move, "harmonic", eventBeats),
      velocity: velocityFor(settings, move, "harmonic"),
      voiceId: destination.voiceId,
    });
  }
  if (move.piece === "r") {
    add(scaleDegreeToMidi(settings, destination.fileIndex - 3, destination.octave - 1), {
      role: "pedal",
      offset: 0.02,
      duration: noteDuration(settings, move, "pedal", eventBeats) * 1.15,
      velocity: velocityFor(settings, move, "pedal"),
      voiceId: destination.voiceId,
    });
  }
  if (move.piece === "b" && settings.instrumentIntensity > 0.55) {
    add(destination.midi + 12, {
      role: "air",
      offset: 0.08,
      duration: noteDuration(settings, move, "air", eventBeats) * 1.2,
      velocity: velocityFor(settings, move, "air"),
      voiceId: destination.voiceId,
    });
  }

  // Mode-specific colour. These layers are intentionally quiet and always
  // derived from the same destination pitch, so they remain reproducible.
  if (mode.id === "cinematic" && !isMate && (move.capture || move.piece === "q" || move.ply % 4 === 0)) {
    add(scaleDegreeToMidi(settings, destination.fileIndex - 3, destination.octave - 1), {
      role: "pedal",
      offset: 0,
      duration: Math.max(0.55, eventBeats * 0.9),
      velocity: velocityFor(settings, move, "pedal"),
      voiceId: settings.blackVoice,
    });
  }
  if (mode.id === "ambient" && captureEnabled && !isMate) {
    add(scaleDegreeToMidi(settings, destination.fileIndex + 4, destination.octave + 1), {
      role: "air",
      offset: 0.18,
      duration: Math.max(0.75, eventBeats * 1.2),
      velocity: velocityFor(settings, move, "air") * 0.8,
      voiceId: settings.whiteVoice,
    });
  }
  if (mode.id === "experimental" && move.ply % 3 === 0 && !isMate) {
    add(destination.midi + 1, {
      role: "tension",
      offset: 0.09,
      duration: Math.max(0.22, eventBeats * 0.4),
      velocity: velocityFor(settings, move, "tension"),
      voiceId: settings.blackVoice,
    });
  }

  // En passant gets a dry low punctuation because the captured pawn disappears
  // from a square other than the destination.
  if (move.enPassant) {
    add(destination.midi - 12, {
      role: "capture",
      offset: 0.02,
      duration: 0.32,
      velocity: velocityFor(settings, move, "capture") * 0.8,
      voiceId: settings.blackVoice,
    });
  }
}

/**
 * Final cadence: a low tonic, fifth, octave and high tonic with increasing
 * spacing. It uses a perfect-fifth skeleton, so it remains stable in every
 * scale, including chromatic mode.
 */
function addCheckmateCadence(settings, move, destination, eventBeats, add) {
  if (!settings.effectCheckmate) return;
  const register = REGISTERS[settings.register] ?? REGISTERS.medium;
  const root = ROOT_NOTES.find((item) => item.value === settings.rootNote) ?? ROOT_NOTES[0];
  const tonic = (octave) => 12 * (octave + 1) + root.pitchClass;
  const lowOctave = Math.max(1, register.baseOctave - 1);
  const base = tonic(register.baseOctave);
  const chordOffsets = [0, 0.12, 0.26, 0.42, 0.68, 0.96];
  const chordMidi = [
    tonic(lowOctave),
    base,
    base + 7,
    base + 12,
    base + 19,
    base + 24,
  ];
  const velocities = [0.82, 0.66, 0.52, 0.46, 0.32, 0.2];

  chordMidi.forEach((midi, index) => {
    add(midi, {
      role: "cadence",
      offset: chordOffsets[index],
      duration: Math.max(0.9, eventBeats - chordOffsets[index] - 0.4),
      velocity: velocities[index] * (0.72 + settings.instrumentIntensity * 0.28),
      voiceId: index < 2 ? settings.blackVoice : destination.voiceId,
    });
  });

  // A final high destination tone reasserts the square that delivered mate.
  add(destination.midi + 12, {
    role: "cadence",
    offset: 1.2,
    duration: Math.max(1.2, eventBeats * 0.62),
    velocity: velocityFor(settings, move, "cadence"),
    voiceId: destination.voiceId,
  });
}

function motifLabel(move) {
  if (move.checkmate) return "Checkmate cadence";
  if (move.promotion) return "Promotion flourish";
  if (move.castle) return "Castling roll";
  if (move.check) return "Check tension";
  if (move.capture) return "Capture bloom";
  return "Single voice";
}

function explainEvent(settings, move, destination, motif) {
  const register = REGISTERS[settings.register];
  const piece = PIECE_PROFILES[move.piece] ?? PIECE_PROFILES.p;
  const voice = voiceFor(settings, move.color);
  const result = [];
  result.push(
    `${move.to.toUpperCase()} uses file ${move.to[0]} → scale degree ${destination.fileIndex + 1}, ` +
      `rank ${destination.rank} → ${destination.upperHalf ? "upper" : "lower"} octave (${destination.octave}).`,
  );
  result.push(
    `${piece.label} adds ${piece.octaveShift >= 0 ? "+" : ""}${piece.octaveShift} octave and its ${piece.character.toLowerCase()}`,
  );
  result.push(
    `${move.color === "w" ? "White" : "Black"} speaks through ${voice.label}${move.color === "b" ? " one octave lower" : ""}.`,
  );
  if (motif !== "Single voice") result.push(`${motif} added by the move's chess meaning.`);
  if (destination.clamped) result.push("The pitch was clamped to the selected register's safe range.");
  return result;
}

function normaliseMove(move) {
  const flags = typeof move.flags === "string" ? move.flags : "";
  const isCapture =
    Boolean(move.captured) ||
    (typeof move.isCapture === "function" && move.isCapture()) ||
    flags.includes("c") ||
    flags.includes("e");
  const isKingSide =
    (typeof move.isKingsideCastle === "function" && move.isKingsideCastle()) || flags.includes("k");
  const isQueenSide =
    (typeof move.isQueensideCastle === "function" && move.isQueensideCastle()) || flags.includes("q");
  const san = String(move.san ?? "");
  return {
    ...move,
    ply: Number(move.ply ?? 0),
    piece: move.piece ?? "p",
    color: move.color ?? "w",
    from: move.from,
    to: move.to,
    san,
    capture: isCapture,
    castle: isKingSide || isQueenSide,
    castleSide: isKingSide ? "kingside" : isQueenSide ? "queenside" : null,
    check: Boolean(move.check) || /\+$/.test(san),
    checkmate: Boolean(move.checkmate) || /#$/.test(san),
    promotion: Boolean(move.promotion) || flags.includes("p"),
    enPassant: flags.includes("e"),
  };
}

export function moveToEvent(settingsInput, rawMove, ply, startBeat) {
  const settings = sanitizeSettings(settingsInput);
  const move = normaliseMove({ ...rawMove, ply });
  const destination = destinationPitch(settings, move.to, move.piece, move.color);
  const beats = moveDurationBeats(settings, move, move.checkmate);
  const notes = [];
  const add = (midi, options) => notes.push(note(settings, move, midi, options));

  // The destination note arrives slightly after the ornament that leads into
  // it for castling/promotion so special moves have a recognisable arc.
  const hasLeadIn = (move.castle || (move.promotion && settings.effectPromotions)) && !move.checkmate;
  const baseOffset = hasLeadIn ? 0.26 : 0;
  add(destination.midi, {
    role: "base",
    offset: baseOffset,
    duration: noteDuration(settings, move, "base", beats),
    voiceId: destination.voiceId,
  });
  addMoveOrnaments(settings, move, destination, beats, add);
  if (move.checkmate) addCheckmateCadence(settings, move, destination, beats, add);

  notes.sort((a, b) => a.offset - b.offset || a.midi - b.midi);
  const lastNoteEnd = Math.max(...notes.map((item) => item.offset + item.duration), 0);
  const eventDuration = Number(Math.max(beats, lastNoteEnd + 0.22).toFixed(3));
  const motif = motifLabel(move);

  return {
    id: `ply-${move.ply}`,
    ply: move.ply,
    moveNumber: Math.ceil(move.ply / 2),
    san: move.san,
    color: move.color,
    piece: move.piece,
    captured: move.captured ?? null,
    promotionPiece: move.promotion ?? null,
    from: move.from,
    to: move.to,
    flags: {
      capture: move.capture,
      check: move.check,
      checkmate: move.checkmate,
      castle: move.castle,
      castleSide: move.castleSide,
      promotion: move.promotion,
      enPassant: move.enPassant,
    },
    boardFen: move.after ?? move.fen ?? "",
    startBeat: Number(startBeat.toFixed(3)),
    durationBeats: eventDuration,
    baseNote: notes.find((item) => item.role === "base") ?? notes[0],
    noteNames: notes.map((item) => item.note),
    notes,
    motif,
    motifClass: move.checkmate
      ? "mate"
      : move.check
        ? "check"
        : move.capture
          ? "capture"
          : move.promotion
            ? "promotion"
            : move.castle
              ? "castle"
              : "plain",
    mapping: {
      square: move.to,
      file: destination.file,
      fileIndex: destination.fileIndex,
      rank: destination.rank,
      scaleDegree: destination.scaleDegree,
      octave: destination.octave,
      upperHalf: destination.upperHalf,
      pieceShift: destination.pieceShift,
      voiceShift: destination.voiceShift,
      colourShift: destination.colourShift,
      register: settings.register,
      clamped: destination.clamped,
      voiceLabel: voiceFor(settings, move.color).label,
      pieceLabel: PIECE_PROFILES[move.piece]?.label ?? "Pawn",
    },
    explanation: explainEvent(settings, move, destination, motif),
  };
}

function createTitle(meta, moveCount) {
  if (meta.title) return meta.title;
  if (moveCount === 0) return "Untitled position";
  const white = meta.white || "White";
  const black = meta.black || "Black";
  return `${white} vs ${black}`;
}

function makeId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `comp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Build a complete, reusable composition from chess.js verbose move objects.
 * Note generation only uses `settings`, the move object and move index.
 */
export function buildComposition(rawMoves, settingsInput, meta = {}) {
  const settings = sanitizeSettings(settingsInput);
  const moves = Array.isArray(rawMoves) ? rawMoves : [];
  const events = [];
  let cursorBeat = 0;

  moves.forEach((move, index) => {
    const event = moveToEvent(settings, move, index + 1, cursorBeat);
    events.push(event);
    cursorBeat = Number((cursorBeat + event.durationBeats).toFixed(3));
  });

  const noteCount = events.reduce((sum, event) => sum + event.notes.length, 0);
  const captureCount = events.filter((event) => event.flags.capture).length;
  const checkCount = events.filter((event) => event.flags.check).length;
  const mateCount = events.filter((event) => event.flags.checkmate).length;
  const promotionCount = events.filter((event) => event.flags.promotion).length;
  const castleCount = events.filter((event) => event.flags.castle).length;
  const totalBeats = events.length ? events[events.length - 1].startBeat + events[events.length - 1].durationBeats : 0;
  const tailBeats = events.length ? 1.1 : 0;
  const beatCount = Number((totalBeats + tailBeats).toFixed(3));

  const finalFen = events.at(-1)?.boardFen || meta.startFen || "";
  return {
    schemaVersion: 1,
    id: meta.id || makeId(),
    title: createTitle(meta, moves.length),
    createdAt: meta.createdAt || new Date().toISOString(),
    settings,
    pgn: meta.pgn || "",
    startFen: meta.startFen || moves[0]?.before || "",
    finalFen,
    result: meta.result || (mateCount ? (moves.at(-1)?.color === "w" ? "1-0" : "0-1") : "*"),
    players: {
      white: meta.white || "White",
      black: meta.black || "Black",
      event: meta.event || "Casual composition",
      date: meta.date || "",
    },
    moves: events.map((event) => ({
      ply: event.ply,
      san: event.san,
      from: event.from,
      to: event.to,
      color: event.color,
      piece: event.piece,
      captured: event.captured,
      boardFen: event.boardFen,
      motif: event.motif,
    })),
    events,
    eventCount: events.length,
    noteCount,
    beatCount,
    secondsPerBeat: Number((60 / settings.tempo).toFixed(4)),
    durationSec: Number(((beatCount * 60) / settings.tempo).toFixed(2)),
    summary: {
      moves: events.length,
      captures: captureCount,
      checks: checkCount,
      checkmates: mateCount,
      promotions: promotionCount,
      castles: castleCount,
      whiteMoves: events.filter((event) => event.color === "w").length,
      blackMoves: events.filter((event) => event.color === "b").length,
      notes: noteCount,
      durationSec: Number(((beatCount * 60) / settings.tempo).toFixed(2)),
    },
  };
}

/**
 * Find the currently sounding event from a beat position. Binary search keeps
 * animation frames cheap even for very long games.
 */
export function eventIndexAtBeat(events, beat, includeTail = false) {
  if (!Array.isArray(events) || events.length === 0) return -1;
  if (!includeTail && beat < 0) return -1;
  if (beat >= events[events.length - 1].startBeat + events[events.length - 1].durationBeats) {
    return events.length - 1;
  }
  let low = 0;
  let high = events.length - 1;
  let result = 0;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (events[mid].startBeat <= beat) {
      result = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return result;
}

/**
 * Human-facing mapping preview used in the explainer panel. Returns one row
 * per board file so the player can see the exact notes in their current setup.
 */
export function getMappingPreview(settingsInput) {
  const settings = sanitizeSettings(settingsInput);
  const register = REGISTERS[settings.register] ?? REGISTERS.medium;
  return FILE_ORDER.map((file, index) => ({
    file,
    degree: index + 1,
    lowNote: midiToNoteName(
      clampMidi(scaleDegreeToMidi(settings, index, register.baseOctave), settings),
    ),
    highNote: midiToNoteName(
      clampMidi(scaleDegreeToMidi(settings, index, register.baseOctave + 1), settings),
    ),
  }));
}

export function describeSettingsFormula(settingsInput) {
  const settings = sanitizeSettings(settingsInput);
  const register = REGISTERS[settings.register];
  const scale = SCALES[settings.scale];
  return {
    root: settings.rootNote,
    scale: scale.label,
    intervals: scale.intervals,
    register: register.label,
    baseOctave: register.baseOctave,
    tempo: settings.tempo,
    rhythm: settings.rhythm,
  };
}
