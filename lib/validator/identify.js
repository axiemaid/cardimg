/**
 * Front identification + back validation.
 * 
 * Uses dHash256 + dHash64 + histogram from the validator pipeline.
 * Scores against a pre-computed reference set.
 */

const { dHash256, dHash64, hammingDistance, hexToHash } = require('./hash')
const { computeHistogram, histogramIntersection } = require('./histogram')

// --- Default thresholds (tune after testing) ---
const DEFAULTS = {
  BACK_HASH_MAX: 40,     // max Hamming distance for back match (of 256)
  BACK_HIST_MIN: 0.80,   // min histogram intersection for back match
  FRONT_MAX_DIST: 0.25,  // max normalized distance for front accept
  FRONT_MARGIN: 0.70,    // best/second must be ≤ this ratio
}

// Scoring weights for front identification
const WEIGHTS = {
  h_full:    0.25,  // whole-card dHash
  h_art:     0.40,  // art box dHash
  h_art_q:   0.20,  // art quadrant dHashes (mean of 4)
  hist:      0.15,  // color histogram
}

// Art box region (normalized coordinates) — placeholder, measure from actual card
// These are for Hyper Battle cards: art takes up most of the card body
const ART_REGION = [0.07, 0.10, 0.93, 0.60] // x0, y0, x1, y1

// ID region (card number, bottom-left area)
const ID_REGION = [0.05, 0.92, 0.35, 0.98]

/**
 * Extract a sub-region from an RGBA buffer.
 * @param {Uint8Array} rgba
 * @param {number} w
 * @param {number} h
 * @param {number[]} region - [x0, y0, x1, y1] normalized (0..1)
 * @returns {{ data: Uint8Array, w: number, h: number }}
 */
function extractRegion(rgba, w, h, region) {
  const [x0n, y0n, x1n, y1n] = region
  const x0 = Math.floor(x0n * w)
  const y0 = Math.floor(y0n * h)
  const x1 = Math.ceil(x1n * w)
  const y1 = Math.ceil(y1n * h)
  const rw = x1 - x0
  const rh = y1 - y0
  const data = new Uint8Array(rw * rh * 4)
  
  for (let y = 0; y < rh; y++) {
    for (let x =  0; x < rw; x++) {
      const srcIdx = ((y + y0) * w + (x + x0)) * 4
      const dstIdx = (y * rw + x) * 4
      data[dstIdx]     = rgba[srcIdx]
      data[dstIdx + 1] = rgba[srcIdx + 1]
      data[dstIdx + 2] = rgba[srcIdx + 2]
      data[dstIdx + 3] = rgba[srcIdx + 3]
    }
  }
  return { data, w: rw, h: rh }
}

/**
 * Convert RGBA to grayscale.
 */
function rgbaToGray(rgba, w, h) {
  const gray = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) {
    const idx = i * 4
    gray[i] = Math.round(0.2126 * rgba[idx] + 0.7152 * rgba[idx + 1] + 0.0722 * rgba[idx + 2])
  }
  return gray
}

/**
 * Compute all features for a normalized image.
 * @param {Uint8Array} rgb - canonical RGB(A) image (256×358)
 * @param {number} w
 * @param {number} h
 * @returns {object} features
 */
function computeFeatures(rgb, w, h) {
  const grayFull = rgbaToGray(rgb, w, h)
  const h_full = dHash256(grayFull, w, h)
  const hist = computeHistogram(rgb, w, h)
  
  // Art box region
  const art = extractRegion(rgb, w, h, ART_REGION)
  const artGray = rgbaToGray(art.data, art.w, art.h)
  const h_art = dHash256(artGray, art.w, art.h)
  
  // Art quadrants (2×2 grid of art box)
  const halfW = Math.floor(art.w / 2)
  const halfH = Math.floor(art.h / 2)
  const quadrants = []
  for (let qy = 0; qy < 2; qy++) {
    for (let qx = 0; qx < 2; qx++) {
      const qData = new Uint8Array(halfW * halfH * 4)
      for (let y = 0; y < halfH; y++) {
        for (let x = 0; x < halfW; x++) {
          const srcIdx = ((y + qy * halfH) * art.w + (x + qx * halfW)) * 4
          const dstIdx = (y * halfW + x) * 4
          qData[dstIdx]     = art.data[srcIdx]
          qData[dstIdx + 1] = art.data[srcIdx + 1]
          qData[dstIdx + 2] = art.data[srcIdx + 2]
          qData[dstIdx + 3] = art.data[srcIdx + 3]
        }
      }
      const qGray = rgbaToGray(qData, halfW, halfH)
      quadrants.push(dHash64(qGray, halfW, halfH))
    }
  }
  
  // ID region
  const idRegion = extractRegion(rgb, w, h, ID_REGION)
  const idGray = rgbaToGray(idRegion.data, idRegion.w, idRegion.h)
  const h_id = dHash64(idGray, idRegion.w, idRegion.h)
  
  return { h_full, h_art, h_art_q: quadrants, h_id, hist }
}

