/**
 * Share-code and local-storage tests. Storage is mocked with a tiny Map-backed
 * localStorage so the real persistence functions are exercised.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { buildShareUrl, decodeShareCode, encodeShareCode, readShareCodeFromLocation } from "../src/share.js";
import { DEFAULT_SETTINGS } from "../src/config.js";

function installLocalStorageMock() {
  const map = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (key) => (map.has(key) ? map.get(key) : null),
      setItem: (key, value) => {
        map.set(key, String(value));
      },
      removeItem: (key) => map.delete(key),
    },
  };
  return map;
}

const PGN = `1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 *`;

test("share code round-trips PGN, settings and unicode title", () => {
  const settings = {
    ...DEFAULT_SETTINGS,
    mode: "ambient",
    whiteVoice: "glass",
    blackVoice: "velvet",
    tempo: 52,
  };
  const code = encodeShareCode({ pgn: PGN, settings, title: "Nachtmusik — Café" });
  assert.match(code, /^CS1\./);
  const decoded = decodeShareCode(code);
  assert.equal(decoded.pgn, PGN);
  assert.equal(decoded.settings.mode, "ambient");
  assert.equal(decoded.settings.whiteVoice, "glass");
  assert.equal(decoded.title, "Nachtmusik — Café");
});

test("damaged or foreign share codes fail with a useful error", () => {
  assert.throws(() => decodeShareCode("https://example.com"), /not a CHESSOUND/i);
  assert.throws(() => decodeShareCode("CS1.not-base64-at-all"), /damaged|incomplete/i);
  assert.throws(() => decodeShareCode(""), /not a CHESSOUND/i);
});

test("share URLs use the hash and can be read back", () => {
  const code = encodeShareCode({ pgn: PGN, settings: DEFAULT_SETTINGS, title: "Test" });
  const url = buildShareUrl("https://example.test/chessound/", code);
  assert.ok(url.includes("#c="));
  const locationLike = {
    search: "",
    hash: new URL(url).hash,
  };
  assert.equal(readShareCodeFromLocation(locationLike), code);
});

test("preferences and compact compositions persist through the storage layer", async () => {
  installLocalStorageMock();
  const storage = await import(`../src/storage.js?test=${Date.now()}`);
  const preferenceResult = storage.savePreferences({
    ...DEFAULT_SETTINGS,
    mode: "minimal",
    tempo: 96,
    masterVolume: 99,
  });
  assert.equal(preferenceResult.ok, true);
  const preferences = storage.loadPreferences();
  assert.equal(preferences.mode, "minimal");
  assert.equal(preferences.tempo, 96);
  assert.equal(preferences.masterVolume, 1);
  assert.equal(preferences.whiteVoice, DEFAULT_SETTINGS.whiteVoice);

  const record = {
    id: "composition-1",
    title: "Saved study",
    pgn: PGN,
    settings: preferences,
    summary: { moves: 6, captures: 0, checks: 0, notes: 9, durationSec: 12 },
  };
  const saved = storage.saveComposition(record);
  assert.equal(saved.ok, true);
  const loaded = storage.loadSavedCompositions();
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].title, "Saved study");
  assert.equal(loaded[0].settings.mode, "minimal");
  const removed = storage.removeComposition("composition-1");
  assert.equal(removed.ok, true);
  assert.equal(storage.loadSavedCompositions().length, 0);
});
