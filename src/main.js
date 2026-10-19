/**
 * CHESSOUND application shell.
 *
 * The app deliberately keeps three sources of truth separate:
 *   • ChessGame owns the rules and the mainline.
 *   • buildComposition deterministically derives every note from that mainline.
 *   • CompositionPlayer owns musical time and schedules audio from the same
 *     note objects used by the offline WAV exporter.
 *
 * This file coordinates those layers, the board view, the analyser visualiser
 * and every piece of studio UI. There is no server component.
 */

import "@fontsource-variable/newsreader";
import "@fontsource-variable/newsreader/wght-italic.css";
import "@fontsource-variable/manrope";
import "@fontsource-variable/jetbrains-mono";
import "./styles.css";

import { Chess } from "chess.js";
import {
  DEFAULT_SETTINGS,
  MODES,
  PIECE_GLYPHS,
  PIECE_PROFILES,
  REGISTERS,
  RHYTHMS,
  ROOT_NOTES,
  SCALES,
  VOICE_PRESETS,
  applyModePreset,
  sanitizeSettings,
} from "./config.js";
import {
  MAPPING_RULES,
  buildComposition,
  describeSettingsFormula,
  getMappingPreview,
} from "./music-mapping.js";
import { ChessGame } from "./chess-game.js";
import { AudioEngine } from "./audio-engine.js";
import { CompositionPlayer } from "./composition-player.js";
import { BoardView } from "./board-view.js";
import { Visualizer } from "./visualizer.js";
import {
  MAX_DURATION_SECONDS,
  estimateWavDuration,
  renderCompositionToWav,
} from "./wav-export.js";
import {
  loadPreferences,
  loadSavedCompositions,
  removeComposition,
  saveComposition,
  savePreferences,
} from "./storage.js";
import {
  buildShareUrl,
  decodeShareCode,
  encodeShareCode,
  readShareCodeFromLocation,
} from "./share.js";

/* --------------------------------------------------------------------------
   Utilities
   -------------------------------------------------------------------------- */

const $ = (id) => document.getElementById(id);

const DEMO_PGN = `[Event "Legal's Mate — a short study"]
[Site "CHESSOUND studio"]
[Date "2026.10.19"]
[Round "-"]
[White "The Student"]
[Black "The Trap"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 3. Bc4 d6 4. Nc3 Bg4 5. Nxe5 Bxd1 6. Bxf7+ Ke7 7. Nd5# 1-0`;

const MOTIF_GLYPHS = {
  mate: "✦",
  check: "⚠",
  capture: "◇",
  promotion: "↑",
  castle: "⇄",
  plain: "♪",
};

const TONE_BY_MOTIF = {
  mate: "promotion",
  check: "check",
  capture: "capture",
  promotion: "promotion",
  castle: "castle",
  plain: "plain",
};

function pad(value) {
  return String(value).padStart(2, "0");
}

function formatTime(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const rounded = Math.round(safe);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const secs = rounded % 60;
  return hours ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
}

