/**
 * Image normalization — decode, auto-crop, resize, rotate, grayscale.
 * 
 * Browser: uses createImageBitmap + OffscreenCanvas (or canvas fallback)
 * Node: uses sharp
 * 
 * The resize is implemented as pure-JS area averaging to guarantee
 * identical output in both runtimes (canvas resampling differs
 * across browsers and from sharp).
 */

const CANONICAL_W = 256
const CANONICAL_H = 358

// --- Pure-JS area-average resize ---
// Takes raw RGBA buffer at any size, downsamples to target W×H.
// Each output pixel = average of the source pixels in its block.
function areaAverageResize(rgba, srcW, srcH, dstW, dstH) {
  const out = new Uint8Array(dstW * dstH * 4) // RGBA
  const xRatio = srcW / dstW
  const yRatio = srcH / dstH

  for (let dy = 0; dy < dstH; dy++) {
    const y0 = Math.floor(dy * yRatio)
    const y1 = Math.min(Math.floor((dy + 1) * yRatio), srcH)
    for (let dx = 0; dx < dstW; dx++) {
      const x0 = Math.floor(dx * xRatio)
      const x1 = Math.min(Math.floor((dx + 1) * xRatio), srcW)
      
      let r = 0, g = 0, b = 0, a = 0, count = 0
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const idx = (sy * srcW + sx) * 4
          r += rgba[idx]
          g += rgba[idx + 1]
          b += rgba[idx + 2]
          a += rgba[idx + 3]
          count++
        }
      }
      const oi = (dy * dstW + dx) * 4
      if (count > 0) {
        out[oi]     = Math.round(r / count)
        out[oi + 1] = Math.round(g / count)
        out[oi + 2] = Math.round(b / count)
        out[oi + 3] = Math.round(a / count)
      }
    }
  }
  return out
}

// Convert RGBA to grayscale (luminance)
function toGrayscale(rgba, w, h) {
  const gray = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) {
    const idx = i * 4
    // Rec. 709 luma
    gray[i] = Math.round(0.2126 * rgba[idx] + 0.7152 * rgba[idx + 1] + 0.0722 * rgba[idx + 2])
  }
  return gray
}

/**
 * Auto-crop: detect card content and remove uniform background.
 * Works on black or white backgrounds.
 * 
 * @param {Uint8Array} rgba - raw RGBA pixels
 * @param {number} w
 * @param {number} h
 * @returns {{ cropped: Uint8Array, w: number, h: number, x: number, y: number } | null}
 */
function autoCrop(rgba, w, h) {
  const threshold = 30 // RGB value threshold for "background"
  const sampleStep = Math.max(1, Math.floor(Math.min(w, h) / 200))
  const ratioThreshold = 0.3 // 30% of row/col must be non-background
  
  // Determine background color from border pixels
  let bgR = 0, bgG = 0, bgB = 0, bgCount = 0
  for (let x = 0; x < w; x += sampleStep) {
    // Top edge
    let idx = (0 * w + x) * 4; bgR += rgba[idx]; bgG += rgba[idx+1]; bgB += rgba[idx+2]; bgCount++
    // Bottom edge
    idx = ((h-1) * w + x) * 4; bgR += rgba[idx]; bgG += rgba[idx+1]; bgB += rgba[idx+2]; bgCount++
  }
  for (let y = 0; y < h; y += sampleStep) {
    let idx = (y * w + 0) * 4; bgR += rgba[idx]; bgG += rgba[idx+1]; bgB += rgba[idx+2]; bgCount++
    idx = (y * w + (w-1)) * 4; bgR += rgba[idx]; bgG += rgba[idx+1]; bgB += rgba[idx+2]; bgCount++
  }
  bgR = Math.round(bgR / bgCount)
  bgG = Math.round(bgG / bgCount)
  bgB = Math.round(bgB / bgCount)
  
  const isBackground = (r, g, b) => {
    return Math.abs(r - bgR) < threshold && Math.abs(g - bgG) < threshold && Math.abs(b - bgB) < threshold
  }
  
  // Find content bounding box
  let top = -1, bottom = -1, left = -1, right = -1
  
  // Top
  for (let y = 0; y < h; y += sampleStep) {
    let content = 0, total = 0
    for (let x = 0; x < w; x += sampleStep) {
      const idx = (y * w + x) * 4
      total++
      if (!isBackground(rgba[idx], rgba[idx+1], rgba[idx+2])) content++
    }
    if (content / total > ratioThreshold) { top = y; break }
  }
  if (top === -1) return null
  
  // Bottom
  for (let y = h - 1; y >= 0; y -= sampleStep) {
    let content = 0, total = 0
    for (let x = 0; x < w; x += sampleStep) {
      const idx = (y * w + x) * 4
      total++
      if (!isBackground(rgba[idx], rgba[idx+1], rgba[idx+2])) content++
    }
    if (content / total > ratioThreshold) { bottom = y; break }
  }
  if (bottom === -1 || bottom <= top) return null
  
  // Left
  for (let x = 0; x < w; x += sampleStep) {
    let content = 0, total = 0
    for (let y = top; y <= bottom; y += sampleStep) {
      const idx = (y * w + x) * 4
      total++
      if (!isBackground(rgba[idx], rgba[idx+1], rgba[idx+2])) content++
    }
    if (content / total > ratioThreshold) { left = x; break }
  }
  if (left === -1) return null
  
  // Right
  for (let x = w - 1; x >= 0; x -= sampleStep) {
    let content = 0, total = 0
    for (let y = top; y <= bottom; y += sampleStep) {
      const idx = (y * w + x) * 4
      total++
      if (!isBackground(rgba[idx], rgba[idx+1], rgba[idx+2])) content++
    }
    if (content / total > ratioThreshold) { right = x; break }
  }
  if (right === -1 || right <= left) return null
  
  // Add small margin (2% of dimension)
  const marginX = Math.round((right - left) * 0.02)
  const marginY = Math.round((bottom - top) * 0.02)
  const x0 = Math.max(0, left - marginX)
  const y0 = Math.max(0, top - marginY)
  const x1 = Math.min(w - 1, right + marginX)
  const y1 = Math.min(h - 1, bottom + marginY)
  
  const cropW = x1 - x0 + 1
  const cropH = y1 - y0 + 1
  const cropped = new Uint8Array(cropW * cropH * 4)
  
  for (let y = 0; y < cropH; y++) {
    for (let x = 0; x < cropW; x++) {
      const srcIdx = ((y + y0) * w + (x + x0)) * 4
      const dstIdx = (y * cropW + x) * 4
      cropped[dstIdx]     = rgba[srcIdx]
      cropped[dstIdx + 1] = rgba[srcIdx + 1]
      cropped[dstIdx + 2] = rgba[srcIdx + 2]
      cropped[dstIdx + 3] = rgba[srcIdx + 3]
    }
  }
  
  return { cropped, w: cropW, h: cropH, x: x0, y: y0 }
}

