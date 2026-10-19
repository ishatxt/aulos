/**
 * Share codes are UTF-8 JSON compressed only by base64url encoding. They carry
 * the PGN and the musical settings, which is all that is needed to reconstruct
 * an identical composition. Nothing leaves the browser unless the user copies
 * or shares the resulting link.
 */

import { sanitizeSettings } from "./config.js";

const PREFIX = "CS1.";
const MAX_CODE_LENGTH = 250_000;

function bytesToBase64Url(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value) {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function encodeShareCode({ pgn, settings, title }) {
  const source = String(pgn ?? "").trim();
  if (!source) throw new Error("There is no game to share yet.");
  const payload = {
    v: 1,
    pgn: source,
    settings: sanitizeSettings(settings),
    title: typeof title === "string" ? title.slice(0, 120) : "",
  };
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  return PREFIX + bytesToBase64Url(bytes);
}

export function decodeShareCode(code) {
  const raw = String(code ?? "").trim();
  if (!raw.startsWith(PREFIX)) {
    throw new Error("This is not a CHESSOUND share code.");
  }
  if (raw.length > MAX_CODE_LENGTH) {
    throw new Error("This share code is too large to import.");
  }
  let payload;
  try {
    const bytes = base64UrlToBytes(raw.slice(PREFIX.length));
    payload = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("This share code is damaged or incomplete.");
  }
  if (!payload || payload.v !== 1 || typeof payload.pgn !== "string" || !payload.pgn.trim()) {
    throw new Error("This share code does not contain a valid game.");
  }
  return {
    pgn: payload.pgn,
    settings: sanitizeSettings(payload.settings),
    title: typeof payload.title === "string" ? payload.title : "",
  };
}

export function buildShareUrl(baseHref, code) {
  const url = new URL(baseHref);
  url.hash = `c=${encodeURIComponent(code)}`;
  return url.toString();
}

export function readShareCodeFromLocation(locationLike = typeof window !== "undefined" ? window.location : null) {
  if (!locationLike) return null;
  const searchCode = new URLSearchParams(locationLike.search).get("share");
  if (searchCode) return searchCode;
  const hash = String(locationLike.hash ?? "").replace(/^#/, "");
  if (!hash) return null;
  const params = new URLSearchParams(hash);
  return params.get("c") || params.get("share") || null;
}

export { PREFIX as SHARE_PREFIX };
