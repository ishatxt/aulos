/**
 * Game-state and import/export regression tests. They exercise the same
 * chess.js rules used by the board UI without needing a DOM.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { Chess } from "chess.js";
import { ChessGame } from "../src/chess-game.js";
import { START_FEN } from "../src/config.js";
import { buildComposition } from "../src/music-mapping.js";

const PGN = `[Event "Test Match"]
[Site "Local"]
[Date "2026.03.01"]
[Round "1"]
[White "Ada"]
[Black "Grace"]
[Result "1-0"]

1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0`;

test("makeMove accepts legal chess and rejects illegal moves", () => {
  const game = new ChessGame();
  assert.equal(game.makeMove("e2", "e4").ok, true);
  assert.equal(game.makeMove("e4", "e5").ok, false);
  assert.equal(game.makeMove("e7", "e5").ok, true);
  assert.equal(game.fen.split(" ")[0], "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR");
  assert.equal(game.turn, "w");
  assert.equal(game.viewMoveCount, 2);
});

test("undo removes the last move and supports playable rewind", () => {
  const game = new ChessGame();
  game.makeMove("e2", "e4");
  game.makeMove("e7", "e5");
  game.previousMove();
  assert.equal(game.viewMoveCount, 1);
  assert.equal(game.atLatestPosition, false);
  game.nextMove();
  assert.equal(game.viewMoveCount, 2);
  assert.equal(game.undoMove().ok, true);
  assert.equal(game.viewMoveCount, 1);
  assert.equal(game.fullMoveCount, 1);
  assert.equal(game.atLatestPosition, true);
});

test("moving from a rewind creates a clean new branch", () => {
  const game = new ChessGame();
  game.makeMove("e2", "e4");
  game.makeMove("e7", "e5");
  game.makeMove("g1", "f3");
  game.goToMove(1);
  assert.equal(game.turn, "b");
  const result = game.makeMove("c7", "c5");
  assert.equal(result.ok, true);
  assert.equal(game.fullMoveCount, 2);
  assert.equal(game.moves[1].san, "c5");
  assert.equal(game.atLatestPosition, true);
});

test("PGN import preserves moves, players and can build a composition", () => {
  const game = new ChessGame();
  const result = game.loadPgn(PGN);
  assert.equal(result.ok, true);
  assert.equal(game.fullMoveCount, 7);
  assert.equal(game.getPlayerMeta().white, "Ada");
  assert.equal(game.getPlayerMeta().black, "Grace");
  assert.equal(game.getStatus().key, "checkmate");
  assert.equal(game.getResultToken(), "1-0");
  const composition = buildComposition(game.moves, undefined, game.toCompositionMeta());
  assert.equal(composition.events.length, 7);
  assert.equal(composition.result, "1-0");
  assert.equal(composition.players.white, "Ada");
});

test("invalid PGN is reported without destroying the current match", () => {
  const game = new ChessGame();
  game.makeMove("d2", "d4");
  const before = game.fen;
  const result = game.loadPgn("1. e4 e5 2. Qh9 nonsense");
  assert.equal(result.ok, false);
  assert.match(result.error, /Invalid PGN/);
  assert.equal(game.fen, before);
  assert.equal(game.fullMoveCount, 1);
});

test("empty PGN imports are rejected clearly", () => {
  const game = new ChessGame();
  const result = game.loadPgn(" \n ");
  assert.equal(result.ok, false);
  assert.match(result.error, /at least one move/i);
});

test("PGN export is valid and round-trips through chess.js", () => {
  const game = new ChessGame();
  game.loadPgn(PGN);
  const exported = game.toPgn({ upTo: 5 });
  assert.match(exported, /\[White "Ada"\]/);
  const reimported = new Chess();
  reimported.loadPgn(exported);
  assert.equal(reimported.history().length, 5);
  assert.equal(reimported.history().at(-1), "Bc4");
});

test("promotion requires a piece choice and applies it legally", () => {
  const game = new ChessGame();
  game.newGame("4k3/P7/8/8/8/8/8/4K3 w - - 0 1");
  assert.equal(game.needsPromotion("a7", "a8"), true);
  const result = game.makeMove("a7", "a8", "q");
  assert.equal(result.ok, true);
  assert.equal(result.move.promotion, "q");
  assert.equal(result.move.san, "a8=Q+");
});

test("castling and en passant remain delegated to chess.js", () => {
  const game = new ChessGame();
  for (const [from, to] of [
    ["e2", "e4"],
    ["e7", "e5"],
    ["g1", "f3"],
    ["b8", "c6"],
    ["f1", "c4"],
    ["g8", "f6"],
    ["e1", "g1"],
    ["f6", "e4"],
    ["d2", "d4"],
    ["e5", "d4"],
    ["f3", "e5"],
    ["d7", "d5"],
    ["e5", "d3"],
    ["c6", "e5"],
    ["c1", "f4"],
    ["e4", "g5"],
    ["f4", "g5"],
    ["f7", "f6"],
    ["d3", "e5"],
    ["f6", "e5"],
  ]) {
    const result = game.makeMove(from, to);
    assert.equal(result.ok, true, `${from}${to} should be legal`);
  }
  assert.ok(game.moves.some((move) => move.flags.includes("k")));
});

test("en passant is recognized by chess.js and passed through unchanged", () => {
  const game = new ChessGame();
  for (const [from, to] of [
    ["e2", "e4"],
    ["a7", "a6"],
    ["e4", "e5"],
    ["d7", "d5"],
    ["e5", "d6"],
  ]) {
    const result = game.makeMove(from, to);
    assert.equal(result.ok, true, `${from}${to} should be legal`);
  }
  const enPassant = game.moves.at(-1);
  assert.equal(enPassant.san, "exd6");
  assert.ok(enPassant.flags.includes("e"));
  assert.equal(game.chess.get("d6")?.color, "w");
  assert.equal(game.chess.get("d5"), undefined);
});

test("custom start position produces a SetUp/FEN PGN header", () => {
  const fen = "4k3/8/8/8/8/8/4P3/4K3 w - - 0 1";
  const game = new ChessGame();
  game.newGame(fen);
  game.makeMove("e2", "e4");
  const pgn = game.toPgn();
  assert.match(pgn, /\[SetUp "1"\]/);
  assert.match(pgn, new RegExp(`\\[FEN "${fen.replace(/[()]/g, "\\$&")}"\\]`));
  const chess = new Chess();
  chess.loadPgn(pgn);
  assert.equal(chess.history()[0], "e4");
});

test("newGame clears history while leaving a valid starting board", () => {
  const game = new ChessGame();
  game.makeMove("e2", "e4");
  game.newGame();
  assert.equal(game.fullMoveCount, 0);
  assert.equal(game.fen, START_FEN);
});
