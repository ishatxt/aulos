/**
 * BoardView — the cm-chessboard integration layer.
 *
 * This module owns everything visual about the board: the SVG board, input
 * validation, legal-move markers, promotion dialog, last-move/check highlights
 * and orientation. The application remains the source of truth: BoardView asks
 * it to validate and perform every move, then synchronises the SVG from the
 * resulting FEN (which also covers castling rooks and en-passant captures).
 */

import {
  BORDER_TYPE,
  Chessboard,
  COLOR,
  INPUT_EVENT_TYPE,
} from "cm-chessboard";
import { Markers, MARKER_TYPE } from "cm-chessboard/src/extensions/markers/Markers.js";
import {
  PROMOTION_DIALOG_RESULT_TYPE,
  PromotionDialog,
} from "cm-chessboard/src/extensions/promotion-dialog/PromotionDialog.js";
import { Accessibility } from "cm-chessboard/src/extensions/accessibility/Accessibility.js";
import { START_FEN } from "./config.js";

// Custom marker types reuse the shipped marker sprites, while their classes let
// the CHESSOUND stylesheet colour them independently.
const LAST_MOVE_MARKER = { class: "cs-marker-last", slice: "markerSquare" };
const ACTIVE_MARKER = { class: "cs-marker-active", slice: "markerSquare" };
const CHECK_MARKER = { class: "cs-marker-check", slice: "markerFrame" };

const DEFAULT_ANIMATION_MS = 260;

function normaliseOrientation(color) {
  return color === COLOR.black || color === "b" ? COLOR.black : COLOR.white;
}

export class BoardView {
  /**
   * @param {HTMLElement} container
   * @param {{
   *   onMove: (from: string, to: string, promotion: string) => {ok: boolean},
   *   onMoveFinished?: (result: object) => void,
   *   getFen: () => string,
   *   canInteract: () => boolean,
   *   legalMovesFrom: (square: string) => object[],
   *   needsPromotion: (from: string, to: string) => {color: string} | null,
   *   getHighlights: () => {from?: string, to?: string, check?: string, active?: string},
   *   onInputError?: (message: string) => void,
   * }} callbacks
   */
  constructor(container, callbacks) {
    this.container = container;
    this.callbacks = callbacks;
    this.boardStage = container.closest(".board-stage");
    this.pendingPromotion = false;
    this.committedFromInput = false;
    this.highlights = {};
    this.orientation = "w";
    this.reducedMotion = false;

    const baseUrl = import.meta.env.BASE_URL || "/";
    const assetsUrl = `${baseUrl.replace(/\/$/, "")}/cm-assets/`;

    this.board = new Chessboard(container, {
      position: START_FEN,
      orientation: COLOR.white,
      responsive: true,
      assetsUrl,
      assetsCache: true,
      style: {
        cssClass: "chessound",
        showCoordinates: true,
        borderType: BORDER_TYPE.none,
        aspectRatio: 1,
        animationDuration: DEFAULT_ANIMATION_MS,
      },
      extensions: [
        {
          class: Markers,
          props: {
            autoMarkers: MARKER_TYPE.frame,
          },
        },
        {
          class: PromotionDialog,
          props: { language: "en" },
        },
        {
          class: Accessibility,
          props: {
            language: "en",
            brailleNotationInAlt: true,
            movePieceForm: false,
            boardAsTable: false,
            piecesAsList: false,
            keyboardMoveInput: true,
            visuallyHidden: true,
          },
        },
      ],
    });

    this.inputHandler = this.inputHandler.bind(this);
    this.board.enableMoveInput(this.inputHandler);
  }

  get orientationColor() {
    return this.orientation;
  }

  /** Turn or set the board side without changing the game position. */
  async setOrientation(color) {
    this.orientation = normaliseOrientation(color) === COLOR.black ? "b" : "w";
    await this.board.setOrientation(
      this.orientation === "b" ? COLOR.black : COLOR.white,
      !this.reducedMotion,
    );
  }

  /** Set the visual position. Callers own legality and game state. */
  async render(fen, { animated = false } = {}) {
    if (!fen) return;
    await this.board.setPosition(fen, animated && !this.reducedMotion);
  }

  setInteractive(interactive) {
    if (interactive) {
      if (!this.board.isMoveInputEnabled()) this.board.enableMoveInput(this.inputHandler);
    } else {
      if (this.board.isMoveInputEnabled()) {
        this.board.cancelMoveInput();
        this.board.disableMoveInput();
      }
      this.clearLegalMarkers();
    }
  }

  setReducedMotion(reduce) {
    this.reducedMotion = Boolean(reduce);
    this.board.props.style.animationDuration = reduce ? 0 : DEFAULT_ANIMATION_MS;
  }

  /**
   * Highlight the last move, a check and the currently sounding destination.
   * Markers are drawn after the pieces layer and therefore read clearly on both
   * square colours without obscuring the pieces.
   */
  setHighlights({ from = null, to = null, check = null, active = null } = {}) {
    this.highlights = { from, to, check, active };
    this.applyHighlights();
  }

