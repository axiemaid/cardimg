/**
 * RGB histogram — 4×4×4 = 64 bins, histogram intersection.
 * 
 * Pure JS, works on RGBA Uint8Array input.
 */

const BINS = 64 // 4×4×4

/**
 * Compute a 64-bin RGB histogram from an RGBA buffer.
 * Each channel is quantized to 4 levels (0-63, 64-127, 128-191, 192-255).
 * 
 * @param {Uint8Array} rgba
 * @param {number} w
 * @param {number} h
 * @returns {Float32Array} 64 normalized floats (sum = 1.0)
 */
function computeHistogram(rgba, w, h) {
  const hist = new Float32Array(BINS)
  const total = w * h
  
  for (let i = 0; i < total; i++) {
    const idx = i * 4
    const r = rgba[idx]
    const g = rgba[idx + 1]
    const b = rgba[idx + 2]
    // Quantize to 4 levels: 0-63→0, 64-127→1, 128-191→2, 192-255→3
    const ri = r >> 6 // 0-3
    const gi = g >> 6
    const bi = b >> 6
    const bin = (ri << 4) | (gi << 2) | bi // 0-63
    hist[bin]++
  }
  
  // Normalize
  for (let i = 0; i < BINS; i++) {
    hist[i] /= total
  }
  
  return hist
}

/**
 * Histogram intersection similarity (0..1).
 * 1 = identical, 0 = no overlap.
 * 
 * @param {Float32Array|number[]} a
 * @param {Float32Array|number[]} b
 * @returns {number}
 */
function histogramIntersection(a, b) {
  let sum = 0
  for (let i = 0; i < BINS; i++) {
    sum += Math.min(a[i], b[i])
  }
  return sum
}

/**
 * Chi-square distance (0..large). 0 = identical.
 * Not normalized — use histogramIntersection for acceptance checks.
 * 
 * @param {Float32Array|number[]} a
 * @param {Float32Array|number[]} b
 * @returns {number}
 */
function chiSquareDistance(a, b) {
  let sum = 0
  for (let i = 0; i < BINS; i++) {
    const denom = a[i] + b[i]
    if (denom > 0) {
      const diff = a[i] - b[i]
      sum += (diff * diff) / denom
    }
  }
  return sum * 0.5
}

module.exports = {
  computeHistogram,
  histogramIntersection,
  chiSquareDistance,
  BINS,
}
