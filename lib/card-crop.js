/**
 * card-crop.js — Shared card edge detection + cropping logic
 * 
 * Extracted from validator.js so both the browser validator and the
 * reference generator (gen-refs.cjs) use the exact same crop pipeline.
 * 
 * Pure JS — no canvas, no sharp, no DOM dependencies.
 * Input: raw RGBA Uint8Array + dimensions.
 * Output: crop region { left, top, width, height } or null.
 */

// ============================================================
// Constants (must match validator.js exactly)
// ============================================================

const BLACK_THRESHOLD = 30;
const WHITE_THRESHOLD = 225;
const CONTENT_SAT_THRESHOLD = 0.08;
const MAX_MARGIN_RATIO = 0.05;
const MIN_CONSECUTIVE_STEPS = 3;

// ============================================================
// Pixel classification (from validator.js isContent/isBackground)
// ============================================================

function isBlack(p) { return p.r < BLACK_THRESHOLD && p.g < BLACK_THRESHOLD && p.b < BLACK_THRESHOLD; }
function isWhite(p) { return p.r > WHITE_THRESHOLD && p.g > WHITE_THRESHOLD && p.b > WHITE_THRESHOLD; }
function isBackground(p) { return isBlack(p) || isWhite(p); }

function isContent(p) {
  if (isBackground(p)) return false;
  const maxC = Math.max(p.r, p.g, p.b);
  const minC = Math.min(p.r, p.g, p.b);
  const sat = maxC === 0 ? 0 : (maxC - minC) / maxC;
  if (maxC < 50 && sat < CONTENT_SAT_THRESHOLD) return false;
  if (maxC >= 50 && maxC <= 220 && sat < CONTENT_SAT_THRESHOLD) return false;
  return true;
}

function getPixel(data, w, x, y, ch) {
  const idx = (y * w + x) * ch;
  return { r: data[idx], g: data[idx + 1], b: data[idx + 2] };
}

// ============================================================
// Edge detection (from validator.js detectCardEdges)
// ============================================================

function detectCardEdges(data, w, h, ch) {
  const sampleStep = Math.max(1, Math.floor(Math.min(w, h) / 100));
  const thresholdRatio = 0.3;

  // Find top edge (scan downward from y=0)
  let top = 0;
  let consecutive = 0, firstHit = -1;
  for (let y = 0; y < h; y += sampleStep) {
    let cc = 0, sc = 0;
    for (let x = 0; x < w; x += sampleStep) { sc++; if (isContent(getPixel(data, w, x, y, ch))) cc++; }
    if (cc / sc > thresholdRatio) {
      if (consecutive === 0) firstHit = y;
      if (++consecutive >= MIN_CONSECUTIVE_STEPS) { top = firstHit; break; }
    } else { consecutive = 0; firstHit = -1; }
  }

  // Find bottom edge (scan upward from y=h-1)
  let bottom = h - 1;
  consecutive = 0; firstHit = -1;
  for (let y = h - 1; y >= 0; y -= sampleStep) {
    let cc = 0, sc = 0;
    for (let x = 0; x < w; x += sampleStep) { sc++; if (isContent(getPixel(data, w, x, y, ch))) cc++; }
    if (cc / sc > thresholdRatio) {
      if (consecutive === 0) firstHit = y;
      if (++consecutive >= MIN_CONSECUTIVE_STEPS) { bottom = firstHit; break; }
    } else { consecutive = 0; firstHit = -1; }
  }

  // Find left edge (scan rightward from x=0)
  let left = 0;
  consecutive = 0; firstHit = -1;
  for (let x = 0; x < w; x += sampleStep) {
    let cc = 0, sc = 0;
    for (let y = top; y <= bottom; y += sampleStep) { sc++; if (isContent(getPixel(data, w, x, y, ch))) cc++; }
    if (cc / sc > thresholdRatio) {
      if (consecutive === 0) firstHit = x;
      if (++consecutive >= MIN_CONSECUTIVE_STEPS) { left = firstHit; break; }
    } else { consecutive = 0; firstHit = -1; }
  }

  // Find right edge (scan leftward from x=w-1)
  let right = w - 1;
  consecutive = 0; firstHit = -1;
  for (let x = w - 1; x >= 0; x -= sampleStep) {
    let cc = 0, sc = 0;
    for (let y = top; y <= bottom; y += sampleStep) { sc++; if (isContent(getPixel(data, w, x, y, ch))) cc++; }
    if (cc / sc > thresholdRatio) {
      if (consecutive === 0) firstHit = x;
      if (++consecutive >= MIN_CONSECUTIVE_STEPS) { right = firstHit; break; }
    } else { consecutive = 0; firstHit = -1; }
  }

  const cardWidth = right - left;
  const cardHeight = bottom - top;
  return { top, bottom, left, right, cardWidth, cardHeight, found: cardWidth > 0 && cardHeight > 0 };
}

