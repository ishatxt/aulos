/**
 * Local-only persistence for CHESSOUND preferences and saved compositions.
 * Every method degrades gracefully when localStorage is unavailable or full,
 * returning a result object rather than breaking the app.
 */

import { STORAGE_KEYS, sanitizeSettings } from "./config.js";

const MAX_SAVED_COMPOSITIONS = 20;

function storageAvailable() {
  try {
    if (typeof window === "undefined" || !window.localStorage) return false;
    const key = "__chessound_probe__";
    window.localStorage.setItem(key, "1");
    window.localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

function readJson(key, fallback) {
  if (!storageAvailable()) return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  if (!storageAvailable()) {
    return { ok: false, error: "Local storage is unavailable in this browser context." };
  }
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return { ok: true };
  } catch (error) {
    const quota = error?.name === "QuotaExceededError" || error?.code === 22;
    return {
      ok: false,
      error: quota
        ? "Local storage is full. Remove a saved composition and try again."
        : "Preferences could not be saved in this browser.",
    };
  }
}

export function loadPreferences() {
  return sanitizeSettings(readJson(STORAGE_KEYS.preferences, {}));
}

export function savePreferences(settings) {
  return writeJson(STORAGE_KEYS.preferences, sanitizeSettings(settings));
}

function sanitiseRecord(record) {
  if (!record || typeof record !== "object") return null;
  if (typeof record.id !== "string" || typeof record.pgn !== "string" || !record.pgn.trim()) return null;
  return {
    id: record.id,
    title: typeof record.title === "string" && record.title.trim() ? record.title.slice(0, 120) : "Saved composition",
    pgn: record.pgn,
    settings: sanitizeSettings(record.settings),
    savedAt: typeof record.savedAt === "string" ? record.savedAt : new Date().toISOString(),
    createdAt: typeof record.createdAt === "string" ? record.createdAt : new Date().toISOString(),
    summary:
      record.summary && typeof record.summary === "object"
        ? {
            moves: Number(record.summary.moves) || 0,
            captures: Number(record.summary.captures) || 0,
            checks: Number(record.summary.checks) || 0,
            notes: Number(record.summary.notes) || 0,
            durationSec: Number(record.summary.durationSec) || 0,
          }
        : { moves: 0, captures: 0, checks: 0, notes: 0, durationSec: 0 },
  };
}

export function loadSavedCompositions() {
  const data = readJson(STORAGE_KEYS.compositions, []);
  if (!Array.isArray(data)) return [];
  return data
    .map(sanitiseRecord)
    .filter(Boolean)
    .sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)))
    .slice(0, MAX_SAVED_COMPOSITIONS);
}

/**
 * Save a compact record. The full note/event composition is intentionally not
 * stored: it is deterministically rebuilt from PGN + settings, saving space and
 * proving that the mapping is reproducible.
 */
export function saveComposition(record) {
  const clean = sanitiseRecord(record);
  if (!clean) return { ok: false, error: "This composition cannot be saved yet." };
  const existing = loadSavedCompositions().filter((item) => item.id !== clean.id);
  const updated = [clean, ...existing].slice(0, MAX_SAVED_COMPOSITIONS);
  const result = writeJson(STORAGE_KEYS.compositions, updated);
  return result.ok ? { ok: true, record: clean } : result;
}

export function removeComposition(id) {
  const updated = loadSavedCompositions().filter((item) => item.id !== id);
  const result = writeJson(STORAGE_KEYS.compositions, updated);
  return result.ok ? { ok: true } : result;
}

export function clearSavedCompositions() {
  return writeJson(STORAGE_KEYS.compositions, []);
}

export function saveAudioHintDismissed(value) {
  return writeJson(STORAGE_KEYS.audioHintDismissed, Boolean(value));
}

export function loadAudioHintDismissed() {
  return Boolean(readJson(STORAGE_KEYS.audioHintDismissed, false));
}

export { MAX_SAVED_COMPOSITIONS };
