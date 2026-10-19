/**
 * ChessGame — a small, UI-independent wrapper around chess.js.
 *
 * chess.js owns all rules, castling, en passant, promotion, check and draw
 * detection. This controller adds history navigation, branching, PGN metadata
 * and the exact verbose move objects consumed by the music mapping engine.
 */

import { Chess } from "chess.js";
import { START_FEN } from "./config.js";

function today() {
  return new Date().toISOString().slice(0, 10).replaceAll("-", ".");
}

function describeError(error) {
  const message = String(error?.message ?? error ?? "Unknown PGN error");
  return message
    .replace(/^Invalid FEN: /, "Invalid starting position: ")
    .replace(/^Invalid move in PGN: /, "Invalid move in PGN: ");
}

export class ChessGame {
  constructor() {
    this.chess = new Chess();
    this.startFen = START_FEN;
    this.moves = [];
    this.cursor = 0;
    this.headers = this._defaultHeaders();
  }

  _defaultHeaders() {
    return {
      Event: "CHESSOUND local match",
      Site: "Local studio",
      Date: today(),
      Round: "-",
      White: "White",
      Black: "Black",
      Result: "*",
    };
  }

  get fen() {
    return this.chess.fen();
  }

  get turn() {
    return this.chess.turn();
  }

  get fullMoveCount() {
    return this.moves.length;
  }

  get viewMoveCount() {
    return this.cursor;
  }

  get atLatestPosition() {
    return this.cursor === this.moves.length;
  }

  get lastMove() {
    return this.cursor > 0 ? this.moves[this.cursor - 1] : null;
  }

  get canInteract() {
    return this.atLatestPosition && !this.chess.isGameOver();
  }

  isLegalMove(from, to, promotion = "q") {
    if (!from || !to) return null;
    try {
      return (
        this.chess
          .moves({ verbose: true, square: from })
          .find((move) => move.to === to && (!move.promotion || move.promotion === promotion)) ?? null
      );
    } catch {
      return null;
    }
  }

  needsPromotion(from, to) {
    return this.chess
      .moves({ verbose: true, square: from })
      .some((move) => move.to === to && Boolean(move.promotion));
  }

  legalMovesFrom(square) {
    try {
      return this.chess.moves({ verbose: true, square }).filter((move) => move.promotion === undefined || move.promotion === "q");
    } catch {
      return [];
    }
  }

  /**
   * Make a legal chess move. If the user had navigated into the past and makes
   * a new move, the future mainline is deliberately truncated (a chess branch).
   */
  makeMove(from, to, promotion = "q") {
    if (!from || !to) return { ok: false, error: "Choose a starting and destination square." };
    if (!this.atLatestPosition) {
      this.moves = this.moves.slice(0, this.cursor);
    }
    let move;
    try {
      move = this.chess.move({
        from: String(from).toLowerCase(),
        to: String(to).toLowerCase(),
        promotion: String(promotion).toLowerCase(),
      });
    } catch (error) {
      return { ok: false, error: "That move is not legal in this position." };
    }
    if (!move) return { ok: false, error: "That move is not legal in this position." };
    this.moves.push(move);
    this.cursor = this.moves.length;
    return { ok: true, move };
  }

  rebuildAt(ply) {
    const target = Math.max(0, Math.min(this.moves.length, Math.round(ply)));
    this.cursor = target;
    this.chess = new Chess(this.startFen);
    for (let index = 0; index < target; index += 1) {
      const move = this.moves[index];
      try {
        this.chess.move({
          from: move.from,
          to: move.to,
          ...(move.promotion ? { promotion: move.promotion } : {}),
        });
      } catch {
        // If persisted data were truncated/corrupt, fail to the last valid ply
        // instead of leaving an inconsistent board.
        this.cursor = index;
        this.moves = this.moves.slice(0, index);
        break;
      }
    }
    return this.cursor;
  }

  goToStart() {
    return this.rebuildAt(0);
  }

  goToEnd() {
    return this.rebuildAt(this.moves.length);
  }

  previousMove() {
    return this.rebuildAt(this.cursor - 1);
  }

  nextMove() {
    return this.rebuildAt(this.cursor + 1);
  }

  goToMove(ply) {
    return this.rebuildAt(ply);
  }

  resetPosition() {
    this.rebuildAt(0);
  }

  undoMove() {
    if (this.cursor <= 0) return { ok: false, error: "There is no move to undo." };
    const removed = this.moves[this.cursor - 1];
    this.moves = this.moves.slice(0, this.cursor - 1);
    this.cursor = this.moves.length;
    this.rebuildAt(this.cursor);
    return { ok: true, move: removed };
  }

  newGame(startFen = START_FEN) {
    this.startFen = startFen;
    this.moves = [];
    this.cursor = 0;
    this.headers = this._defaultHeaders();
    this.chess = new Chess(startFen);
    return { ok: true };
  }