// ============================================================
// Crop computation (from validator.js computeCrop — 5% max margin)
// ============================================================

function computeCrop(edges, w, h) {
  const maxMargin = Math.round(edges.cardWidth * MAX_MARGIN_RATIO);
  const leftMargin = edges.left;
  const rightMargin = w - edges.right - 1;
  const topMargin = edges.top;
  const bottomMargin = h - edges.bottom - 1;

  const cropLeft = leftMargin > maxMargin ? edges.left - maxMargin : 0;
  const cropTop = topMargin > maxMargin ? edges.top - maxMargin : 0;
  const cropRight = rightMargin > maxMargin ? edges.right + maxMargin : w;
  const cropBottom = bottomMargin > maxMargin ? edges.bottom + maxMargin : h;

  if (cropLeft > 0 || cropTop > 0 || cropRight < w || cropBottom < h) {
    return {
      left: Math.max(0, cropLeft),
      top: Math.max(0, cropTop),
      width: Math.min(w, cropRight) - Math.max(0, cropLeft),
      height: Math.min(h, cropBottom) - Math.max(0, cropTop),
    };
  }
  return null;
}

// ============================================================
// Full crop pipeline: RGBA → detect edges → compute crop → crop RGBA
// Returns { rgba, w, h, edges, crop } or null if no card found
// ============================================================

function cropCardFromRGBA(rgba, w, h) {
  const ch = 4;
  const edges = detectCardEdges(rgba, w, h, ch);
  if (!edges.found) return null;

  const crop = computeCrop(edges, w, h);
  if (!crop) {
    // No crop needed — return original
    return { rgba, w, h, edges, crop: null };
  }

  // Extract cropped region
  const croppedRGBA = new Uint8Array(crop.width * crop.height * 4);
  for (let y = 0; y < crop.height; y++) {
    for (let x = 0; x < crop.width; x++) {
      const srcIdx = ((y + crop.top) * w + (x + crop.left)) * 4;
      const dstIdx = (y * crop.width + x) * 4;
      croppedRGBA[dstIdx] = rgba[srcIdx];
      croppedRGBA[dstIdx + 1] = rgba[srcIdx + 1];
      croppedRGBA[dstIdx + 2] = rgba[srcIdx + 2];
      croppedRGBA[dstIdx + 3] = rgba[srcIdx + 3];
    }
  }

  return { rgba: croppedRGBA, w: crop.width, h: crop.height, edges, crop };
}

module.exports = {
  // Constants
  BLACK_THRESHOLD,
  WHITE_THRESHOLD,
  CONTENT_SAT_THRESHOLD,
  MAX_MARGIN_RATIO,
  MIN_CONSECUTIVE_STEPS,
  // Pixel classification
  isBlack,
  isWhite,
  isBackground,
  isContent,
  // Edge detection
  detectCardEdges,
  // Crop
  computeCrop,
  cropCardFromRGBA,
};