/**
 * Rotate RGBA buffer 90° clockwise.
 */
function rotate90CW(rgba, w, h) {
  const out = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const srcIdx = (y * w + x) * 4
      // (x,y) → (h-1-y, x) in new coords, new dims: h×w
      const nx = h - 1 - y
      const ny = x
      const dstIdx = (ny * h + nx) * 4
      out[dstIdx]     = rgba[srcIdx]
      out[dstIdx + 1] = rgba[srcIdx + 1]
      out[dstIdx + 2] = rgba[srcIdx + 2]
      out[dstIdx + 3] = rgba[srcIdx + 3]
    }
  }
  return { data: out, w: h, h: w }
}

/**
 * Rotate RGBA buffer 180°.
 */
function rotate180(rgba, w, h) {
  const out = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const srcIdx = (y * w + x) * 4
      const nx = w - 1 - x
      const ny = h - 1 - y
      const dstIdx = (ny * w + nx) * 4
      out[dstIdx]     = rgba[srcIdx]
      out[dstIdx + 1] = rgba[srcIdx + 1]
      out[dstIdx + 2] = rgba[srcIdx + 2]
      out[dstIdx + 3] = rgba[srcIdx + 3]
    }
  }
  return { data: out, w, h }
}

/**
 * Normalize an image to canonical size (256×358 portrait).
 * 
 * Takes raw RGBA pixels at any resolution, auto-crops if possible,
 * resizes to canonical size via area averaging, and produces
 * both RGB and grayscale buffers.
 * 
 * @param {Uint8Array} rgba - raw RGBA pixels
 * @param {number} w
 * @param {number} h
 * @param {object} opts
 * @param {boolean} opts.tryCrop - attempt auto-crop (default true)
 * @returns {{ rgb: Uint8Array, gray: Uint8Array, w: number, h: number, rotation: number, cropped: boolean }}
 */
function normalize(rgba, w, h, opts = {}) {
  const { tryCrop = true } = opts
  
  let pixels = rgba
  let pw = w
  let ph = h
  let wasCropped = false
  let rotation = 0
  
  // Auto-crop
  if (tryCrop) {
    const crop = autoCrop(rgba, w, h)
    if (crop && crop.w > 0 && crop.h > 0) {
      // Check aspect ratio of crop — only accept if reasonable
      const cropAspect = Math.min(crop.w, crop.h) / Math.max(crop.w, crop.h)
      if (Math.abs(cropAspect - (63/88)) < 0.06) {
        pixels = crop.cropped
        pw = crop.w
        ph = crop.h
        wasCropped = true
      }
    }
  }
  
  // Ensure portrait orientation
  if (pw > ph) {
    const r = rotate90CW(pixels, pw, ph)
    pixels = r.data
    pw = r.w
    ph = r.h
    rotation = 90
  }
  
  // Resize to canonical size via area averaging
  const rgb = areaAverageResize(pixels, pw, ph, CANONICAL_W, CANONICAL_H)
  const gray = toGrayscale(rgb, CANONICAL_W, CANONICAL_H)
  
  // Track cropped dimensions for aspect ratio check
  let croppedW = pw
  let croppedH = ph
  // If auto-crop happened, pw/ph are the cropped dims (before resize)
  // But we already resized — so we need to track from before resize
  // Actually, pw/ph ARE the cropped dims (pre-resize). Use those.
  
  return { rgb, gray, w: CANONICAL_W, h: CANONICAL_H, rotation, cropped: wasCropped, croppedW, croppedH }
}

module.exports = {
  normalize,
  autoCrop,
  areaAverageResize,
  toGrayscale,
  rotate90CW,
  rotate180,
  CANONICAL_W,
  CANONICAL_H,
}