  applyHighlights() {
    if (!this.board) return;
    this.board.removeMarkers(LAST_MOVE_MARKER);
    this.board.removeMarkers(CHECK_MARKER);
    this.board.removeMarkers(ACTIVE_MARKER);

    const { from, to, check, active } = this.highlights;
    if (from) this.board.addMarker(LAST_MOVE_MARKER, from);
    if (to) this.board.addMarker(LAST_MOVE_MARKER, to);
    if (check) this.board.addMarker(CHECK_MARKER, check);
    if (active) this.board.addMarker(ACTIVE_MARKER, active);
  }

  addLegalMarkers(from) {
    if (!from || !this.board.addLegalMovesMarkers) return;
    const moves = this.callbacks.legalMovesFrom?.(from) ?? [];
    if (moves.length) this.board.addLegalMovesMarkers(moves);
  }

  clearLegalMarkers() {
    if (this.board?.removeLegalMovesMarkers) this.board.removeLegalMovesMarkers();
  }

  flashInputError(message = "That move is not legal here.") {
    if (this.boardStage) {
      this.boardStage.classList.remove("is-input-error");
      // Force a reflow so repeated illegal attempts restart the animation.
      void this.boardStage.offsetWidth;
      this.boardStage.classList.add("is-input-error");
      window.setTimeout(() => this.boardStage.classList.remove("is-input-error"), 380);
    }
    this.callbacks.onInputError?.(message);
  }

  inputHandler(event) {
    switch (event.type) {
      case INPUT_EVENT_TYPE.moveInputStarted: {
        if (!this.callbacks.canInteract?.()) return false;
        const legalMoves = this.callbacks.legalMovesFrom?.(event.squareFrom) ?? [];
        if (!legalMoves.length) return false;
        this.committedFromInput = false;
        this.clearLegalMarkers();
        this.addLegalMarkers(event.squareFrom);
        return true;
      }

      case INPUT_EVENT_TYPE.movingOverSquare:
        return true;

      case INPUT_EVENT_TYPE.validateMoveInput: {
        if (!this.callbacks.canInteract?.()) return false;
        const { squareFrom, squareTo } = event;

        // Promotion needs a choice before the move can be committed. Returning
        // false cancels the visual input; the dialog callback performs the move.
        const promotion = this.callbacks.needsPromotion?.(squareFrom, squareTo);
        if (promotion) {
          this.clearLegalMarkers();
          this.pendingPromotion = true;
          const piece = this.board.getPiece(squareFrom) || promotion.color + "p";
          const color = piece.charAt(0) === "b" ? COLOR.black : COLOR.white;
          this.board.showPromotionDialog?.(squareTo, color, (result) => {
            this.pendingPromotion = false;
            if (result.type !== PROMOTION_DIALOG_RESULT_TYPE.pieceSelected) return;
            const promotionPiece = String(result.piece || "").slice(1) || "q";
            this.commitMove(squareFrom, squareTo, promotionPiece, {
              animate: true,
              fromDialog: true,
            });
          });
          return false;
        }

        const result = this.callbacks.onMove?.(squareFrom, squareTo, "q");
        if (!result?.ok) {
          this.committedFromInput = false;
          this.flashInputError(result?.error);
          return false;
        }

        this.committedFromInput = true;
        this.clearLegalMarkers();
        return true;
      }

      case INPUT_EVENT_TYPE.moveInputCanceled:
        this.committedFromInput = false;
        this.clearLegalMarkers();
        return undefined;

      case INPUT_EVENT_TYPE.moveInputFinished: {
        this.clearLegalMarkers();
        if (this.pendingPromotion) return;
        if (!event.legalMove || !this.committedFromInput) {
          this.committedFromInput = false;
          return;
        }
        this.committedFromInput = false;
        // Synchronise from the authoritative FEN so castling rooks, en-passant
        // captures and promotion piece swaps are all reflected immediately.
        this.render(this.callbacks.getFen?.(), { animated: false })
          .then(() => {
            this.applyHighlights();
            this.callbacks.onMoveFinished?.({ from: event.squareFrom, to: event.squareTo });
          })
          .catch((error) => console.error("Board synchronisation failed", error));
        return undefined;
      }

      default:
        return undefined;
    }
  }

  /**
   * Commit a move that did not originate from the board's own visual input,
   * such as a promotion choice completed through the dialog.
   */
  async commitMove(from, to, promotion = "q", { animate = true, fromDialog = false } = {}) {
    const result = this.callbacks.onMove?.(from, to, promotion);
    if (!result?.ok) {
      this.flashInputError(result?.error);
      return false;
    }
    this.committedFromInput = false;
    this.clearLegalMarkers();
    await this.render(this.callbacks.getFen?.(), { animated: animate });
    this.applyHighlights();
    this.callbacks.onMoveFinished?.({ from, to, promotion, fromDialog });
    return true;
  }

  focus() {
    const focusTarget = this.container.querySelector("svg.cm-chessboard");
    focusTarget?.focus?.();
  }

  destroy() {
    try {
      this.board.destroy();
    } catch (error) {
      console.error("Board cleanup failed", error);
    }
  }
}

export { MARKER_TYPE, COLOR };