/**
 * Score a candidate image against a reference card.
 * 
 * @param {object} candidate - features from computeFeatures
 * @param {object} ref - reference card features (from references.json)
 * @returns {number} normalized distance 0..1 (lower = more similar)
 */
function scoreCard(candidate, ref) {
  // Parse reference hashes from hex
  const refH_full = typeof ref.h_full === 'string' ? hexToHash(ref.h_full, 8) : ref.h_full
  const refH_art = typeof ref.h_art === 'string' ? hexToHash(ref.h_art, 8) : ref.h_art
  const refHist = ref.hist
  
  // Full card hash
  const d_full = hammingDistance(candidate.h_full, refH_full) / 256
  
  // Art box hash
  const d_art = hammingDistance(candidate.h_art, refH_art) / 256
  
  // Art quadrants (mean of 4 × 64-bit hashes)
  let d_q_sum = 0
  for (let i = 0; i < 4; i++) {
    const refQ = typeof ref.h_art_q[i] === 'string' 
      ? hexToHash(ref.h_art_q[i], 2) 
      : ref.h_art_q[i]
    d_q_sum += hammingDistance(candidate.h_art_q[i], refQ) / 64
  }
  const d_q = d_q_sum / 4
  
  // Histogram (1 - intersection)
  const histSim = histogramIntersection(candidate.hist, refHist)
  
  // Weighted score
  const score = 
    WEIGHTS.h_full * d_full +
    WEIGHTS.h_art * d_art +
    WEIGHTS.h_art_q * d_q +
    WEIGHTS.hist * (1 - histSim)
  
  return score
}

/**
 * Identify a front card image against all references.
 * 
 * @param {Uint8Array} rgb - canonical image
 * @param {number} w
 * @param {number} h
 * @param {object[]} refs - array of reference card objects
 * @param {object} thresholds - override defaults
 * @returns {{ matched, cardId, name, score, secondBest, scores }}
 */
function identifyFront(rgb, w, h, refs, thresholds = {}) {
  const t = { ...DEFAULTS, ...thresholds }
  const features = computeFeatures(rgb, w, h)
  
  const scores = []
  for (const ref of refs) {
    const dist = scoreCard(features, ref)
    scores.push({ cardId: ref.id, name: ref.name, score: dist })
  }
  scores.sort((a, b) => a.score - b.score)
  
  const best = scores[0]
  const second = scores[1]
  
  let matched = false
  let reason = null
  
  if (best.score > t.FRONT_MAX_DIST) {
    reason = 'not_a_card'
  } else if (second && (best.score / second.score) > t.FRONT_MARGIN) {
    reason = 'ambiguous'
  } else {
    matched = true
  }
  
  return {
    matched,
    cardId: matched ? best.cardId : null,
    name: matched ? best.name : null,
    score: Math.round(best.score * 10000) / 10000,
    secondBest: second ? { cardId: second.cardId, name: second.name, score: Math.round(second.score * 10000) / 10000 } : null,
    margin: second ? Math.round((best.score / second.score) * 10000) / 10000 : null,
    reason,
    scores: scores.slice(0, 5).map(s => ({ cardId: s.cardId, name: s.name, score: Math.round(s.score * 10000) / 10000 })),
  }
}

/**
 * Validate a back image against the back reference.
 * 
 * @param {Uint8Array} rgb - canonical image
 * @param {number} w
 * @param {number} h
 * @param {object} backRef - back reference features
 * @param {object[]} frontRefs - all 42 front references (for cross-check)
 * @param {object} thresholds - override defaults
 * @returns {{ matched, hashDist, histSim, reason }}
 */
function validateBack(rgb, w, h, backRef, frontRefs, thresholds = {}) {
  const t = { ...DEFAULTS, ...thresholds }
  const features = computeFeatures(rgb, w, h)
  
  // Parse back reference hashes
  const refH_full = typeof backRef.h_full === 'string' ? hexToHash(backRef.h_full, 8) : backRef.h_full
  const refHist = backRef.hist
  
  const hashDist = hammingDistance(features.h_full, refH_full)
  const histSim = histogramIntersection(features.hist, refHist)
  
  // Check against front references (shouldn't match any front)
  let bestFrontScore = 1.0
  for (const ref of frontRefs) {
    const s = scoreCard(features, ref)
    if (s < bestFrontScore) bestFrontScore = s
  }
  
  let matched = false
  let reason = null
  
  if (hashDist <= t.BACK_HASH_MAX && histSim >= t.BACK_HIST_MIN) {
    matched = true
  } else if (bestFrontScore < t.FRONT_MAX_DIST) {
    reason = 'is_front'
  } else {
    reason = 'not_back'
  }
  
  return {
    matched,
    hashDist,
    histSim: Math.round(histSim * 100) / 100,
    bestFrontScore: Math.round(bestFrontScore * 10000) / 10000,
    reason,
  }
}

module.exports = {
  identifyFront,
  validateBack,
  computeFeatures,
  scoreCard,
  extractRegion,
  rgbaToGray,
  DEFAULTS,
  WEIGHTS,
  ART_REGION,
  ID_REGION,
}
