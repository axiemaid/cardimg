/**
 * File sanity checks — format, size, dimensions, aspect ratio.
 * Pure functions, no DOM/canvas dependency.
 * 
 * Used by both browser and Node (signer/indexer) — must stay runtime-agnostic.
 */

const MIN_BYTES = 50 * 1024       // 50 KB
const MAX_BYTES = 8 * 1024 * 1024 // 8 MB
const MIN_SHORT_SIDE = 600        // px
const MAX_LONG_SIDE = 6000       // px
const ASPECT_RATIO = 63 / 88      // ~0.716 (standard trading card)
const ASPECT_TOLERANCE = 0.04     // ±0.04

const MAGIC_BYTES = {
  JPEG: [0xFF, 0xD8, 0xFF],
  PNG:  [0x89, 0x50, 0x4E, 0x47],
  WEBP_RIFF: [0x52, 0x49, 0x46, 0x46], // RIFF
}

/**
 * Detect image format from magic bytes.
 * @param {Uint8Array|Buffer} buf
 * @returns {{ format: 'jpeg'|'png'|'webp'|null, mime: string }}
 */
function detectFormat(buf) {
  if (!buf || buf.length < 12) return { format: null, mime: null }
  
  // JPEG: FF D8 FF
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) {
    return { format: 'jpeg', mime: 'image/jpeg' }
  }
  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
    return { format: 'png', mime: 'image/png' }
  }
  // WebP: RIFF....WEBP
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) {
    return { format: 'webp', mime: 'image/webp' }
  }
  
  return { format: null, mime: null }
}

/**
 * Run all sanity checks on a raw file buffer.
 * Does NOT decode the image — just magic bytes and size.
 * 
 * @param {Uint8Array|Buffer} buf
 * @returns {{ valid: boolean, errors: string[], format: string|null, mime: string|null }}
 */
function checkFile(buf) {
  const errors = []
  
  // Size
  if (!buf || buf.length === 0) {
    return { valid: false, errors: ['Empty file'], format: null, mime: null }
  }
  if (buf.length < MIN_BYTES) {
    errors.push(`File too small: ${(buf.length / 1024).toFixed(1)} KB (min ${MIN_BYTES / 1024} KB)`)
  }
  if (buf.length > MAX_BYTES) {
    errors.push(`File too large: ${(buf.length / 1024 / 1024).toFixed(1)} MB (max ${MAX_BYTES / 1024 / 1024} MB)`)
  }
  
  // Format
  const { format, mime } = detectFormat(buf)
  if (!format) {
    errors.push('Unrecognized format (must be JPEG, PNG, or WebP)')
  }
  
  return { valid: errors.length === 0, errors, format, mime }
}

/**
 * Check decoded image dimensions and aspect ratio.
 * 
 * @param {number} w - image width
 * @param {number} h - image height
 * @returns {{ valid: boolean, errors: string[], shortSide: number, longSide: number, aspect: number }}
 */
function checkDimensions(w, h) {
  const errors = []
  const shortSide = Math.min(w, h)
  const longSide = Math.max(w, h)
  const aspect = shortSide / longSide
  
  if (shortSide < MIN_SHORT_SIDE) {
    errors.push(`Resolution too low: short side ${shortSide}px (min ${MIN_SHORT_SIDE}px)`)
  }
  if (longSide > MAX_LONG_SIDE) {
    errors.push(`Resolution too high: long side ${longSide}px (max ${MAX_LONG_SIDE}px)`)
  }
  if (Math.abs(aspect - ASPECT_RATIO) > ASPECT_TOLERANCE) {
    errors.push(`Aspect ratio ${aspect.toFixed(3)} doesn't match card ratio ${ASPECT_RATIO.toFixed(3)} (±${ASPECT_TOLERANCE})`)
  }
  
  return { valid: errors.length === 0, errors, shortSide, longSide, aspect }
}

module.exports = {
  checkFile,
  checkDimensions,
  detectFormat,
  // Constants exported for testing/tuning
  MIN_BYTES,
  MAX_BYTES,
  MIN_SHORT_SIDE,
  MAX_LONG_SIDE,
  ASPECT_RATIO,
  ASPECT_TOLERANCE,
}