function plural(count, singular, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function makeId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `comp-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function slugify(value, fallback = "chessound-composition") {
  const slug = String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
  return slug || fallback;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function currentDisplayTitle(composition = state.composition) {
  if (!composition) return "CHESSOUND";
  if (composition.eventCount === 0) {
    return `${composition.players?.white || "White"} vs ${composition.players?.black || "Black"}`;
  }
  return composition.title || "Untitled composition";
}

function findKingSquare(chess) {
  for (const row of chess.board()) {
    for (const piece of row) {
      if (piece && piece.type === "k" && piece.color === chess.turn()) {
        return piece.square;
      }
    }
  }
  return null;
}

function clipText(value, max = 90) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/* --------------------------------------------------------------------------
   Application state and DOM references
   -------------------------------------------------------------------------- */

const state = {
  settings: loadPreferences(),
  game: new ChessGame(),
  composition: null,
  compositionId: makeId(),
  compositionCreatedAt: new Date().toISOString(),
  compositionTitle: "",
  sourceLabel: "Local session",
  orientation: "w",
  reviewing: false,
  audioBusy: false,
  audioError: "",
  audioHintShown: false,
  displayPly: 0,
  lastRenderedPly: -1,
  activeSquare: null,
  nowEvent: null,
  effectTimer: null,
  interruptedNotified: false,
  liveTimer: null,
  pendingConfirm: null,
  exportBusy: false,
  savedCount: 0,
};

let audio = null;
let player = null;
let boardView = null;
let visualizer = null;
let settingsSaveTimer = null;
let lastPlayerEventIndex = -999;
let scrolledScorePly = -1;
let scrolledTimelineIndex = -1;

const dom = {
  // Header
  audioButton: $("audio-button"),
  audioLabel: $("audio-label"),
  audioSublabel: $("audio-sublabel"),
  audioLed: $("audio-led"),
  importButton: $("import-button"),
  libraryButton: $("library-button"),
  libraryCount: $("library-count"),
  settingsButton: $("settings-button"),

  // Session
  statusLed: $("status-led"),
  sessionSource: $("session-source"),
  compositionTitle: $("composition-title"),
  compositionSubtitle: $("composition-subtitle"),
  compositionDuration: $("composition-duration"),
  currentModeLabel: $("current-mode-label"),
  mappingButton: $("mapping-button"),

  // Board
  boardPanel: $("board-panel"),
  gameStatus: $("game-status"),
  gameStatusDetail: $("game-status-detail"),
  turnPip: $("turn-pip"),
  reviewChip: $("review-chip"),
  playbackChip: $("playback-chip"),
  board: $("board"),
  boardEffect: $("board-effect"),
  boardEffectGlyph: $("board-effect-glyph"),
  boardEffectLabel: $("board-effect-label"),
  whitePlayerName: $("white-player-name"),
  whiteVoiceName: $("white-voice-name"),
  blackPlayerName: $("black-player-name"),
  blackVoiceName: $("black-voice-name"),
  newGameButton: $("new-game-button"),
  undoButton: $("undo-button"),
  flipButton: $("flip-button"),
  resetPositionButton: $("reset-position-button"),
  viewStartButton: $("view-start-button"),
  viewPrevButton: $("view-prev-button"),
  viewNextButton: $("view-next-button"),
  viewEndButton: $("view-end-button"),
  plyCounter: $("ply-counter"),
  returnLiveButton: $("return-live-button"),

  // Score
  scoreMeta: $("score-meta"),
  moveList: $("move-list"),
  notationForm: $("notation-form"),
  notationInput: $("notation-input"),

  // Sound
  modeTabs: $("mode-tabs"),
  modeDescription: $("mode-description"),
  audioState: $("audio-state"),
  nowPanel: $("now-panel"),
  nowKicker: document.querySelector(".now-kicker"),
  nowNote: $("now-note"),
  nowDetail: $("now-detail"),
  nowPieceGlyph: $("now-piece-glyph"),
  nowVoice: $("now-voice"),
  visualizer: $("visualizer"),
  visualizerOverlay: $("visualizer-overlay"),
  analyserReadout: $("analyser-readout"),
  timbreReadout: $("timbre-readout"),
  pianoShell: $("piano-shell"),
  piano: $("piano"),
  pianoNoteReadout: $("piano-note-readout"),
  insightMessage: $("insight-message"),
  insightList: $("insight-list"),
  insightOpenButton: $("insight-open-button"),

  // Transport
  transportStatus: $("transport-status"),
  transportEventIndex: $("transport-event-index"),
  playerStartButton: $("player-start-button"),
  playerPrevButton: $("player-prev-button"),
  playerPlayButton: $("player-play-button"),
  playerNextButton: $("player-next-button"),
  playerStopButton: $("player-stop-button"),
  compositionProgress: $("composition-progress"),
  elapsedTime: $("elapsed-time"),
  progressEventLabel: $("progress-event-label"),
  totalTime: $("total-time"),
  playerTempo: $("player-tempo"),
  playerTempoOutput: $("player-tempo-output"),

  // Summary
  summaryMoves: $("summary-moves"),
  summaryCaptures: $("summary-captures"),
  summaryChecks: $("summary-checks"),
  summaryDuration: $("summary-duration"),

  // Mapping panel
  mappingDetails: $("mapping-details"),
  mappingMiniGrid: $("mapping-mini-grid"),
  mappingGuideButton: $("mapping-guide-button"),

  // Timeline
  timelineMeta: $("timeline-meta"),
  timelineScroll: $("timeline-scroll"),
  timelineEvents: $("timeline-events"),
  timelineSummary: $("timeline-summary"),

  // Actions
  saveButton: $("save-button"),
  shareButton: $("share-button"),
  pgnButton: $("pgn-button"),
  wavButton: $("wav-button"),

  // Dialogs
  importDialog: $("import-dialog"),
  importError: $("import-error"),
  pgnFile: $("pgn-file"),
  fileDropLabel: $("file-drop-label"),
  pgnInput: $("pgn-input"),
  loadDemoButton: $("load-demo-button"),
  importSubmitButton: $("import-submit-button"),

  settingsDialog: $("settings-dialog"),
  settingMode: $("setting-mode"),
  settingRhythm: $("setting-rhythm"),
  settingRoot: $("setting-root"),
  settingScale: $("setting-scale"),
  settingRegister: $("setting-register"),
  settingTempo: $("setting-tempo"),
  settingTempoOutput: $("setting-tempo-output"),
  settingWhiteVoice: $("setting-white-voice"),
  settingBlackVoice: $("setting-black-voice"),
  settingNoteLength: $("setting-note-length"),
  settingNoteLengthOutput: $("setting-note-length-output"),
  settingIntensity: $("setting-intensity"),
  settingIntensityOutput: $("setting-intensity-output"),
  settingVolume: $("setting-volume"),
  settingVolumeOutput: $("setting-volume-output"),
  settingReverb: $("setting-reverb"),
  settingReverbOutput: $("setting-reverb-output"),
  effectCaptures: $("effect-captures"),
  effectChecks: $("effect-checks"),
  effectPromotions: $("effect-promotions"),
  effectCheckmate: $("effect-checkmate"),
  visualWaveform: $("visual-waveform"),
  visualPiano: $("visual-piano"),
  settingReducedMotion: $("setting-reduced-motion"),
  settingAutoscroll: $("setting-autoscroll"),
  restoreDefaultsButton: $("restore-defaults-button"),

  libraryDialog: $("library-dialog"),
  libraryList: $("library-list"),

  saveDialog: $("save-dialog"),
  saveTitleInput: $("save-title-input"),
  savePreview: $("save-preview"),
  saveError: $("save-error"),
  saveConfirmButton: $("save-confirm-button"),

  shareDialog: $("share-dialog"),
  shareUrlInput: $("share-url-input"),
  copyShareButton: $("copy-share-button"),
  shareError: $("share-error"),

  mappingGuideDialog: $("mapping-guide-dialog"),
  mappingGuideContent: $("mapping-guide-content"),

  confirmDialog: $("confirm-dialog"),
  confirmDialogTitle: $("confirm-dialog-title"),
  confirmDialogMessage: $("confirm-dialog-message"),
  confirmActionButton: $("confirm-action-button"),

  exportOverlay: $("export-overlay"),
  exportTitle: $("export-title"),
  exportMessage: $("export-message"),
  exportProgressBar: $("export-progress-bar"),
  exportProgressLabel: $("export-progress-label"),
  exportDetail: $("export-detail"),
  exportCloseButton: $("export-close-button"),

  toastRegion: $("toast-region"),
  liveRegion: $("live-region"),
};

/* --------------------------------------------------------------------------
   Messaging and dialog helpers
   -------------------------------------------------------------------------- */

function showToast(message, { tone = "info", duration = 4200 } = {}) {
  if (!dom.toastRegion) return;
  const toast = document.createElement("div");
  toast.className = `toast${tone === "error" ? " is-error" : tone === "success" ? " is-success" : ""}`;
  toast.setAttribute("role", tone === "error" ? "alert" : "status");

  const icon = document.createElement("span");
  icon.className = "toast-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = tone === "error" ? "!" : tone === "success" ? "✓" : "♪";

  const copy = document.createElement("span");
  copy.textContent = message;
  toast.append(icon, copy);
  dom.toastRegion.appendChild(toast);

  while (dom.toastRegion.children.length > 4) {
    dom.toastRegion.firstElementChild?.remove();
  }

  window.setTimeout(() => {
    toast.classList.add("is-leaving");
    window.setTimeout(() => toast.remove(), 190);
  }, duration);
}

function announce(message) {
  if (!dom.liveRegion) return;
  dom.liveRegion.textContent = "";
  window.setTimeout(() => {
    dom.liveRegion.textContent = message;
  }, 30);
}

function openDialog(dialog) {
  if (!dialog || dialog.open) return;
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}

function closeDialog(dialog) {
  if (!dialog?.open) return;
  dialog.close();
}

function setDialogError(element, message = "") {
  if (!element) return;
  element.textContent = message;
  element.hidden = !message;
}

function openConfirm({ title, message, label = "Confirm", danger = false, onConfirm }) {
  if (player?.playing) player.pause();
  dom.confirmDialogTitle.textContent = title;
  dom.confirmDialogMessage.textContent = message;
  dom.confirmActionButton.textContent = label;
  dom.confirmActionButton.classList.toggle("danger", danger);
  state.pendingConfirm = typeof onConfirm === "function" ? onConfirm : null;
  openDialog(dom.confirmDialog);
}

/* --------------------------------------------------------------------------
   Range controls
   -------------------------------------------------------------------------- */

function updateRangeFill(input) {
  if (!input) return;
  const min = Number(input.min) || 0;
  const max = Number(input.max) || 100;
  const value = Number(input.value) || 0;
  const percent = max > min ? ((value - min) / (max - min)) * 100 : 0;
  input.style.setProperty("--range-progress", `${Math.min(100, Math.max(0, percent))}%`);
}

function bindRangeFill(input) {
  if (!input) return;
  updateRangeFill(input);
  input.addEventListener("input", () => updateRangeFill(input));
}

/* --------------------------------------------------------------------------
   Audio lifecycle
   -------------------------------------------------------------------------- */

function audioRunning() {
  return Boolean(audio?.ready && audio.state === "running");
}

function visualizerSettings() {
  visualizer?.setReducedMotion(state.settings.reduceMotion);
  visualizer?.setShowWaveform(state.settings.showWaveform);
  visualizer?.setShowPiano(state.settings.showPiano);
  visualizer?.setAudioReady(audioRunning());
}

function updateAudioUI() {
  const supported = audio?.supported !== false;
  const running = audioRunning();
  const hasContext = Boolean(audio?.ready);
  const suspended = hasContext && audio.state === "suspended";

  dom.audioButton?.setAttribute("aria-pressed", String(running));
  dom.audioButton?.setAttribute("aria-busy", String(state.audioBusy));
  if (dom.audioButton) {
    dom.audioButton.title = running ? "Mute sound" : "Enable sound";
  }

  if (!supported) {
    if (dom.audioLabel) dom.audioLabel.textContent = "Audio unavailable";
    if (dom.audioSublabel) dom.audioSublabel.textContent = "Web Audio is not supported";
    if (dom.audioState) dom.audioState.innerHTML = "<span></span> Unsupported";
    dom.audioState?.classList.add("is-warning");
  } else if (state.audioBusy) {
    if (dom.audioLabel) dom.audioLabel.textContent = "Starting audio…";
    if (dom.audioSublabel) dom.audioSublabel.textContent = "Waking the synthesizer";
    if (dom.audioState) dom.audioState.innerHTML = "<span></span> Starting";
    dom.audioState?.classList.remove("is-warning");
  } else if (running) {
    if (dom.audioLabel) dom.audioLabel.textContent = "Sound on";
    if (dom.audioSublabel) dom.audioSublabel.textContent = "Click to mute";
    if (dom.audioState) dom.audioState.innerHTML = "<span></span> Live · stereo";
    dom.audioState?.classList.remove("is-warning");
    dom.audioState?.classList.add("is-live");
  } else if (state.audioError) {
    if (dom.audioLabel) dom.audioLabel.textContent = "Retry sound";
    if (dom.audioSublabel) dom.audioSublabel.textContent = "Audio could not start";
    if (dom.audioState) dom.audioState.innerHTML = "<span></span> Blocked";
    dom.audioState?.classList.remove("is-live");
    dom.audioState?.classList.add("is-warning");
  } else if (suspended) {
    if (dom.audioLabel) dom.audioLabel.textContent = "Resume sound";
    if (dom.audioSublabel) dom.audioSublabel.textContent = "Audio is suspended";
    if (dom.audioState) dom.audioState.innerHTML = "<span></span> Suspended";
    dom.audioState?.classList.remove("is-live");
    dom.audioState?.classList.add("is-warning");
  } else {
    if (dom.audioLabel) dom.audioLabel.textContent = "Enable sound";
    if (dom.audioSublabel) dom.audioSublabel.textContent = "Synthesized locally";
    if (dom.audioState) dom.audioState.innerHTML = "<span></span> Standby";
    dom.audioState?.classList.remove("is-live", "is-warning");
  }

  dom.audioState?.classList.toggle("is-live", running);
  if (!running && !state.audioError && !suspended) dom.audioState?.classList.remove("is-warning");

  if (visualizer) visualizer.setAudioReady(running);
}

async function ensureAudio({ announceEnabled = false } = {}) {
  if (!audio) return false;
  if (!audio.supported) {
    state.audioError = "Web Audio is not available in this browser.";
    updateAudioUI();
    showToast("This browser does not support the Web Audio API. Please try a recent browser.", {
      tone: "error",
    });
    return false;
  }
  if (audioRunning()) return true;
  if (state.audioBusy) return false;

  state.audioBusy = true;
  state.audioError = "";
  updateAudioUI();
  try {
    await audio.enable(state.settings);
    state.audioBusy = false;
    updateAudioUI();
    visualizerSettings();
    if (announceEnabled) {
      showToast("Sound enabled. Every note is synthesized in this browser.", { tone: "success" });
      announce("Sound enabled.");
    }
    return true;
  } catch (error) {
    console.error("Audio could not start", error);
    state.audioBusy = false;
    state.audioError = error?.message || "Audio could not start.";
    updateAudioUI();
    showToast(
      "Audio could not start. Check the browser's sound permissions, then try again.",
      { tone: "error", duration: 6000 },
    );
    return false;
  }
}

async function toggleAudio() {
  if (!audio) return;
  if (!audio.supported) {
    showToast("This browser does not support the Web Audio API.", { tone: "error" });
    return;
  }
  if (!audio.ready) {
    await ensureAudio({ announceEnabled: true });
    return;
  }
  if (audioRunning()) {
    try {
      await audio.suspend();
      updateAudioUI();
      showToast("Sound muted. Your composition is still here.");
      announce("Sound muted.");
    } catch (error) {
      console.error("Could not suspend audio", error);
    }
    return;
  }
  try {
    await audio.resume();
    state.audioError = "";
    updateAudioUI();
    visualizerSettings();
    showToast("Sound resumed.", { tone: "success" });
    announce("Sound resumed.");
  } catch (error) {
    console.error("Could not resume audio", error);
    showToast("Audio could not resume. Try clicking Enable sound again.", { tone: "error" });
  }
}

/* --------------------------------------------------------------------------
   Composition construction
   -------------------------------------------------------------------------- */

function compositionMeta() {
  const meta = state.game.toCompositionMeta();
  return {
    ...meta,
    id: state.compositionId,
    createdAt: state.compositionCreatedAt,
    title: state.compositionTitle || undefined,
  };
}

function buildCurrentComposition() {
  return buildComposition(state.game.moves, state.settings, compositionMeta());
}

function updateCompositionTiming() {
  if (!state.composition) return;
  const tempo = Number(state.settings.tempo) || DEFAULT_SETTINGS.tempo;
  const secondsPerBeat = 60 / tempo;
  state.composition.settings = { ...state.settings };
  state.composition.secondsPerBeat = Number(secondsPerBeat.toFixed(4));
  state.composition.durationSec = Number(
    (state.composition.beatCount * secondsPerBeat).toFixed(2),
  );
  if (state.composition.summary) {
    state.composition.summary.durationSec = state.composition.durationSec;
  }
}

/**
 * Rebuild the note field for the current mainline. When `preservePlayback` is
 * true the player returns to the same musical beat and keeps playing if it was
 * already playing, which makes settings changes feel live rather than destructive.
 */
async function rebuildComposition({ preservePlayback = false, syncPlayer = true } = {}) {
  const snapshot = player?.getSnapshot();
  const wasPlaying = Boolean(preservePlayback && snapshot?.playing);
  const beat = preservePlayback ? snapshot?.beat ?? 0 : 0;

  const next = buildCurrentComposition();
  state.composition = next;
  state.lastCompositionRebuild = Date.now();

  if (player && syncPlayer) {
    player.load(next, { emit: false });
    if (preservePlayback) {
      const safeBeat = Math.min(beat, next.beatCount);
      player.seek(safeBeat, { keepPlaying: false });
      lastPlayerEventIndex = -999;
      if (wasPlaying) {
        await player.play();
      } else {
        renderTransport(player.getSnapshot());
      }
    } else {
      renderTransport(player.getSnapshot());
    }
  }

  renderCompositionSummary();
  renderTimeline();
  renderScore();
  renderSession();
  renderMappingPreview();
  renderTransport(player?.getSnapshot());
  return next;
}

function beatForPly(ply) {
  if (!state.composition?.events?.length) return 0;
  if (ply <= 0) return 0;
  const event = state.composition.events[Math.min(ply - 1, state.composition.events.length - 1)];
  return event?.startBeat ?? 0;
}

function plyForBeat(beat) {
  const events = state.composition?.events ?? [];
  if (!events.length || beat <= 0.0005) return 0;
  if (beat >= state.composition.beatCount - 0.0005) return events.length;
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
  return result + 1;
}

/* --------------------------------------------------------------------------
   Studio rendering
   -------------------------------------------------------------------------- */

function renderModeTabs() {
  if (!dom.modeTabs || dom.modeTabs.children.length) return;
  const fragment = document.createDocumentFragment();
  for (const mode of Object.values(MODES)) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mode-tab";
    button.dataset.mode = mode.id;
    button.textContent = mode.label;
    button.title = mode.description;
    button.setAttribute("aria-pressed", "false");
    button.addEventListener("click", () => applyMode(mode.id));
    fragment.appendChild(button);
  }
  dom.modeTabs.replaceChildren(fragment);
}

function renderSession() {
  const composition = state.composition;
  const settings = state.settings;
  if (!composition) return;
  const displayTitle = currentDisplayTitle(composition);
  const mode = MODES[settings.mode] ?? MODES.classical;
  const scale = SCALES[settings.scale] ?? SCALES.major;
  const register = REGISTERS[settings.register] ?? REGISTERS.medium;

  dom.compositionTitle.textContent = displayTitle;
  dom.compositionSubtitle.textContent = `${settings.rootNote} ${scale.short} · ${register.label} · ${RHYTHMS[settings.rhythm]?.label ?? "Flowing"}`;
  dom.compositionDuration.textContent = `${plural(composition.eventCount, "move")} · ${formatTime(composition.durationSec)}`;
  dom.sessionSource.textContent = state.sourceLabel;
  dom.currentModeLabel.textContent = mode.label;
  dom.modeDescription.textContent = mode.subtitle;
  dom.modeDescription.title = mode.description;

  const meta = state.game.getPlayerMeta();
  dom.whitePlayerName.textContent = meta.white;
  dom.blackPlayerName.textContent = meta.black;
  dom.whiteVoiceName.textContent =
    VOICE_PRESETS[settings.whiteVoice]?.label ?? VOICE_PRESETS.ivory.label;
  dom.blackVoiceName.textContent =
    VOICE_PRESETS[settings.blackVoice]?.label ?? VOICE_PRESETS.onyx.label;

  document.title = `${displayTitle} — CHESSOUND`;

  for (const button of dom.modeTabs.querySelectorAll(".mode-tab")) {
    button.setAttribute("aria-pressed", String(button.dataset.mode === settings.mode));
  }

  dom.whiteVoiceName.title = VOICE_PRESETS[settings.whiteVoice]?.description ?? "";
  dom.blackVoiceName.title = VOICE_PRESETS[settings.blackVoice]?.description ?? "";
}

function renderCompositionSummary() {
  const composition = state.composition;
  if (!composition) return;
  const summary = composition.summary;
  dom.summaryMoves.textContent = String(summary.moves);
  dom.summaryCaptures.textContent = String(summary.captures);
  dom.summaryChecks.textContent = String(summary.checks);
  dom.summaryDuration.textContent = formatTime(composition.durationSec);

  dom.scoreMeta.textContent = `${plural(summary.moves, "move")} · ${plural(summary.notes, "note")}`;
  dom.timelineMeta.textContent = composition.eventCount
    ? `${plural(composition.eventCount, "event")} · ${plural(summary.notes, "note")}`
    : "One event for every legal move";
  dom.timelineSummary.textContent = composition.eventCount
    ? `${plural(summary.moves, "move")} become ${plural(summary.notes, "note")} · ${summary.captures} capture${summary.captures === 1 ? "" : "s"} · ${summary.checks} check${summary.checks === 1 ? "" : "s"} · ${formatTime(composition.durationSec)}`
    : "Every destination, piece, capture and check is mapped to sound.";

  const hasMoves = composition.eventCount > 0;
  for (const button of [dom.saveButton, dom.shareButton, dom.pgnButton, dom.wavButton]) {
    if (button) button.disabled = !hasMoves;
  }
}

function renderTimeline() {
  const events = state.composition?.events ?? [];
  if (!events.length) {
    const empty = document.createElement("div");
    empty.className = "timeline-empty";
    empty.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#icon-wave"></use></svg><span>Play the first move and its note will appear here.</span>';
    dom.timelineEvents.replaceChildren(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const [index, event] of events.entries()) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `timeline-event is-${event.color}`;
    if (event.motifClass !== "plain") button.classList.add("is-special");
    button.dataset.eventIndex = String(index);
    button.style.setProperty("--beats", String(event.durationBeats));
    button.setAttribute(
      "aria-label",
      `Move ${event.makeMoveNumber ?? event.moveNumber}, ${event.color === "w" ? "White" : "Black"} plays ${event.san}. ${event.motif}. Notes ${event.noteNames.slice(0, 4).join(", ")}.`,
    );

    const top = document.createElement("span");
    top.className = "timeline-event-top";
    const number = document.createElement("span");
    number.textContent = `${event.moveNumber}${event.color === "w" ? "." : "…"}`;
    const san = document.createElement("b");
    san.textContent = event.san;
    top.append(number, san);

    const notes = document.createElement("span");
    notes.className = "timeline-event-note";
    notes.textContent = event.noteNames.slice(0, 2).join(" · ");

    const motif = document.createElement("span");
    motif.className = "timeline-event-motif";
    motif.textContent = event.motif;

    button.append(top, notes, motif);
    fragment.appendChild(button);
  }
  dom.timelineEvents.replaceChildren(fragment);
  dom.timelineScroll.scrollLeft = 0;
}

function renderScore() {
  const moves = state.composition?.moves ?? [];
  if (!moves.length) {
    const empty = document.createElement("div");
    empty.className = "empty-score";
    const title = document.createElement("strong");
    title.textContent = "A silent opening";
    const copy = document.createElement("span");
    copy.textContent = "Make a move to write the first bar of the score.";
    empty.append(title, copy);
    dom.moveList.replaceChildren(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  const rowCount = Math.ceil(moves.length / 2);
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const white = moves[rowIndex * 2];
    const black = moves[rowIndex * 2 + 1];
    const row = document.createElement("div");
    row.className = "move-row";
    row.setAttribute("role", "listitem");

    const number = document.createElement("span");
    number.className = "move-number";
    number.textContent = `${rowIndex + 1}.`;
    row.appendChild(number);

    for (const event of [white, black]) {
      if (!event) {
        const placeholder = document.createElement("span");
        placeholder.className = "move-placeholder";
        placeholder.textContent = "…";
        row.appendChild(placeholder);
        continue;
      }
      const button = document.createElement("button");
      button.type = "button";
      button.className = "move-cell";
      button.dataset.ply = String(event.ply);
      button.setAttribute(
        "aria-label",
        `Move ${Math.ceil(event.ply / 2)}, ${event.color === "w" ? "White" : "Black"} plays ${event.san}. ${event.motif}.`,
      );
      const san = document.createElement("span");
      san.textContent = event.san;
      const motif = document.createElement("span");
      motif.className = `move-motif${event.motifClass !== "plain" ? " is-special" : ""}`;
      motif.textContent = MOTIF_GLYPHS[event.motifClass] ?? "♪";
      motif.title = event.motif;
      button.append(san, motif);
      row.appendChild(button);
    }
    fragment.appendChild(row);
  }
  dom.moveList.replaceChildren(fragment);
}

function renderMappingPreview() {
  const preview = getMappingPreview(state.settings);
  const fragment = document.createDocumentFragment();
  for (const row of preview) {
    const cell = document.createElement("div");
    cell.className = "mapping-file";
    const file = document.createElement("strong");
    file.textContent = row.file;
    const low = document.createElement("span");
    low.textContent = row.lowNote;
    const high = document.createElement("span");
    high.textContent = row.highNote;
    const degree = document.createElement("small");
    degree.textContent = `deg ${row.degree}`;
    cell.title = `File ${row.file}: rank 1–4 → ${row.lowNote}; rank 5–8 → ${row.highNote}.`;
    cell.append(file, low, high, degree);
    fragment.appendChild(cell);
  }
  dom.mappingMiniGrid.replaceChildren(fragment);
}

function renderGuide() {
  if (!dom.mappingGuideContent) return;
  const settings = state.settings;
  const formula = describeSettingsFormula(settings);
  const preview = getMappingPreview(settings);
  const mode = MODES[settings.mode] ?? MODES.classical;
  const scale = SCALES[settings.scale] ?? SCALES.major;

  const rules = MAPPING_RULES.map(
    (rule) => `
      <div class="guide-card">
        <strong>${rule.label}</strong>
        <span>${rule.detail}</span>
      </div>`,
  ).join("");

  const tableRows = preview
    .map(
      (row) => `
        <tr>
          <td>${row.file}</td>
          <td>${row.degree}</td>
          <td>${row.lowNote}</td>
          <td>${row.highNote}</td>
        </tr>`,
    )
    .join("");

  const pieces = Object.values(PIECE_PROFILES)
    .map(
      (piece) => `
        <div class="guide-card">
          <strong>${piece.label} · ${piece.octaveShift >= 0 ? "+" : ""}${piece.octaveShift} oct</strong>
          <span>${piece.character}</span>
        </div>`,
    )
    .join("");

  const modes = Object.values(MODES)
    .map(
      (item) => `
        <div class="guide-card">
          <strong>${item.label} · ${item.tempo} bpm</strong>
          <span>${item.description}</span>
        </div>`,
    )
    .join("");

  const rhythms = Object.values(RHYTHMS)
    .map(
      (item) => `
        <div class="guide-card">
          <strong>${item.label}</strong>
          <span>${item.description}</span>
        </div>`,
    )
    .join("");

  dom.mappingGuideContent.innerHTML = `
    <p class="mapping-guide-intro">
      Every note is a direct consequence of the move. <em>No randomness, no samples and no hidden
      generation.</em> The same PGN and settings always rebuild the same composition — here and on
      another device.
    </p>

    <section class="guide-section">
      <h3>The six rules</h3>
      <p>Destination first, then the character of the moving piece, then the chess meaning of the move.</p>
      <div class="guide-grid">${rules}</div>
    </section>

    <section class="guide-section">
      <h3>Your current pitch grid</h3>
      <p>
        Root <strong>${formula.root}</strong>, ${formula.scale}, ${formula.register},
        ${formula.tempo} bpm, ${RHYTHMS[formula.rhythm]?.label ?? "Flowing"} rhythm.
        Rank 1–4 uses the lower half of the register; rank 5–8 uses the upper half.
      </p>
      <table class="guide-table">
        <thead><tr><th>File</th><th>Scale degree</th><th>Lower octave</th><th>Upper octave</th></tr></thead>
        <tbody>${tableRows}</tbody>
      </table>
      <p class="guide-note">
        Black speaks one octave below white, then the two selected voices add their own register
        shift. A final safety clamp keeps every pitch between MIDI ${24} and ${108}.
      </p>
    </section>

    <section class="guide-section">
      <h3>Piece signatures</h3>
      <p>Piece type changes octave, velocity, articulation and harmonic weight.</p>
      <div class="guide-grid">${pieces}</div>
    </section>

    <section class="guide-section">
      <h3>Move meaning becomes gesture</h3>
      <div class="guide-grid">
        <div class="guide-card"><strong>Single voice</strong><span>The destination tone, shaped by piece and colour.</span></div>
        <div class="guide-card"><strong>Capture bloom</strong><span>A diatonic third above the landing tone plus an optional low body.</span></div>
        <div class="guide-card"><strong>Check tension</strong><span>A quiet chromatic semitone and, outside Ambient, a tritone reply.</span></div>
        <div class="guide-card"><strong>Castling roll</strong><span>Root, fifth and octave lead into the king's landing note.</span></div>
        <div class="guide-card"><strong>Promotion flourish</strong><span>A rising fourth/fifth figure and an octave sparkle.</span></div>
        <div class="guide-card"><strong>Checkmate cadence</strong><span>A low-to-high tonic and fifth cadence closes the game.</span></div>
      </div>
    </section>

    <section class="guide-section">
      <h3>Time and colour</h3>
      <p>${mode.label} is currently “${mode.subtitle}” — ${mode.description} The ${scale.label} scale gives this mode its characteristic intervals (${scale.intervals.map((interval) => `${interval} st`).join(", ")}).</p>
      <div class="guide-grid">${rhythms}</div>
    </section>

    <section class="guide-section">
      <h3>Five sound worlds</h3>
      <p>Modes are starting points. Every tempo, voice, effect and visual control remains editable afterwards.</p>
      <div class="guide-grid">${modes}</div>
      <p class="guide-note">
        The player schedules notes a fraction of a second ahead against the AudioContext clock.
        Seeking, tempo changes and stopping cancel pending handles, so the same note is never
        scheduled twice.
      </p>
    </section>
  `;
}

function renderModeReadout() {
  dom.currentModeLabel.textContent = (MODES[state.settings.mode] ?? MODES.classical).label;
  dom.modeDescription.textContent = (MODES[state.settings.mode] ?? MODES.classical).subtitle;
  for (const button of dom.modeTabs?.querySelectorAll(".mode-tab") ?? []) {
    button.setAttribute("aria-pressed", String(button.dataset.mode === state.settings.mode));
  }
}

/* --------------------------------------------------------------------------
   Board, score and timeline synchronisation
   -------------------------------------------------------------------------- */

function applyBoardHighlights() {
  if (!boardView || !state.composition) return;
  const event = state.displayPly > 0 ? state.composition.events[state.displayPly - 1] : null;
  const check = event?.flags?.check && state.game.cursor === state.displayPly
    ? findKingSquare(state.game.chess)
    : null;
  boardView.setHighlights({
    from: event?.from ?? null,
    to: event?.to ?? null,
    check,
    active: state.activeSquare,
  });
}

function setActiveSquare(square) {
  if (state.activeSquare === square) return;
  state.activeSquare = square ?? null;
  applyBoardHighlights();
}

function setActiveNotes(notes = []) {
  visualizer?.setActiveNotes(Array.isArray(notes) ? notes : []);
}

function renderStatusAndChrome() {
  if (!state.composition) return;
  const status = state.game.getStatus();
  const total = state.game.moves.length;
  const playing = Boolean(player?.playing);
  const review = Boolean(state.reviewing);

  dom.gameStatus.textContent = status.label;
  if (playing) {
    dom.gameStatusDetail.textContent = `Replay · move ${state.displayPly} of ${total}`;
  } else if (review) {
    dom.gameStatusDetail.textContent = `Review · move ${state.displayPly} of ${total}`;
  } else {
    dom.gameStatusDetail.textContent = status.detail;
  }
  dom.turnPip.classList.toggle("is-black", state.game.turn === "b");
  dom.turnPip.title = state.game.turn === "w" ? "White to move" : "Black to move";

  dom.reviewChip.hidden = !review || playing;
  dom.playbackChip.hidden = !playing;
  dom.statusLed.classList.toggle("is-live", playing);

  dom.plyCounter.textContent = `${state.displayPly} / ${total}`;
  dom.returnLiveButton.hidden = !review && !playing;

  const interactive = !review && !playing && state.game.canInteract;
  boardView?.setInteractive(interactive);
  dom.notationInput.disabled = !interactive;
  const notationSubmit = dom.notationForm?.querySelector("button[type=submit]");
  if (notationSubmit) notationSubmit.disabled = !interactive;

  dom.undoButton.disabled = total === 0 || review || playing;
  dom.resetPositionButton.disabled = total === 0 || playing || state.displayPly === 0;
  dom.viewStartButton.disabled = total === 0 || playing || state.displayPly === 0;
  dom.viewPrevButton.disabled = total === 0 || playing || state.displayPly === 0;
  dom.viewNextButton.disabled = total === 0 || playing || state.displayPly === total;
  dom.viewEndButton.disabled = total === 0 || playing || state.displayPly === total;

  dom.board.setAttribute(
    "aria-label",
    `Interactive chessboard. ${status.label}. ${playing ? "Replay in progress." : review ? "Review position, moves disabled." : "Moves enabled."}`,
  );

  applyBoardHighlights();
  updateScoreActive();
  updateTimelineActive();
}

function showPly(ply, { animated = false, skipBoard = false, force = false } = {}) {
  const total = state.game.moves.length;
  const target = Math.max(0, Math.min(total, Math.round(Number(ply) || 0)));
  if (state.game.cursor !== target) state.game.goToMove(target);
  state.displayPly = target;

  if (!skipBoard && boardView && (force || state.lastRenderedPly !== target)) {
    state.lastRenderedPly = target;
    boardView.render(state.game.fen, { animated }).catch((error) => {
      console.error("Could not render board position", error);
    });
  }

  renderStatusAndChrome();
  renderTransport(player?.getSnapshot());
}

function updateScoreActive() {
  const buttons = dom.moveList.querySelectorAll(".move-cell[data-ply]");
  const activePly = state.displayPly;
  const latest = state.game.moves.length;
  const reviewing = state.reviewing || Boolean(player?.playing);
  let activeButton = null;

  for (const button of buttons) {
    const ply = Number(button.dataset.ply);
    const isActive = reviewing && ply === activePly;
    const isLive = !reviewing && ply === latest;
    button.classList.toggle("is-active", isActive);
    button.classList.toggle("is-live", isLive);
    if (isActive || isLive) {
      button.setAttribute("aria-current", "true");
      activeButton = button;
    } else {
      button.removeAttribute("aria-current");
    }
  }

  if (
    activeButton &&
    state.settings.autoScrollMoves &&
    scrolledScorePly !== activePly
  ) {
    scrolledScorePly = activePly;
    const row = activeButton.closest(".move-row");
    if (row) {
      const listRect = dom.moveList.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      if (rowRect.top < listRect.top || rowRect.bottom > listRect.bottom) {
        dom.moveList.scrollTo({
          top:
            row.offsetTop - dom.moveList.clientHeight / 2 + row.offsetHeight / 2,
          behavior: state.settings.reduceMotion ? "auto" : "smooth",
        });
      }
    }
  }
}

function updateTimelineActive() {
  const nodes = dom.timelineEvents.querySelectorAll(".timeline-event[data-event-index]");
  if (!nodes.length) return;
  const activeIndex = state.displayPly > 0 ? state.displayPly - 1 : -1;
  const reviewing = state.reviewing || Boolean(player?.playing);
  let activeNode = null;

  nodes.forEach((node) => {
    const index = Number(node.dataset.eventIndex);
    const isActive = reviewing && index === activeIndex;
    const isLive = !reviewing && index === state.game.moves.length - 1;
    const isPlayed = reviewing && index < activeIndex;
    node.classList.toggle("is-active", isActive);
    node.classList.toggle("is-live", isLive);
    node.classList.toggle("is-played", isPlayed);
    if (isActive || isLive) {
      node.setAttribute("aria-current", "true");
      activeNode = node;
    } else {
      node.removeAttribute("aria-current");
    }
  });

  if (
    activeNode &&
    state.settings.autoScrollMoves &&
    scrolledTimelineIndex !== activeIndex
  ) {
    scrolledTimelineIndex = activeIndex;
    const left = activeNode.offsetLeft - dom.timelineScroll.clientWidth / 2 + activeNode.clientWidth / 2;
    dom.timelineScroll.scrollTo({
      left: Math.max(0, left),
      behavior: state.settings.reduceMotion ? "auto" : "smooth",
    });
  }
}

function renderTransport(snapshot = player?.getSnapshot()) {
  const events = state.composition?.events ?? [];
  const hasEvents = events.length > 0;
  const playing = Boolean(snapshot?.playing);
  const eventCount = events.length;
  const progress = snapshot?.progress ?? 0;
  const beat = snapshot?.beat ?? 0;
  const duration = snapshot?.durationSec ?? state.composition?.durationSec ?? 0;
  const eventIndex = snapshot?.eventIndex ?? -1;
  const currentEvent = snapshot?.currentEvent ?? (eventIndex >= 0 ? events[eventIndex] : null);
  const ended = Boolean(snapshot?.ended);

  dom.playerPlayButton.classList.toggle("is-playing", playing);
  dom.playerPlayButton.setAttribute(
    "aria-label",
    playing ? "Pause composition" : ended ? "Replay composition" : "Play composition",
  );
  dom.playerPlayButton.disabled = !hasEvents;
  dom.playerStartButton.disabled = !hasEvents;
  dom.playerPrevButton.disabled = !hasEvents;
  dom.playerNextButton.disabled = !hasEvents;
  dom.playerStopButton.disabled = !hasEvents || (!playing && beat <= 0.0005);
  dom.compositionProgress.disabled = !hasEvents;
  dom.compositionProgress.value = String(Math.round(progress * 1000));
  updateRangeFill(dom.compositionProgress);

  dom.elapsedTime.textContent = formatTime(snapshot?.elapsedSec ?? 0);
  dom.totalTime.textContent = formatTime(duration);
  dom.transportEventIndex.textContent = eventIndex >= 0
    ? `Event ${eventIndex + 1} / ${eventCount}`
    : hasEvents
      ? `Event — / ${eventCount}`
      : "Event —";

  let status = "Ready";
  if (!hasEvents) status = "No moves";
  else if (playing) status = "Playing";
  else if (ended) status = "Complete";
  else if (beat > 0.0005) status = "Paused";
  else if (state.reviewing) status = "Review";
  dom.transportStatus.textContent = status;

  let progressLabel = "Start of composition";
  if (!hasEvents) progressLabel = "Awaiting first move";
  else if (ended) progressLabel = "Composition complete";
  else if (currentEvent) {
    progressLabel = `Move ${currentEvent.moveNumber} · ${currentEvent.san}`;
  }
  dom.progressEventLabel.textContent = progressLabel;

  const totalMoves = state.game.moves.length;
  const currentMove = currentEvent?.moveNumber ?? Math.min(totalMoves, state.displayPly);
  dom.compositionProgress.setAttribute(
    "aria-valuetext",
    hasEvents
      ? `${currentMove} of ${totalMoves} moves, ${formatTime(snapshot?.elapsedSec ?? 0)} elapsed`
      : "No composition loaded",
  );

  if (dom.playerTempo.value !== String(Math.round(Number(state.settings.tempo)))) {
    dom.playerTempo.value = String(Math.round(Number(state.settings.tempo)));
    updateRangeFill(dom.playerTempo);
    dom.playerTempoOutput.textContent = `${Math.round(Number(state.settings.tempo))} bpm`;
  }
}

function showBoardEffect(event, { duration = 1400 } = {}) {
  if (!event) {
    dom.boardEffect.classList.remove("is-visible");
    return;
  }
  const tone = TONE_BY_MOTIF[event.motifClass] ?? "plain";
  dom.boardEffect.dataset.tone = tone;
  dom.boardEffectGlyph.textContent = MOTIF_GLYPHS[event.motifClass] ?? "♪";
  dom.boardEffectLabel.textContent = event.motif;
  dom.boardEffect.classList.add("is-visible");
  if (state.effectTimer) window.clearTimeout(state.effectTimer);
  state.effectTimer = window.setTimeout(() => {
    dom.boardEffect.classList.remove("is-visible");
  }, duration);
}

/* --------------------------------------------------------------------------
   Now-sounding, piano and insight panel
   -------------------------------------------------------------------------- */

function showIdleNow() {
  if (!dom.nowPanel) return;
  state.nowEvent = null;
  dom.nowKicker.textContent = "Now sounding";
  dom.nowNote.textContent = "—";
  dom.nowDetail.textContent = "Play a move or start the composition";
  dom.nowPieceGlyph.textContent = "♟";
  dom.nowVoice.textContent = "Awaiting audio";
  dom.nowPanel.classList.remove("is-sounding");
  dom.insightMessage.textContent =
    "The board is silent until a move or the composition player begins.";
  const items = [
    "File a–h → scale degree 1–8.",
    "Rank 1–4 low, rank 5–8 high.",
    "White and Black receive separate voices.",
  ];
  dom.insightList.replaceChildren(
    ...items.map((text) => {
      const item = document.createElement("li");
      item.textContent = text;
      return item;
    }),
  );
  dom.pianoNoteReadout.textContent = "C2 — C7";
}

function showEventMapping(event, { sounding = false, kicker = null } = {}) {
  if (!event) {
    showIdleNow();
    return;
  }
  state.nowEvent = event;
  const pieceLabel = PIECE_PROFILES[event.piece]?.label ?? "Pawn";
  dom.nowKicker.textContent =
    kicker ?? (sounding ? "Now sounding" : "Selected event");
  dom.nowNote.textContent = event.baseNote?.note ?? event.noteNames[0] ?? "—";
  dom.nowDetail.textContent = `${pieceLabel} · ${event.from} → ${event.to} · ${event.motif}`;
  dom.nowPieceGlyph.textContent = PIECE_GLYPHS[event.piece] ?? "♟";
  dom.nowVoice.textContent = event.mapping?.voiceLabel ?? "Synthesized voice";
  dom.nowPanel.classList.toggle("is-sounding", Boolean(sounding));
  dom.pianoNoteReadout.textContent = event.noteNames.slice(0, 5).join(" · ");
  dom.pianoNoteReadout.title = event.noteNames.join(" · ");

  dom.insightMessage.textContent =
    `${event.to.toUpperCase()} is file ${event.mapping.file} → degree ${event.mapping.scaleDegree + 1}, ` +
    `rank ${event.mapping.rank} → octave ${event.mapping.octave}. ${event.motif}.`;
  dom.insightList.replaceChildren(
    ...event.explanation.slice(0, 4).map((text) => {
      const item = document.createElement("li");
      item.textContent = text;
      return item;
    }),
  );
}

function clearLiveSounding({ keepPanel = true } = {}) {
  if (state.liveTimer) {
    window.clearTimeout(state.liveTimer);
    state.liveTimer = null;
  }
  setActiveNotes([]);
  setActiveSquare(null);
  if (!keepPanel) {
    showIdleNow();
    return;
  }
  dom.nowPanel?.classList.remove("is-sounding");
  if (state.nowEvent && !player?.playing) {
    dom.nowKicker.textContent = "Last move";
  }
}

function playLiveEvent(event) {
  if (!event) return;
  if (state.liveTimer) {
    window.clearTimeout(state.liveTimer);
    state.liveTimer = null;
  }
  const running = audioRunning();
  let highlightMs = 0;

  if (running) {
    const handles = audio.playEvent(event, state.settings.tempo, state.settings);
    const secondsPerBeat = 60 / (Number(state.settings.tempo) || 84);
    highlightMs =
      Math.max(
        0.45,
        ...event.notes.map((note) => (note.offset + note.duration) * secondsPerBeat),
      ) * 1000 + 320;
    if (handles.length) {
      setActiveNotes(event.notes);
      setActiveSquare(event.to);
      showEventMapping(event, { sounding: true, kicker: "Now sounding" });
    } else {
      showEventMapping(event, { sounding: false, kicker: "Mapped move" });
    }
  } else {
    setActiveNotes([]);
    setActiveSquare(null);
    showEventMapping(event, { sounding: false, kicker: "Mapped move" });
    if (!state.audioHintShown) {
      state.audioHintShown = true;
      showToast("Sound is off. Use Enable sound in the top bar to hear every move.");
    }
  }

  showBoardEffect(event);

  if (running) {
    state.liveTimer = window.setTimeout(() => {
      state.liveTimer = null;
      if (player?.playing) return;
      setActiveNotes([]);
      setActiveSquare(null);
      dom.nowPanel?.classList.remove("is-sounding");
      if (state.nowEvent === event) dom.nowKicker.textContent = "Last move";
    }, highlightMs);
  }
}

/* --------------------------------------------------------------------------
   Player synchronisation and transport logic
   -------------------------------------------------------------------------- */

function handlePlayerUpdate(snapshot) {
  if (!state.composition) return;
  const playing = Boolean(snapshot?.playing);

  if (playing) {
    if (state.liveTimer) {
      window.clearTimeout(state.liveTimer);
      state.liveTimer = null;
    }
    state.reviewing = true;
    const event = snapshot.currentEvent;
    const targetPly = event ? snapshot.eventIndex + 1 : 0;
    if (targetPly !== state.displayPly) {
      showPly(targetPly, { animated: false });
    }

    setActiveNotes(snapshot.activeNotes);
    setActiveSquare(event?.to ?? null);

    if (snapshot.eventIndex !== lastPlayerEventIndex) {
      lastPlayerEventIndex = snapshot.eventIndex;
      showEventMapping(event, {
        sounding: true,
        kicker: event?.motifClass && event.motifClass !== "plain" ? event.motif : "Now sounding",
      });
      showBoardEffect(event, { duration: 1250 });
      announce(`Playing ${event ? `move ${event.moveNumber}, ${event.san}` : "composition"}.`);
    }
    dom.statusLed.classList.add("is-live");
  } else {
    setActiveNotes([]);
    setActiveSquare(null);
    dom.statusLed.classList.remove("is-live");

    if (state.reviewing) {
      const targetPly =
        snapshot?.beat <= 0.0005
          ? 0
          : snapshot?.currentEvent
            ? snapshot.eventIndex + 1
            : 0;
      if (targetPly !== state.displayPly) {
        showPly(targetPly, { animated: false });
      }

      if (snapshot?.ended) {
        const last = state.composition.events.at(-1);
        showEventMapping(last, { sounding: false, kicker: "Composition complete" });
      } else if (targetPly > 0 && snapshot?.currentEvent) {
        showEventMapping(snapshot.currentEvent, {
          sounding: false,
          kicker: snapshot.interrupted ? "Paused · audio interrupted" : "Paused",
        });
      } else if (snapshot?.beat <= 0.0005) {
        showIdleNow();
        dom.nowKicker.textContent = "Ready to play";
      }

      if (snapshot?.interrupted && !state.interruptedNotified) {
        state.interruptedNotified = true;
        showToast("Playback was paused. Resume sound in the top bar, then press play.", {
          duration: 5200,
        });
      }
      if (!snapshot?.interrupted) state.interruptedNotified = false;
    }
  }

  renderTransport(snapshot);
  renderStatusAndChrome();
}

async function togglePlayback() {
  if (!state.composition?.events?.length) {
    showToast("Play a move first — the composition is still empty.");
    return;
  }
  if (player.playing) {
    player.pause();
    return;
  }

  const ready = await ensureAudio({ announceEnabled: !audioRunning() });
  if (!ready) return;

  state.reviewing = true;
  if (player.getSnapshot().ended) {
    player.seek(0, { keepPlaying: false });
    showPly(0);
  }

  const started = await player.play();
  if (!started) {
    showToast("Playback could not start. Enable sound and try again.", { tone: "error" });
    return;
  }
  announce("Composition playing.");
}

async function restartPlayback() {
  if (!state.composition?.events?.length) {
    showToast("Play a move first — the composition is still empty.");
    return;
  }
  const ready = await ensureAudio({ announceEnabled: !audioRunning() });
  if (!ready) return;

  state.reviewing = true;
  lastPlayerEventIndex = -999;
  player.seek(0, { keepPlaying: false });
  setActiveNotes([]);
  setActiveSquare(null);
  showPly(0);
  showIdleNow();
  dom.nowKicker.textContent = "Starting";
  const started = await player.play();
  if (!started) {
    showToast("Playback could not start. Enable sound and try again.", { tone: "error" });
  } else {
    announce("Composition restarted from the beginning.");
  }
}

function stopPlayback() {
  returnToLive({ silent: true });
}

function returnToLive({ silent = false } = {}) {
  state.reviewing = false;
  lastPlayerEventIndex = -999;
  state.interruptedNotified = false;
  player?.stop();
  if (state.liveTimer) {
    window.clearTimeout(state.liveTimer);
    state.liveTimer = null;
  }
  setActiveNotes([]);
  setActiveSquare(null);
  state.game.goToEnd();
  const total = state.game.moves.length;
  showPly(total, { animated: false, force: true });
  if (total > 0) {
    const last = state.composition.events[total - 1];
    showEventMapping(last, { sounding: false, kicker: "Last move" });
  } else {
    showIdleNow();
  }
  if (!silent) showToast("Returned to the live position.", { tone: "success" });
  announce("Returned to the live position.");
}

function reviewAtPly(ply, { keepPlaying = false } = {}) {
  const total = state.game.moves.length;
  const target = Math.max(0, Math.min(total, Math.round(Number(ply) || 0)));
  const beat = beatForPly(target);
  state.reviewing = true;
  lastPlayerEventIndex = -999;

  if (player) {
    player.seek(beat, { keepPlaying: Boolean(keepPlaying) });
  }
  const snapshot = player?.getSnapshot();
  if (!snapshot?.playing) {
    showPly(target, { animated: false });
    setActiveNotes([]);
    setActiveSquare(null);
    if (target > 0) {
      showEventMapping(state.composition.events[target - 1], {
        sounding: false,
        kicker: target === total ? "Final move" : "Selected event",
      });
    } else {
      showIdleNow();
    }
  }
  renderTransport(snapshot);
  renderStatusAndChrome();
}

function seekToBeat(beat) {
  if (!state.composition || !player) return;
  const totalBeats = state.composition.beatCount;
  const target = Math.max(0, Math.min(totalBeats, Number(beat) || 0));
  const wasPlaying = player.playing;
  state.reviewing = true;
  player.seek(target, { keepPlaying: wasPlaying });
  const snapshot = player.getSnapshot();

  if (!snapshot.playing) {
    const targetPly = target <= 0.0005 ? 0 : plyForBeat(target);
    showPly(targetPly, { animated: false });
    setActiveNotes([]);
    setActiveSquare(null);
    if (targetPly > 0) {
      showEventMapping(state.composition.events[targetPly - 1], {
        sounding: false,
        kicker: target >= totalBeats - 0.0005 ? "Composition complete" : "Selected event",
      });
    } else {
      showIdleNow();
      dom.nowKicker.textContent = "Selected event";
    }
  }
  renderTransport(snapshot);
  renderStatusAndChrome();
}

function stepEvent(direction) {
  const total = state.game.moves.length;
  if (!total) return;
  const currentPly = state.displayPly;
  let target;
  if (direction > 0) {
    target = currentPly <= 0 ? 1 : Math.min(total, currentPly + 1);
  } else {
    target = currentPly <= 1 ? 0 : currentPly - 1;
  }
  reviewAtPly(target, { keepPlaying: Boolean(player?.playing) });
}

/* --------------------------------------------------------------------------
   Settings
   -------------------------------------------------------------------------- */

function persistSettingsNow() {
  const result = savePreferences(state.settings);
  if (!result.ok) {
    showToast(result.error || "Preferences could not be saved.", { tone: "error" });
  }
}

function saveSettingsDebounced() {
  if (settingsSaveTimer) window.clearTimeout(settingsSaveTimer);
  settingsSaveTimer = window.setTimeout(() => {
    settingsSaveTimer = null;
    persistSettingsNow();
  }, 220);
}

function reducedMotionEffective() {
  return Boolean(state.settings.reduceMotion);
}

function refreshRuntimeSettings() {
  document.documentElement.classList.toggle("reduce-motion", reducedMotionEffective());
  boardView?.setReducedMotion(reducedMotionEffective());
  visualizerSettings();
  audio?.updateSettings(state.settings);
  renderModeReadout();
  renderMappingPreview();
}

function syncSettingsControls() {
  const s = state.settings;
  if (!dom.settingMode) return;
  dom.settingMode.value = s.mode;
  dom.settingRhythm.value = s.rhythm;
  dom.settingRoot.value = s.rootNote;
  dom.settingScale.value = s.scale;
  dom.settingRegister.value = s.register;
  dom.settingWhiteVoice.value = s.whiteVoice;
  dom.settingBlackVoice.value = s.blackVoice;

  dom.settingTempo.value = String(s.tempo);
  dom.settingNoteLength.value = String(s.noteLength);
  dom.settingIntensity.value = String(s.instrumentIntensity);
  dom.settingVolume.value = String(s.masterVolume);
  dom.settingReverb.value = String(s.reverb);
  dom.playerTempo.value = String(s.tempo);

  dom.settingTempoOutput.textContent = `${Math.round(s.tempo)} bpm`;
  dom.playerTempoOutput.textContent = `${Math.round(s.tempo)} bpm`;
  dom.settingNoteLengthOutput.textContent = `${s.noteLength.toFixed(2)}×`;
  dom.settingIntensityOutput.textContent = `${Math.round(s.instrumentIntensity * 100)}%`;
  dom.settingVolumeOutput.textContent = `${Math.round(s.masterVolume * 100)}%`;
  dom.settingReverbOutput.textContent = `${Math.round(s.reverb * 100)}%`;

  dom.effectCaptures.checked = s.effectCaptures;
  dom.effectChecks.checked = s.effectChecks;
  dom.effectPromotions.checked = s.effectPromotions;
  dom.effectCheckmate.checked = s.effectCheckmate;
  dom.visualWaveform.checked = s.showWaveform;
  dom.visualPiano.checked = s.showPiano;
  dom.settingReducedMotion.checked = s.reduceMotion;
  dom.settingAutoscroll.checked = s.autoScrollMoves;

  for (const input of [
    dom.settingTempo,
    dom.settingNoteLength,
    dom.settingIntensity,
    dom.settingVolume,
    dom.settingReverb,
    dom.playerTempo,
  ]) {
    updateRangeFill(input);
  }
}

function populateSettingsControls() {
  const fill = (select, entries, selected) => {
    const fragment = document.createDocumentFragment();
    for (const entry of entries) {
      const option = document.createElement("option");
      option.value = entry.value;
      option.textContent = entry.label;
      if (entry.value === selected) option.selected = true;
      fragment.appendChild(option);
    }
    select.replaceChildren(fragment);
  };

  fill(
    dom.settingMode,
    Object.values(MODES).map((mode) => ({ value: mode.id, label: `${mode.label} — ${mode.subtitle}` })),
    state.settings.mode,
  );
  fill(
    dom.settingRhythm,
    Object.entries(RHYTHMS).map(([value, rhythm]) => ({ value, label: rhythm.label })),
    state.settings.rhythm,
  );
  fill(
    dom.settingRoot,
    ROOT_NOTES.map((note) => ({ value: note.value, label: note.label })),
    state.settings.rootNote,
  );
  fill(
    dom.settingScale,
    Object.entries(SCALES).map(([value, scale]) => ({ value, label: scale.label })),
    state.settings.scale,
  );
  fill(
    dom.settingRegister,
    Object.entries(REGISTERS).map(([value, register]) => ({ value, label: register.label })),
    state.settings.register,
  );
  fill(
    dom.settingWhiteVoice,
    Object.values(VOICE_PRESETS).map((voice) => ({ value: voice.id, label: voice.label })),
    state.settings.whiteVoice,
  );
  fill(
    dom.settingBlackVoice,
    Object.values(VOICE_PRESETS).map((voice) => ({ value: voice.id, label: voice.label })),
    state.settings.blackVoice,
  );

  renderModeTabs();
  syncSettingsControls();
}

async function applySettingsPatch(patch, { mapping = false, rebuild = true } = {}) {
  state.settings = sanitizeSettings({ ...state.settings, ...patch });
  saveSettingsDebounced();
  refreshRuntimeSettings();
  syncSettingsControls();
  updateCompositionTiming();

  if (patch.tempo !== undefined) {
    player?.setTempo(state.settings.tempo);
  }

  if (mapping && rebuild) {
    await rebuildComposition({ preservePlayback: true });
  }

  renderSession();
  renderCompositionSummary();
  renderTransport(player?.getSnapshot());
  if (!player?.playing && state.nowEvent && state.composition?.events?.length) {
    const ply = state.displayPly > 0 ? state.displayPly : state.game.moves.length;
    if (ply > 0) {
      showEventMapping(state.composition.events[ply - 1], {
        sounding: false,
        kicker: state.reviewing ? "Selected event" : "Last move",
      });
    }
  }
}

async function applyMode(modeId) {
  const mode = MODES[modeId];
  if (!mode) return;
  state.settings = applyModePreset(state.settings, modeId);
  persistSettingsNow();
  refreshRuntimeSettings();
  syncSettingsControls();
  updateCompositionTiming();
  await rebuildComposition({ preservePlayback: true });
  renderSession();
  renderCompositionSummary();
  showToast(`${mode.label}: ${mode.subtitle}.`);
  announce(`${mode.label} sound mode applied.`);
}

async function restoreDefaults() {
  state.settings = { ...DEFAULT_SETTINGS };
  persistSettingsNow();
  refreshRuntimeSettings();
  syncSettingsControls();
  updateCompositionTiming();
  await rebuildComposition({ preservePlayback: true });
  renderSession();
  renderCompositionSummary();
  showToast("Studio restored to its default settings.", { tone: "success" });
}

/* --------------------------------------------------------------------------
   Chess actions
   -------------------------------------------------------------------------- */

function refreshAfterGameMutation({ animated = false, message = "" } = {}) {
  const next = buildCurrentComposition();
  state.composition = next;
  player?.load(next, { emit: false });
  lastPlayerEventIndex = -999;
  scrolledScorePly = -1;
  scrolledTimelineIndex = -1;
  state.reviewing = false;
  state.lastRenderedPly = -1;
  setActiveNotes([]);
  setActiveSquare(null);

  renderSession();
  renderCompositionSummary();
  renderTimeline();
  renderScore();
  renderMappingPreview();
  renderTransport(player?.getSnapshot());
  showPly(state.game.moves.length, { animated, force: true });

  if (state.game.moves.length > 0) {
    const last = next.events.at(-1);
    showEventMapping(last, { sounding: false, kicker: "Last move" });
  } else {
    showIdleNow();
  }
  if (message) showToast(message);
}

function handleBoardMove(from, to, promotion = "q") {
  if (state.reviewing || player?.playing) {
    return { ok: false, error: "Return to the live position before moving." };
  }
  const result = state.game.makeMove(from, to, promotion);
  if (!result.ok) return result;

  state.reviewing = false;
  state.displayPly = state.game.moves.length;
  state.lastRenderedPly = -1; // BoardView owns the visual commit of this move.

  const next = buildCurrentComposition();
  state.composition = next;
  const event = next.events.at(-1);
  player?.load(next, { emit: false });
  lastPlayerEventIndex = -999;
  state.compositionTitle = state.compositionTitle || "";

  renderSession();
  renderCompositionSummary();
  renderTimeline();
  renderScore();
  renderMappingPreview();
  renderStatusAndChrome();
  renderTransport(player?.getSnapshot());

  if (event) playLiveEvent(event);
  announce(
    `${result.move.color === "w" ? "White" : "Black"} plays ${result.move.san}. ${event?.motif ?? ""}.`,
  );
  return { ok: true, move: result.move, event };
}

function handleBoardMoveFinished() {
  state.lastRenderedPly = state.game.moves.length;
  state.displayPly = state.game.moves.length;
  renderStatusAndChrome();
  applyBoardHighlights();
}

function submitNotation(event) {
  event.preventDefault();
  if (!state.composition) return;
  if (state.reviewing || player?.playing) {
    showToast("Return to live first. Use “Return to live” beside the score.");
    return;
  }
  if (!state.game.canInteract) {
    showToast("The game is over. Start a new game to keep playing.");
    return;
  }

  const raw = dom.notationInput.value.trim();
  if (!raw) return;
  let from = "";
  let to = "";
  let promotion = "q";

  const coordinate = raw.match(/^([a-h][1-8])[\s-]?([a-h][1-8])([qrbnQRBN])?$/);
  if (coordinate) {
    from = coordinate[1].toLowerCase();
    to = coordinate[2].toLowerCase();
    promotion = (coordinate[3] || "q").toLowerCase();
  } else {
    try {
      const clone = new Chess(state.game.fen);
      const move = clone.move(raw, { strict: false });
      if (!move) throw new Error("No move");
      from = move.from;
      to = move.to;
      promotion = move.promotion || "q";
    } catch {
      showToast(`“${clipText(raw, 24)}” is not a legal move in this position.`, {
        tone: "error",
      });
      dom.notationInput.select();
      return;
    }
  }

  const result = handleBoardMove(from, to, promotion);
  if (!result.ok) {
    showToast(result.error || "That move is not legal here.", { tone: "error" });
    return;
  }

  // Notation moves do not travel through the board's own drag/click input, so
  // BoardView cannot commit its SVG automatically. Render from the authoritative
  // FEN after the move, then refresh highlights once the animation settles.
  if (boardView) {
    state.lastRenderedPly = state.game.moves.length;
    // Snap typed moves to the final FEN rather than queuing overlapping
    // animations. Board clicks and drags keep their own animated transition.
    boardView
      .render(state.game.fen, { animated: false })
      .then(() => handleBoardMoveFinished())
      .catch((error) => console.error("Could not render notation move", error));
  }
  dom.notationInput.value = "";
  dom.notationInput.focus();
}

function requestNewGame() {
  if (state.game.moves.length === 0) {
    startNewGame();
    return;
  }
  openConfirm({
    title: "Start a new game?",
    message:
      "This clears the board and replaces the current composition. Save it to your library first if you want to keep it.",
    label: "Start new game",
    danger: true,
    onConfirm: startNewGame,
  });
}

function startNewGame() {
  player?.stop();
  state.reviewing = false;
  state.interruptedNotified = false;
  state.game.newGame();
  state.compositionId = makeId();
  state.compositionCreatedAt = new Date().toISOString();
  state.compositionTitle = "";
  state.sourceLabel = "Local session";
  if (state.liveTimer) window.clearTimeout(state.liveTimer);
  state.liveTimer = null;
  setActiveNotes([]);
  setActiveSquare(null);
  showIdleNow();
  refreshAfterGameMutation({ animated: true, message: "A fresh board, ready for its first note." });
  announce("New game started. White to move.");
}

function undoLastMove() {
  if (!state.game.moves.length) {
    showToast("There is no move to undo.");
    return;
  }
  player?.stop();
  state.reviewing = false;
  const result = state.game.undoMove();
  if (!result.ok) {
    showToast(result.error || "The move could not be undone.", { tone: "error" });
    return;
  }
  refreshAfterGameMutation({ animated: true, message: `Took back ${result.move.san}.` });
  announce(`${result.move.san} taken back.`);
}

function flipBoard() {
  state.orientation = state.orientation === "w" ? "b" : "w";
  boardView?.setOrientation(state.orientation);
  showToast(state.orientation === "w" ? "White at the bottom." : "Black at the bottom.");
}

function resetToFirstPosition() {
  if (!state.game.moves.length) return;
  reviewAtPly(0);
  announce("Showing the opening position.");
}

/* --------------------------------------------------------------------------
   Import, save, share
   -------------------------------------------------------------------------- */

async function applyImportedGame(
  importedGame,
  {
    settings = null,
    title = "",
    sourceLabel = "Imported PGN",
    compositionId = null,
    createdAt = null,
  } = {},
) {
  player?.stop();
  state.reviewing = false;
  state.interruptedNotified = false;
  state.game = importedGame;
  state.game.goToEnd();
  state.compositionId = compositionId || makeId();
  state.compositionCreatedAt = createdAt || new Date().toISOString();
  state.compositionTitle = title || "";
  state.sourceLabel = sourceLabel;

  if (settings) {
    state.settings = sanitizeSettings(settings);
    persistSettingsNow();
    refreshRuntimeSettings();
    syncSettingsControls();
    updateCompositionTiming();
  }

  if (state.liveTimer) window.clearTimeout(state.liveTimer);
  state.liveTimer = null;
  setActiveNotes([]);
  setActiveSquare(null);
  refreshAfterGameMutation({ animated: false });
  if (state.game.moves.length > 0) {
    showEventMapping(state.composition.events.at(-1), {
      sounding: false,
      kicker: "Loaded composition",
    });
  } else {
    showIdleNow();
  }
  announce(
    `${currentDisplayTitle()} loaded with ${plural(state.game.moves.length, "move")}.`,
  );
}

function setImportError(message = "") {
  setDialogError(dom.importError, message);
}

async function importFromText(text, { sourceLabel = "Imported PGN", title = "" } = {}) {
  const raw = String(text ?? "").trim();
  if (!raw) {
    setImportError("Paste a PGN or a CHESSOUND share code first.");
    return false;
  }

  let pgn = raw;
  let settings = null;
  let shareTitle = title;

  if (raw.startsWith("CS1.")) {
    try {
      const payload = decodeShareCode(raw);
      pgn = payload.pgn;
      settings = payload.settings;
      shareTitle = payload.title || title;
      sourceLabel = "Shared link";
    } catch (error) {
      setImportError(error.message || "The share code could not be decoded.");
      return false;
    }
  }

  const candidate = new ChessGame();
  const result = candidate.loadPgn(pgn);
  if (!result.ok) {
    setImportError(result.error || "This PGN could not be loaded.");
    return false;
  }

  // A PGN's Event header often carries the study's real title. Use it unless a
  // share code supplied an explicit title.
  const eventTitle = result.headers?.Event;
  const derivedTitle =
    !shareTitle && eventTitle && eventTitle !== "CHESSOUND local match" ? eventTitle : "";

  await applyImportedGame(candidate, {
    settings,
    title: shareTitle || derivedTitle,
    sourceLabel,
  });
  setImportError("");
  closeDialog(dom.importDialog);
  showToast(
    `${currentDisplayTitle()} loaded — ${plural(candidate.moves.length, "move")}.`,
    { tone: "success" },
  );
  return true;
}

async function loadSharedLinkOnStartup() {
  let code = null;
  try {
    code = readShareCodeFromLocation();
  } catch {
    code = null;
  }
  if (!code) return;
  try {
    const payload = decodeShareCode(code);
    const candidate = new ChessGame();
    const result = candidate.loadPgn(payload.pgn);
    if (!result.ok) throw new Error(result.error);
    await applyImportedGame(candidate, {
      settings: payload.settings,
      title: payload.title,
      sourceLabel: "Shared link",
    });
    showToast("Shared composition loaded. Every setting travelled in the link.", {
      tone: "success",
      duration: 5200,
    });
    const cleanUrl = `${window.location.origin}${window.location.pathname}`;
    window.history.replaceState(null, "", cleanUrl);
  } catch (error) {
    console.error("Shared link could not be loaded", error);
    showToast("The shared composition could not be loaded. You can import the code manually.", {
      tone: "error",
      duration: 6000,
    });
    if (dom.pgnInput) dom.pgnInput.value = code;
    setImportError(error.message || "The share link is damaged.");
    openDialog(dom.importDialog);
  }
}

function openImportDialog() {
  setImportError("");
  openDialog(dom.importDialog);
}

function readPgnFile(file) {
  if (!file) return;
  if (file.size > 2_000_000) {
    setImportError("This file is too large. PGN scores are usually only a few kilobytes.");
    return;
  }
  file
    .text()
    .then((text) => {
      dom.pgnInput.value = text;
      dom.fileDropLabel.textContent = file.name;
      setImportError("");
    })
    .catch(() => setImportError("The selected file could not be read."));
}

function handlePgnFile() {
  readPgnFile(dom.pgnFile.files?.[0]);
}

function openSaveDialog() {
  if (!state.composition?.events?.length) {
    showToast("Play at least one move before saving.");
    return;
  }
  setDialogError(dom.saveError, "");
  dom.saveTitleInput.value = currentDisplayTitle();
  dom.saveConfirmButton.disabled = false;
  const summary = state.composition.summary;
  dom.savePreview.innerHTML = `
    <div><span>Moves</span><strong>${summary.moves}</strong></div>
    <div><span>Notes</span><strong>${summary.notes}</strong></div>
    <div><span>Duration</span><strong>${formatTime(state.composition.durationSec)}</strong></div>
    <div><span>Mode</span><strong>${MODES[state.settings.mode]?.label ?? "Classical"}</strong></div>
    <div><span>Root</span><strong>${state.settings.rootNote}</strong></div>
    <div><span>Storage</span><strong>This device</strong></div>
  `;
  openDialog(dom.saveDialog);
  window.setTimeout(() => dom.saveTitleInput.select(), 60);
}

function confirmSave() {
  const title = dom.saveTitleInput.value.trim().slice(0, 120);
  if (!title) {
    setDialogError(dom.saveError, "Give the composition a title before saving.");
    dom.saveTitleInput.focus();
    return;
  }
  setDialogError(dom.saveError, "");
  dom.saveConfirmButton.disabled = true;
  const record = {
    id: state.compositionId,
    title,
    pgn: state.game.toPgn({ upTo: state.game.moves.length }),
    settings: state.settings,
    savedAt: new Date().toISOString(),
    createdAt: state.compositionCreatedAt,
    summary: state.composition.summary,
  };
  const result = saveComposition(record);
  dom.saveConfirmButton.disabled = false;
  if (!result.ok) {
    setDialogError(dom.saveError, result.error || "Could not save this composition.");
    return;
  }

  state.compositionTitle = title;
  state.composition.title = title;
  state.sourceLabel = "Saved composition";
  state.savedCount = loadSavedCompositions().length;
  updateLibraryBadge();
  renderSession();
  closeDialog(dom.saveDialog);
  showToast("Saved to your local library.", { tone: "success" });
  announce(`${title} saved to the local library.`);
}

function openShareDialog() {
  if (!state.composition?.events?.length) {
    showToast("Play at least one move before sharing.");
    return;
  }
  setDialogError(dom.shareError, "");
  try {
    const code = encodeShareCode({
      pgn: state.game.toPgn({ upTo: state.game.moves.length }),
      settings: state.settings,
      title: currentDisplayTitle(),
    });
    const base = new URL(window.location.href);
    base.hash = "";
    base.search = "";
    const url = buildShareUrl(base.toString(), code);
    dom.shareUrlInput.value = url;
    openDialog(dom.shareDialog);
    window.setTimeout(() => dom.shareUrlInput.select(), 60);
  } catch (error) {
    console.error("Share link could not be built", error);
    setDialogError(dom.shareError, error.message || "Could not build a share link.");
    dom.shareUrlInput.value = "";
    openDialog(dom.shareDialog);
  }
}

async function copyShareLink() {
  const value = dom.shareUrlInput.value.trim();
  if (!value) {
    setDialogError(dom.shareError, "There is no link to copy yet.");
    return;
  }
  setDialogError(dom.shareError, "");
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
    } else {
      dom.shareUrlInput.select();
      if (!document.execCommand("copy")) throw new Error("Copy command was unavailable.");
    }
    dom.copyShareButton.textContent = "Copied";
    showToast("Composition link copied. It contains the score and settings.", {
      tone: "success",
    });
    window.setTimeout(() => {
      dom.copyShareButton.textContent = "Copy link";
    }, 1800);
  } catch (error) {
    console.error("Clipboard write failed", error);
    dom.shareUrlInput.select();
    setDialogError(
      dom.shareError,
      "Automatic copying was blocked. The link is selected — copy it with your keyboard.",
    );
  }
}

function exportPgn() {
  if (!state.composition?.events?.length) {
    showToast("Play a move before exporting a PGN.");
    return;
  }
  try {
    const pgn = state.game.toPgn({ upTo: state.game.moves.length });
    downloadBlob(
      new Blob([pgn], { type: "application/x-chess-pgn;charset=utf-8" }),
      `${slugify(currentDisplayTitle())}.pgn`,
    );
    showToast("PGN downloaded.", { tone: "success" });
  } catch (error) {
    console.error("PGN export failed", error);
    showToast("The PGN could not be exported.", { tone: "error" });
  }
}

/* --------------------------------------------------------------------------
   Local composition library
   -------------------------------------------------------------------------- */

function formatSavedDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "date unknown";
  try {
    return new Intl.DateTimeFormat(undefined, {
      day: "numeric",
      month: "short",
      year: "numeric",
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function updateLibraryBadge() {
  let records = [];
  try {
    records = loadSavedCompositions();
  } catch (error) {
    console.error("Library could not be read", error);
  }
  state.savedCount = records.length;
  if (dom.libraryCount) {
    dom.libraryCount.textContent = String(records.length);
    dom.libraryCount.hidden = records.length === 0;
    dom.libraryCount.title = `${plural(records.length, "saved composition")}`;
  }
  return records;
}

function renderLibrary() {
  const records = updateLibraryBadge();
  if (!records.length) {
    const empty = document.createElement("div");
    empty.className = "library-empty";
    const title = document.createElement("strong");
    title.textContent = "No saved compositions yet";
    const copy = document.createElement("span");
    copy.textContent =
      "Play a few moves, then choose Save. Records are tiny — a PGN plus your mapping settings — and never leave this browser.";
    empty.append(title, copy);
    dom.libraryList.replaceChildren(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  records.forEach((record, index) => {
    const item = document.createElement("article");
    item.className = "library-item";

    const number = document.createElement("span");
    number.className = "library-index";
    number.textContent = String(index + 1).padStart(2, "0");
    number.setAttribute("aria-hidden", "true");

    const copy = document.createElement("div");
    copy.className = "library-copy";
    const title = document.createElement("strong");
    title.textContent = record.title;
    title.title = record.title;
    const meta = document.createElement("small");
    const summary = record.summary ?? {};
    meta.textContent = [
      plural(Number(summary.moves) || 0, "move"),
      formatTime(Number(summary.durationSec) || 0),
      MODES[record.settings?.mode]?.label ?? "Classical",
      formatSavedDate(record.savedAt),
    ].join(" · ");
    copy.append(title, meta);

    const actions = document.createElement("div");
    actions.className = "library-actions";

    const open = document.createElement("button");
    open.type = "button";
    open.className = "secondary-button library-open";
    open.textContent = "Open";
    open.setAttribute("aria-label", `Open ${record.title}`);
    open.addEventListener("click", () => openSavedComposition(record.id));

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "icon-button";
    remove.setAttribute("aria-label", `Remove ${record.title} from the library`);
    remove.title = "Remove from library";
    remove.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#icon-trash"></use></svg>';
    remove.addEventListener("click", () => requestDeleteComposition(record));

    actions.append(open, remove);
    item.append(number, copy, actions);
    fragment.appendChild(item);
  });
  dom.libraryList.replaceChildren(fragment);
}

async function openSavedComposition(id) {
  const record = loadSavedCompositions().find((item) => item.id === id);
  if (!record) {
    renderLibrary();
    showToast("That saved composition is no longer in the library.", { tone: "error" });
    return;
  }

  const candidate = new ChessGame();
  const result = candidate.loadPgn(record.pgn);
  if (!result.ok) {
    showToast(result.error || "The saved PGN could not be replayed.", { tone: "error" });
    return;
  }

  await applyImportedGame(candidate, {
    settings: record.settings,
    title: record.title,
    sourceLabel: "Library",
    compositionId: record.id,
    createdAt: record.createdAt,
  });
  closeDialog(dom.libraryDialog);
  updateLibraryBadge();
  showToast(`“${clipText(record.title, 48)}” reopened from your library.`, {
    tone: "success",
  });
}

function requestDeleteComposition(record) {
  openConfirm({
    title: "Remove from the library?",
    message: `“${clipText(record.title, 70)}” will be deleted from this browser. The currently open score is not changed.`,
    label: "Remove composition",
    danger: true,
    onConfirm: () => {
      const result = removeComposition(record.id);
      if (!result.ok) {
        showToast(result.error || "The composition could not be removed.", { tone: "error" });
        return;
      }
      if (state.compositionId === record.id) {
        state.sourceLabel = "Local session";
        renderSession();
      }
      renderLibrary();
      showToast("Composition removed from the library.");
      announce("Saved composition removed.");
    },
  });
}

function openLibraryDialog() {
  renderLibrary();
  openDialog(dom.libraryDialog);
}

/* --------------------------------------------------------------------------
   Offline WAV export
   -------------------------------------------------------------------------- */

const EXPORT_STAGE_COPY = {
  preparing: "Preparing the synthesizer and the reverb space…",
  scheduling: "Scheduling every note on the offline clock…",
  rendering: "Rendering the complete performance offline…",
  encoding: "Encoding 16-bit PCM and normalising the peak…",
};

function setExportProgress(value, label = null) {
  const safe = Math.max(0, Math.min(1, Number(value) || 0));
  const percent = Math.round(safe * 100);
  if (dom.exportProgressBar) dom.exportProgressBar.style.width = `${percent}%`;
  if (dom.exportProgressLabel) {
    dom.exportProgressLabel.textContent = label ?? `${percent}%`;
  }
}

function handleExportProgress(update) {
  if (!update) return;
  setExportProgress(update.progress);
  const copy = EXPORT_STAGE_COPY[update.stage];
  if (copy && dom.exportMessage) dom.exportMessage.textContent = copy;
}

function openExportOverlay() {
  document.body.classList.add("is-exporting");
  dom.exportOverlay.hidden = false;
  dom.exportOverlay.setAttribute("aria-busy", "true");
  dom.exportTitle.textContent = "Composing your WAV";
  dom.exportMessage.textContent = "Mapping the score to synthesized voices…";
  dom.exportDetail.textContent = `${formatTime(estimateWavDuration(state.composition))} of audio · ${MAX_DURATION_SECONDS / 60} min limit`;
  dom.exportCloseButton.hidden = true;
  setExportProgress(0);
}

function closeExportOverlay() {
  if (state.exportBusy) return;
  dom.exportOverlay.hidden = true;
  dom.exportOverlay.removeAttribute("aria-busy");
  document.body.classList.remove("is-exporting");
  dom.wavButton?.focus();
}

/**
 * Encode the same event/note objects used by live playback through the same mix
 * graph. The overlay reports real stages: scheduling, offline rendering and PCM
 * encoding. Browsers do not expose frame-by-frame OfflineAudioContext progress,
 * so we never display invented percentages while rendering.
 */
async function exportWav() {
  if (state.exportBusy) return;
  if (!state.composition?.events?.length) {
    showToast("Play a move before exporting a WAV.");
    return;
  }

  if (player?.playing) player.pause();
  state.exportBusy = true;
  dom.wavButton.disabled = true;
  openExportOverlay();

  try {
    const result = await renderCompositionToWav(state.composition, {
      onProgress: handleExportProgress,
    });
    setExportProgress(1, "100%");
    downloadBlob(result.blob, `${slugify(currentDisplayTitle())}.wav`);

    dom.exportTitle.textContent = "WAV ready";
    dom.exportMessage.textContent = "Your composition was rendered and downloaded. The file contains the full reverb tail.";
    dom.exportDetail.textContent = `${formatTime(result.durationSec)} · ${(result.bytes / 1_048_576).toFixed(1)} MB · 16-bit / ${Math.round(result.sampleRate / 1000)} kHz`;
    showToast(`WAV downloaded: ${plural(result.noteCount, "note")}, 16-bit stereo.`, {
      tone: "success",
      duration: 5200,
    });
    announce("WAV export complete.");
  } catch (error) {
    console.error("WAV export failed", error);
    dom.exportTitle.textContent = "The WAV could not be rendered";
    dom.exportMessage.textContent =
      error?.message || "The browser could not render this composition.";
    dom.exportDetail.textContent = "Nothing was uploaded. Try a shorter game or a recent browser.";
    setExportProgress(0, "—");
    showToast(error?.message || "The WAV could not be exported.", {
      tone: "error",
      duration: 6500,
    });
  } finally {
    state.exportBusy = false;
    dom.wavButton.disabled = !state.composition?.events?.length;
    dom.exportOverlay.setAttribute("aria-busy", "false");
    dom.exportCloseButton.hidden = false;
    dom.exportCloseButton.focus();
  }
}

/* --------------------------------------------------------------------------
   Event wiring
   -------------------------------------------------------------------------- */

function wireDialogDismissal() {
  for (const button of document.querySelectorAll("[data-close-dialog]")) {
    button.addEventListener("click", () => closeDialog(button.closest("dialog")));
  }

  for (const dialog of document.querySelectorAll("dialog")) {
    // Clicking the backdrop (the dialog element itself) closes non-destructive
    // dialogs. The WAV overlay is not a dialog and is handled separately.
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) closeDialog(dialog);
    });
    dialog.addEventListener("close", () => {
      if (dialog === dom.confirmDialog) state.pendingConfirm = null;
    });
  }

  dom.confirmActionButton.addEventListener("click", async () => {
    const action = state.pendingConfirm;
    state.pendingConfirm = null;
    closeDialog(dom.confirmDialog);
    if (typeof action !== "function") return;
    try {
      await action();
    } catch (error) {
      console.error("Confirmed action failed", error);
      showToast("That action could not be completed.", { tone: "error" });
    }
  });
}

function wireImportControls() {
  dom.importButton.addEventListener("click", openImportDialog);
  dom.pgnFile.addEventListener("change", handlePgnFile);

  const dropZone = dom.pgnFile.closest(".file-drop");
  if (dropZone) {
    for (const type of ["dragenter", "dragover"]) {
      dropZone.addEventListener(type, (event) => {
        event.preventDefault();
        dropZone.classList.add("is-dragover");
      });
    }
    for (const type of ["dragleave", "dragend"]) {
      dropZone.addEventListener(type, () => dropZone.classList.remove("is-dragover"));
    }
    dropZone.addEventListener("drop", (event) => {
      event.preventDefault();
      dropZone.classList.remove("is-dragover");
      readPgnFile(event.dataTransfer?.files?.[0]);
    });
  }

  dom.importSubmitButton.addEventListener("click", async () => {
    dom.importSubmitButton.disabled = true;
    dom.importSubmitButton.setAttribute("aria-busy", "true");
    try {
      await importFromText(dom.pgnInput.value, { sourceLabel: "Imported PGN" });
    } finally {
      dom.importSubmitButton.disabled = false;
      dom.importSubmitButton.removeAttribute("aria-busy");
    }
  });

  dom.loadDemoButton.addEventListener("click", async () => {
    dom.loadDemoButton.disabled = true;
    dom.loadDemoButton.setAttribute("aria-busy", "true");
    setImportError("");
    try {
      await importFromText(DEMO_PGN, { sourceLabel: "Curated study" });
    } finally {
      dom.loadDemoButton.disabled = false;
      dom.loadDemoButton.removeAttribute("aria-busy");
    }
  });

  // Ctrl/Cmd+Enter in the PGN textarea loads the composition.
  dom.pgnInput.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      dom.importSubmitButton.click();
    }
  });
}

function openMappingGuide() {
  renderGuide();
  openDialog(dom.mappingGuideDialog);
}

function wireHeaderAndBoardControls() {
  dom.audioButton.addEventListener("click", toggleAudio);
  dom.libraryButton.addEventListener("click", openLibraryDialog);
  dom.settingsButton.addEventListener("click", () => {
    syncSettingsControls();
    openDialog(dom.settingsDialog);
  });
  dom.saveButton.addEventListener("click", openSaveDialog);
  dom.shareButton.addEventListener("click", openShareDialog);
  dom.pgnButton.addEventListener("click", exportPgn);
  dom.wavButton.addEventListener("click", exportWav);
  dom.exportCloseButton.addEventListener("click", closeExportOverlay);

  dom.mappingButton.addEventListener("click", openMappingGuide);
  dom.mappingGuideButton.addEventListener("click", openMappingGuide);
  dom.insightOpenButton.addEventListener("click", openMappingGuide);

  dom.newGameButton.addEventListener("click", requestNewGame);
  dom.undoButton.addEventListener("click", undoLastMove);
  dom.flipButton.addEventListener("click", flipBoard);
  dom.resetPositionButton.addEventListener("click", resetToFirstPosition);
  dom.returnLiveButton.addEventListener("click", () => returnToLive());

  dom.viewStartButton.addEventListener("click", () => reviewAtPly(0));
  dom.viewPrevButton.addEventListener("click", () => reviewAtPly(state.displayPly - 1));
  dom.viewNextButton.addEventListener("click", () => reviewAtPly(state.displayPly + 1));
  dom.viewEndButton.addEventListener("click", () => reviewAtPly(state.game.moves.length));

  dom.notationForm.addEventListener("submit", submitNotation);

  // One delegated listener survives every score rebuild.
  dom.moveList.addEventListener("click", (event) => {
    const cell = event.target.closest(".move-cell[data-ply]");
    if (!cell) return;
    const ply = Number(cell.dataset.ply);
    if (
      ply >= state.game.moves.length &&
      !state.reviewing &&
      !player?.playing
    ) {
      const last = state.composition?.events?.at(-1);
      if (last) showEventMapping(last, { sounding: false, kicker: "Last move" });
      return;
    }
    reviewAtPly(ply, { keepPlaying: Boolean(player?.playing) });
  });

  dom.timelineEvents.addEventListener("click", (event) => {
    const node = event.target.closest(".timeline-event[data-event-index]");
    if (!node) return;
    const ply = Number(node.dataset.eventIndex) + 1;
    if (
      ply >= state.game.moves.length &&
      !state.reviewing &&
      !player?.playing
    ) {
      const last = state.composition?.events?.at(-1);
      if (last) showEventMapping(last, { sounding: false, kicker: "Last move" });
      return;
    }
    reviewAtPly(ply, { keepPlaying: Boolean(player?.playing) });
  });
}

function wireTransportControls() {
  dom.playerPlayButton.addEventListener("click", togglePlayback);
  dom.playerStartButton.addEventListener("click", restartPlayback);
  dom.playerPrevButton.addEventListener("click", () => stepEvent(-1));
  dom.playerNextButton.addEventListener("click", () => stepEvent(1));
  dom.playerStopButton.addEventListener("click", stopPlayback);

  dom.compositionProgress.addEventListener("input", () => {
    const totalBeats = state.composition?.beatCount ?? 0;
    const value = Number(dom.compositionProgress.value) / 1000;
    seekToBeat(value * totalBeats);
  });

  dom.playerTempo.addEventListener("input", () => {
    const value = Number(dom.playerTempo.value);
    dom.playerTempoOutput.textContent = `${Math.round(value)} bpm`;
    updateRangeFill(dom.playerTempo);
    dom.settingTempo.value = String(value);
    dom.settingTempoOutput.textContent = `${Math.round(value)} bpm`;
    updateRangeFill(dom.settingTempo);

    state.settings = sanitizeSettings({ ...state.settings, tempo: value });
    player?.setTempo(state.settings.tempo);
    saveSettingsDebounced();
    updateCompositionTiming();
    renderSession();
    renderCompositionSummary();
    renderTransport(player?.getSnapshot());
  });

  // Commit the final tempo when the thumb is released. This also persists the
  // exact sanitized value and refreshes any open mapping guide next time.
  dom.playerTempo.addEventListener("change", () => {
    applySettingsPatch({ tempo: Number(dom.playerTempo.value) }, { mapping: false });
  });
}

function wireSettingsControls() {
  for (const [element, key] of [
    [dom.settingRhythm, "rhythm"],
    [dom.settingRoot, "rootNote"],
    [dom.settingScale, "scale"],
    [dom.settingRegister, "register"],
    [dom.settingWhiteVoice, "whiteVoice"],
    [dom.settingBlackVoice, "blackVoice"],
  ]) {
    element.addEventListener("change", () => {
      applySettingsPatch({ [key]: element.value }, { mapping: true });
    });
  }
  dom.settingMode.addEventListener("change", () => applyMode(dom.settingMode.value));

  // Range inputs update their readout continuously. Expensive musical rebuilds
  // wait for `change`; volume and reverb reach the live graph immediately.
  const bindSlider = ({ input, output, key, format, mapping }) => {
    input.addEventListener("input", () => {
      const value = Number(input.value);
      output.textContent = format(value);
      updateRangeFill(input);

      if (key === "tempo") {
        dom.playerTempo.value = input.value;
        dom.playerTempoOutput.textContent = format(value);
        updateRangeFill(dom.playerTempo);
        state.settings = sanitizeSettings({ ...state.settings, tempo: value });
        player?.setTempo(state.settings.tempo);
        saveSettingsDebounced();
        updateCompositionTiming();
        renderSession();
        renderCompositionSummary();
        renderTransport(player?.getSnapshot());
      } else if (key === "masterVolume" || key === "reverb") {
        state.settings = sanitizeSettings({ ...state.settings, [key]: value });
        audio?.updateSettings(state.settings);
        saveSettingsDebounced();
      }
    });
    input.addEventListener("change", () => {
      applySettingsPatch({ [key]: Number(input.value) }, { mapping });
    });
  };

  bindSlider({
    input: dom.settingTempo,
    output: dom.settingTempoOutput,
    key: "tempo",
    format: (value) => `${Math.round(value)} bpm`,
    mapping: false,
  });
  bindSlider({
    input: dom.settingNoteLength,
    output: dom.settingNoteLengthOutput,
    key: "noteLength",
    format: (value) => `${value.toFixed(2)}×`,
    mapping: true,
  });
  bindSlider({
    input: dom.settingIntensity,
    output: dom.settingIntensityOutput,
    key: "instrumentIntensity",
    format: (value) => `${Math.round(value * 100)}%`,
    mapping: true,
  });
  bindSlider({
    input: dom.settingVolume,
    output: dom.settingVolumeOutput,
    key: "masterVolume",
    format: (value) => `${Math.round(value * 100)}%`,
    mapping: false,
  });
  bindSlider({
    input: dom.settingReverb,
    output: dom.settingReverbOutput,
    key: "reverb",
    format: (value) => `${Math.round(value * 100)}%`,
    mapping: false,
  });

  for (const [element, key, mapping] of [
    [dom.effectCaptures, "effectCaptures", true],
    [dom.effectChecks, "effectChecks", true],
    [dom.effectPromotions, "effectPromotions", true],
    [dom.effectCheckmate, "effectCheckmate", true],
    [dom.visualWaveform, "showWaveform", false],
    [dom.visualPiano, "showPiano", false],
    [dom.settingReducedMotion, "reduceMotion", false],
    [dom.settingAutoscroll, "autoScrollMoves", false],
  ]) {
    element.addEventListener("change", () => {
      applySettingsPatch({ [key]: element.checked }, { mapping });
    });
  }

  dom.restoreDefaultsButton.addEventListener("click", () => {
    openConfirm({
      title: "Restore default settings?",
      message:
        "Harmony, voices, tempo and visual preferences will return to the studio defaults. Your current score and saved library are untouched.",
      label: "Restore defaults",
      danger: true,
      onConfirm: restoreDefaults,
    });
  });
}

function wireSaveAndShareControls() {
  dom.saveConfirmButton.addEventListener("click", confirmSave);
  dom.saveTitleInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      confirmSave();
    }
  });

  if (dom.copyShareButton) {
    dom.copyShareButton.addEventListener("click", copyShareLink);
  }

  dom.shareUrlInput.addEventListener("focus", () => dom.shareUrlInput.select());
}

function wireKeyboardShortcuts() {
  document.addEventListener("keydown", (event) => {
    // The WAV overlay owns Escape while a render is running.
    if (!dom.exportOverlay.hidden) {
      if (event.key === "Escape" && !state.exportBusy) {
        event.preventDefault();
        closeExportOverlay();
      }
      return;
    }

    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    if (document.querySelector("dialog[open]")) return;

    const target = event.target;
    if (
      target instanceof Element &&
      target.closest(
        "input, textarea, select, button, a, summary, [contenteditable='true'], #board",
      )
    ) {
      return;
    }

    let handled = true;
    switch (event.key) {
      case " ":
      case "Spacebar":
        if (state.composition?.events?.length) togglePlayback();
        break;
      case "ArrowLeft":
        stepEvent(-1);
        break;
      case "ArrowRight":
        stepEvent(1);
        break;
      case "Home":
        if (state.game.moves.length) reviewAtPly(0);
        break;
      case "End":
        if (state.game.moves.length) reviewAtPly(state.game.moves.length);
        break;
      case "Escape":
        if (state.reviewing || player?.playing) returnToLive();
        else handled = false;
        break;
      case "u":
      case "U":
        if (!dom.undoButton.disabled) undoLastMove();
        else handled = false;
        break;
      case "f":
      case "F":
        flipBoard();
        break;
      case "?":
        openMappingGuide();
        break;
      default:
        handled = false;
    }
    if (handled) event.preventDefault();
  });
}

function wireAllControls() {
  wireDialogDismissal();
  wireImportControls();
  wireHeaderAndBoardControls();
  wireTransportControls();
  wireSettingsControls();
  wireSaveAndShareControls();
  wireKeyboardShortcuts();
}

/* --------------------------------------------------------------------------
   Bootstrap and teardown
   -------------------------------------------------------------------------- */

function createBoardView() {
  return new BoardView(dom.board, {
    onMove: handleBoardMove,
    onMoveFinished: handleBoardMoveFinished,
    getFen: () => state.game.fen,
    canInteract: () =>
      !state.reviewing && !player?.playing && state.game.canInteract,
    legalMovesFrom: (square) => state.game.legalMovesFrom(square),
    needsPromotion: (from, to) => state.game.needsPromotion(from, to),
    onInputError: (message) => {
      if (!message) return;
      showToast(message, { tone: "error" });
      announce(message);
    },
  });
}

function createVisualizer() {
  return new Visualizer({
    canvas: dom.visualizer,
    piano: dom.piano,
    analyserReadout: dom.analyserReadout,
    timbreReadout: dom.timbreReadout,
    overlay: dom.visualizerOverlay,
    getAnalyserData: () => audio?.getAnalyserData() ?? { frequency: null, waveform: null },
    getSampleRate: () => audio?.context?.sampleRate ?? 44_100,
    getAudioReady: () => audioRunning(),
    reducedMotion: state.settings.reduceMotion,
    showWaveform: state.settings.showWaveform,
    showPiano: state.settings.showPiano,
  });
}

async function init() {
  populateSettingsControls();
  updateLibraryBadge();
  renderGuide();

  // The audio engine is created immediately but its context is not opened until
  // a user gesture calls ensureAudio(); this satisfies autoplay policies.
  audio = new AudioEngine();
  audio.subscribeState(() => updateAudioUI());

  player = new CompositionPlayer({
    audio,
    onUpdate: handlePlayerUpdate,
  });
  boardView = createBoardView();
  visualizer = createVisualizer();

  wireAllControls();
  refreshRuntimeSettings();
  syncSettingsControls();
  showIdleNow();
  updateAudioUI();

  await rebuildComposition({ syncPlayer: true });
  renderStatusAndChrome();
  renderTransport(player.getSnapshot());
  renderSession();
  renderCompositionSummary();
  renderTimeline();
  renderScore();
  renderMappingPreview();

  // A share link is parsed only after the complete studio exists, so a damaged
  // link can safely open the import dialog with its diagnostics.
  await loadSharedLinkOnStartup();
}

function cleanup() {
  if (settingsSaveTimer) {
    window.clearTimeout(settingsSaveTimer);
    settingsSaveTimer = null;
    savePreferences(state.settings);
  }
  if (state.liveTimer) window.clearTimeout(state.liveTimer);
  if (state.effectTimer) window.clearTimeout(state.effectTimer);
  player?.destroy();
  visualizer?.destroy();
  boardView?.destroy();
  audio?.destroy();
}

window.addEventListener("pagehide", (event) => {
  if (!event.persisted) cleanup();
});

init().catch((error) => {
  console.error("CHESSOUND could not start", error);
  showToast(
    "The studio could not start. Reload the page; if the problem persists, try a recent browser.",
    { tone: "error", duration: 8000 },
  );
  announce("The studio could not start.");
});

