/**
 * Deterministic engine regression tests. These run in plain Node with the
 * built-in test runner and do not require a browser audio context.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { Chess } from "chess.js";
import {
  buildComposition,
  destinationPitch,
  getMappingPreview,
  moveToEvent,
  scaleDegreeToMidi,
} from "../src/music-mapping.js";
import { DEFAULT_SETTINGS, MODES, START_FEN, sanitizeSettings } from "../src/config.js";

function movesFromPgn(pgn) {
  const chess = new Chess();
  chess.loadPgn(pgn);
  return chess.history({ verbose: true });
}

function buildFromPgn(pgn, overrides = {}) {
  const moves = movesFromPgn(pgn);
  const settings = sanitizeSettings({ ...DEFAULT_SETTINGS, ...overrides });
  return buildComposition(moves, settings, { pgn, id: "test-composition", createdAt: "2026-01-01T00:00:00.000Z" });
}

const SCHOLARS_MATE = `[Event "Test"]
[White "Analyst"]
[Black "Composer"]
[Result "1-0"]

1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0`;

test("destination squares map files to degrees and ranks to registers", () => {
  const settings = sanitizeSettings({
    ...DEFAULT_SETTINGS,
    rootNote: "C",
    scale: "major",
    register: "medium",
    whiteVoice: "ivory",
    blackVoice: "onyx",
  });

  const a1 = destinationPitch(settings, "a1", "p", "w");
  const h8 = destinationPitch(settings, "h8", "p", "w");
  const h8Black = destinationPitch(settings, "h8", "p", "b");

  assert.equal(a1.note, "C4");
  assert.equal(a1.scaleDegree, 0);
  assert.equal(a1.upperHalf, 0);
  assert.equal(h8.note, "C6");
  assert.equal(h8.scaleDegree, 7);
  assert.equal(h8.upperHalf, 1);
  assert.ok(h8Black.midi < h8.midi);
  assert.notEqual(h8Black.voiceId, h8.voiceId);
});

test("colour shift alone lowers Black by one octave when voices share a register", () => {
  const settings = sanitizeSettings({
    ...DEFAULT_SETTINGS,
    whiteVoice: "pulse",
    blackVoice: "pulse",
    register: "medium",
  });
  const white = destinationPitch(settings, "h8", "p", "w");
  const black = destinationPitch(settings, "h8", "p", "b");
  assert.equal(white.midi - black.midi, 12);
});

test("every legal move in a complete game generates at least one audible note", () => {
  const composition = buildFromPgn(SCHOLARS_MATE);
  assert.equal(composition.events.length, 7);
  assert.equal(composition.summary.moves, 7);
  assert.ok(composition.events.every((event) => event.notes.length >= 1));
  assert.ok(composition.events.every((event) => event.notes.every((note) => note.frequency >= 20)));
  assert.equal(composition.events.at(-1).san, "Qxf7#");
  assert.equal(composition.events.at(-1).flags.checkmate, true);
  assert.ok(composition.events.at(-1).notes.length >= 6, "checkmate should include a cadence");
  assert.ok(composition.events.at(-1).durationBeats > 4);
});

test("same moves and settings reproduce identical notes and event timing", () => {
  const first = buildFromPgn(SCHOLARS_MATE);
  const second = buildFromPgn(SCHOLARS_MATE, { id: "ignored" });
  assert.deepEqual(first.events, second.events);
  assert.deepEqual(first.summary, second.summary);
  assert.equal(first.beatCount, second.beatCount);
});

test("changing scale should change the pitch mapping but keep range safe", () => {
  const major = buildFromPgn(SCHOLARS_MATE, { scale: "major" });
  const minor = buildFromPgn(SCHOLARS_MATE, { scale: "naturalMinor" });
  const majorSignature = major.events.map((event) => event.baseNote.midi).join(",");
  const minorSignature = minor.events.map((event) => event.baseNote.midi).join(",");
  assert.notEqual(majorSignature, minorSignature);
  for (const note of minor.events.flatMap((event) => event.notes)) {
    assert.ok(note.midi >= 24 && note.midi <= 108);
  }
});

test("checks add a tension motif without doubling every note", () => {
  const pgn = `1. e4 d5 2. Bb5+ c6 3. Ba4`;
  const composition = buildFromPgn(pgn);
  const checkEvent = composition.events.find((event) => event.flags.check);
  assert.ok(checkEvent, "expected a checking move");
  assert.ok(checkEvent.notes.some((note) => note.role === "tension"));
  assert.ok(checkEvent.notes.length > 1);
});

test("castling produces a special roll and retains the destination voice", () => {
  const pgn = `1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. O-O Nf6 5. d3 O-O`;
  const composition = buildFromPgn(pgn);
  const castles = composition.events.filter((event) => event.flags.castle);
  assert.equal(castles.length, 2);
  for (const castle of castles) {
    assert.ok(castle.notes.some((note) => note.role === "flourish"));
    assert.ok(castle.notes.some((note) => note.role === "base"));
  }
});

test("promotions create a rising flourish and honour the effect toggle", () => {
  const move = {
    san: "e8=Q+",
    from: "e7",
    to: "e8",
    piece: "p",
    color: "w",
    flags: "p",
    after: START_FEN,
  };
  const withFlourish = moveToEvent(DEFAULT_SETTINGS, move, 1, 0);
  assert.ok(withFlourish.flags.promotion);
  assert.ok(withFlourish.notes.filter((note) => note.role === "flourish").length >= 3);

  const withoutFlourish = moveToEvent(
    { ...DEFAULT_SETTINGS, effectPromotions: false },
    move,
    1,
    0,
  );
  assert.equal(withoutFlourish.notes.filter((note) => note.role === "flourish").length, 0);
});

test("all five modes are deterministic and produce distinct timbres", () => {
  const voiceSets = new Set();
  for (const mode of Object.values(MODES)) {
    const composition = buildFromPgn(SCHOLARS_MATE, {
      mode: mode.id,
      scale: mode.scale,
      tempo: mode.tempo,
      whiteVoice: mode.whiteVoice,
      blackVoice: mode.blackVoice,
      rhythm: mode.rhythm,
    });
    const signature = composition.events
      .flatMap((event) => event.notes.map((note) => `${note.voiceId}:${note.midi}:${note.offset}`))
      .join("|");
    voiceSets.add(signature);
    assert.ok(composition.durationSec > 0);
  }
  assert.equal(voiceSets.size, Object.keys(MODES).length);
});

test("mapping preview follows the selected root and register", () => {
  const preview = getMappingPreview({
    ...DEFAULT_SETTINGS,
    rootNote: "A",
    scale: "naturalMinor",
    register: "low",
  });
  assert.equal(preview.length, 8);
  assert.equal(preview[0].file, "a");
  assert.equal(preview[0].lowNote, "A3");
  assert.equal(preview[7].highNote, "A5");
});

test("safe clamping keeps extreme settings inside the MIDI range", () => {
  const settings = sanitizeSettings({
    ...DEFAULT_SETTINGS,
    register: "high",
    whiteVoice: "glass",
    scale: "chromatic",
  });
  const midi = scaleDegreeToMidi(settings, 100, 10);
  assert.ok(midi > 108);
  const composition = buildFromPgn(SCHOLARS_MATE, settings);
  const allNotes = composition.events.flatMap((event) => event.notes);
  assert.ok(allNotes.length > 0);
  assert.ok(allNotes.every((note) => note.midi >= 24 && note.midi <= 108));
  assert.ok(allNotes.every((note) => note.frequency > 0));
});

test("an empty game produces a valid, zero-duration composition", () => {
  const composition = buildComposition([], DEFAULT_SETTINGS, {
    pgn: "",
    startFen: START_FEN,
  });
  assert.equal(composition.events.length, 0);
  assert.equal(composition.durationSec, 0);
  assert.equal(composition.summary.notes, 0);
});
