'use strict';

/**
 * The size ladder, shared by every surface that can change it.
 *
 * This lives in its own module because it is the one piece of the feature with
 * two owners: the window process validates and applies a size, and the Host
 * plugin has to offer the same choices over the control API. Duplicating the
 * list would let the two drift, and a menu entry the window does not accept is
 * a bug that only shows up when someone clicks it.
 */

/** Offered in the menus and the control panel, in order. */
const SCALES = [0.75, 1, 1.25, 1.5];

/** Anything outside this range is refused; in between is allowed (e.g. from the control port). */
const MIN_SCALE = 0.5;
const MAX_SCALE = 2;

/**
 * Accepts anything within range, snapping to the offered ladder when it is close.
 * Returns null for a value that must be rejected.
 */
function normalizeScale(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < MIN_SCALE || n > MAX_SCALE) return null;
  const offered = SCALES.find((candidate) => Math.abs(candidate - n) < 0.001);
  return offered || Math.round(n * 100) / 100;
}

module.exports = { SCALES, MIN_SCALE, MAX_SCALE, normalizeScale };