  /**
   * Import a PGN from text or a file. Parsing is attempted on a throwaway board
   * so a malformed PGN can never destroy the current match.
   */
  loadPgn(pgn) {
    const source = String(pgn ?? "").trim();
    if (!source) return { ok: false, error: "Paste or upload a PGN with at least one move." };
    const parser = new Chess();
    try {
      parser.loadPgn(source);
    } catch (error) {
      return { ok: false, error: `Invalid PGN: ${describeError(error)}` };
    }
    const moves = parser.history({ verbose: true });
    if (!moves.length) {
      return { ok: false, error: "No legal moves were found in this PGN." };
    }

    const headers = { ...this._defaultHeaders() };
    const parsedHeaders = parser.header?.() ?? {};
    const validHeaderKeys = ["Event", "Site", "Date", "Round", "White", "Black", "Result"];
    for (const key of validHeaderKeys) {
      const value = parsedHeaders[key];
      if (
        typeof value === "string" &&
        value.trim() &&
        value !== "?" &&
        value !== "????.??.??"
      ) {
        headers[key] = value.trim();
      }
    }
    this.startFen = moves[0].before || START_FEN;
    this.moves = moves;
    this.headers = headers;
    this.cursor = moves.length;
    this.chess = new Chess(this.startFen);
    for (const move of moves) {
      try {
        this.chess.move({
          from: move.from,
          to: move.to,
          ...(move.promotion ? { promotion: move.promotion } : {}),
        });
      } catch (error) {
        this.newGame();
        return { ok: false, error: `PGN could not be replayed: ${describeError(error)}` };
      }
    }
    return { ok: true, moves, headers };
  }

  getStatus() {
    const game = this.chess;
    const turnLabel = game.turn() === "w" ? "White" : "Black";
    if (game.isCheckmate()) {
      const winner = game.turn() === "w" ? "Black" : "White";
      return { key: "checkmate", label: "Checkmate", detail: `${winner} wins the match`, tone: "mate" };
    }
    if (game.isStalemate()) {
      return { key: "stalemate", label: "Stalemate", detail: "Draw — no legal moves remain", tone: "draw" };
    }
    if (game.isInsufficientMaterial()) {
      return { key: "insufficient", label: "Draw", detail: "Insufficient material", tone: "draw" };
    }
    if (game.isThreefoldRepetition()) {
      return { key: "repetition", label: "Draw", detail: "Threefold repetition", tone: "draw" };
    }
    if (game.isDrawByFiftyMoves()) {
      return { key: "fifty", label: "Draw", detail: "Fifty-move rule", tone: "draw" };
    }
    if (game.isDraw()) {
      return { key: "draw", label: "Draw", detail: "The position is drawn", tone: "draw" };
    }
    if (game.isCheck()) {
      return { key: "check", label: "Check", detail: `${turnLabel} must answer the attack`, tone: "check" };
    }
    return {
      key: "normal",
      label: `${turnLabel} to move`,
      detail: this.cursor === 0 ? "The opening position" : `Move ${Math.floor(this.cursor / 2) + 1}`,
      tone: "normal",
    };
  }

  getResultToken() {
    const status = this.getStatus();
    if (status.key === "checkmate") {
      const last = this.lastMove;
      return last?.color === "w" ? "1-0" : "0-1";
    }
    if (["stalemate", "insufficient", "repetition", "fifty", "draw"].includes(status.key)) {
      return "1/2-1/2";
    }
    return this.headers.Result && ["1-0", "0-1", "1/2-1/2"].includes(this.headers.Result)
      ? this.headers.Result
      : "*";
  }

  getPlayerMeta() {
    const clean = (value, fallback) =>
      typeof value === "string" && value.trim() && value !== "?" && value !== "????.??.??"
        ? value
        : fallback;
    return {
      white: clean(this.headers.White, "White"),
      black: clean(this.headers.Black, "Black"),
      event: clean(this.headers.Event, "CHESSOUND local match"),
      date: clean(this.headers.Date, ""),
      result: this.getResultToken(),
      site: clean(this.headers.Site, "Local studio"),
    };
  }

  /**
   * Serialize the current mainline (or a selected prefix) as standards-compliant
   * PGN. Replaying from the recorded start FEN preserves imported positions.
   */
  toPgn({ upTo = this.cursor } = {}) {
    const target = Math.max(0, Math.min(this.moves.length, upTo));
    const output = new Chess(this.startFen);
    for (let index = 0; index < target; index += 1) {
      const move = this.moves[index];
      try {
        output.move({
          from: move.from,
          to: move.to,
          ...(move.promotion ? { promotion: move.promotion } : {}),
        });
      } catch {
        break;
      }
    }
    const meta = this.getPlayerMeta();
    const result = target === this.moves.length ? this.getResultToken() : "*";
    output.header("Event", meta.event);
    output.header("Site", meta.site);
    output.header("Date", meta.date || today());
    output.header("Round", this.headers.Round || "-");
    output.header("White", meta.white);
    output.header("Black", meta.black);
    output.header("Result", result);
    if (this.startFen !== START_FEN) {
      output.header("SetUp", "1");
      output.header("FEN", this.startFen);
    }
    return output.pgn();
  }

  toCompositionMeta() {
    return {
      pgn: this.toPgn({ upTo: this.moves.length }),
      startFen: this.startFen,
      ...this.getPlayerMeta(),
    };
  }
}
