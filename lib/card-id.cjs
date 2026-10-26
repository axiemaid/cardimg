/**
 * card-id.cjs — Front card identification module
 * 
 * One function: identify(jpegBuffer) → { ok, code, distance, margin, reason }
 * 
 * Input: JPEG buffer (already cropped, portrait, q0.90 from browser pipeline)
 * No cropping inside. Decode → area-average resize to 32×32 grayscale → DCT pHash.
 * Hash both 0° and 180°, use the better result.
 * Margin = gap to best different card code.
 * Pass only if distance ≤ maxDistance AND margin ≥ minMargin.
 * Fails closed on any error.
 * 
 * References loaded from card-refs.json (same directory as this module's parent).
 */

const fs = require('fs')
const path = require('path')

// Need sharp for JPEG decode only
let _sharp = null
function getSharp() {
  if (_sharp) return _sharp
  _sharp = require('sharp')
  return _sharp
}

// ============================================================
// Config
// ============================================================

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'card-id.json')

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
  } catch {
    return { maxDistance: 6, minMargin: 2 }
  }
}

// ============================================================
// Constants
// ============================================================

const PHASH_SIZE = 32    // 32×32 input to DCT
const HASH_SIZE = 8     // 8×8 top-left of DCT = 64-bit hash

// ============================================================
// Area-average resize (RGBA → grayscale 32×32 in one pass)
// ============================================================

function areaAverageResizeToGray(rgba, srcW, srcH, dstW, dstH) {
  const out = new Float64Array(dstW * dstH)
  const xRatio = srcW / dstW
  const yRatio = srcH / dstH

  for (let dy = 0; dy < dstH; dy++) {
    const y0 = Math.floor(dy * yRatio)
    const y1 = Math.min(Math.floor((dy + 1) * yRatio), srcH)
    for (let dx = 0; dx < dstW; dx++) {
      const x0 = Math.floor(dx * xRatio)
      const x1 = Math.min(Math.floor((dx + 1) * xRatio), srcW)

      let rSum = 0, gSum = 0, bSum = 0, count = 0
      for (let sy = y0; sy < y1; sy++) {
        const rowOffset = sy * srcW
        for (let sx = x0; sx < x1; sx++) {
          const idx = (rowOffset + sx) * 4
          rSum += rgba[idx]
          gSum += rgba[idx + 1]
          bSum += rgba[idx + 2]
          count++
        }
      }
      if (count > 0) {
        // Rec. 601 luma
        out[dy * dstW + dx] = 0.299 * (rSum / count) + 0.587 * (gSum / count) + 0.114 * (bSum / count)
      }
    }
  }
  return out
}

// ============================================================
// 1D DCT
// ============================================================

function dct1d(input) {
  const n = input.length
  const output = new Float64Array(n)
  const factor = Math.PI / n
  for (let k = 0; k < n; k++) {
    let sum = 0
    for (let i = 0; i < n; i++) {
      sum += input[i] * Math.cos(factor * (i + 0.5) * k)
    }
    output[k] = sum
  }
  return output
}

// ============================================================
// 2D DCT
// ============================================================

function dct2d(data, width, height) {
  // DCT on rows
  const temp = new Float64Array(width * height)
  for (let y = 0; y < height; y++) {
    const row = new Float64Array(width)
    for (let x = 0; x < width; x++) row[x] = data[y * width + x]
    const dctRow = dct1d(row)
    for (let x = 0; x < width; x++) temp[y * width + x] = dctRow[x]
  }

  // DCT on columns
  const result = new Float64Array(width * height)
  for (let x = 0; x < width; x++) {
    const col = new Float64Array(height)
    for (let y = 0; y < height; y++) col[y] = temp[y * width + x]
    const dctCol = dct1d(col)
    for (let y = 0; y < height; y++) result[y * width + x] = dctCol[y]
  }
  return result
}

// ============================================================
// pHash from 32×32 grayscale
// ============================================================

function computePhash(gray32) {
  const dct = dct2d(gray32, PHASH_SIZE, PHASH_SIZE)

  // Extract top-left 8×8 (low frequencies)
  const values = []
  for (let y = 0; y < HASH_SIZE; y++) {
    for (let x = 0; x < HASH_SIZE; x++) {
      values.push(dct[y * PHASH_SIZE + x])
    }
  }

  // Median excluding DC term (index 0)
  const sorted = values.slice(1).sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]

  // Build 64-bit hash as BigInt
  let hash = 0n
  for (let i = 0; i < values.length; i++) {
    if (values[i] > median) {
      hash |= (1n << BigInt(i))
    }
  }
  return hash
}

// ============================================================
// Rotate 180° (32×32 grayscale)
// ============================================================

function rotate180(gray32, w, h) {
  const out = new Float64Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      out[(h - 1 - y) * w + (w - 1 - x)] = gray32[y * w + x]
    }
  }
  return out
}

// ============================================================
// Hamming distance (BigInt)
// ============================================================

function hammingDistance(a, b) {
  let x = a ^ b
  let count = 0
  while (x > 0n) {
    count += Number(x & 1n)
    x >>= 1n
  }
  return count
}

// ============================================================
// Hash serialization
// ============================================================

function hashToHex(hash) {
  return hash.toString(16).padStart(16, '0')
}

function hexToHash(hex) {
  return BigInt('0x' + hex)
}

// ============================================================
// Reference loading (with auto-rebuild check)
// ============================================================

const REFS_PATH = path.join(__dirname, '..', 'card-refs.json')
const BUILD_SCRIPT = path.join(__dirname, '..', 'scripts', 'build-refs.cjs')
const REF_DIR = '/Users/axiemaid/.openclaw/cardid-detector/references'

let _refs = null
let _refsMtime = 0

function refsNeedRebuild() {
  if (!fs.existsSync(REFS_PATH)) return true
  const refsStat = fs.statSync(REFS_PATH)
  if (!fs.existsSync(REF_DIR)) return false
  for (const file of fs.readdirSync(REF_DIR)) {
    if (!/\.(png|jpe?g|webp|bmp)$/i.test(file)) continue
    const stat = fs.statSync(path.join(REF_DIR, file))
    if (stat.mtimeMs > refsStat.mtimeMs) return true
  }
  return false
}

function loadRefs() {
  if (_refs) {
    try {
      const stat = fs.statSync(REFS_PATH)
      if (stat.mtimeMs === _refsMtime) return _refs
    } catch { return _refs }
  }

  if (!fs.existsSync(REFS_PATH)) {
    throw new Error('card-refs.json not found — run: node scripts/build-refs.cjs')
  }

  const stat = fs.statSync(REFS_PATH)
  const data = JSON.parse(fs.readFileSync(REFS_PATH, 'utf8'))
  _refs = data.refs.map(r => ({
    code: r.code,
    hash: hexToHash(r.hash),
  }))
  _refsMtime = stat.mtimeMs
  return _refs
}

/**
 * Auto-rebuild references if any source file is newer than card-refs.json.
 * Called on server start. Synchronous — blocks startup.
 */
function autoRebuildIfNeeded() {
  if (refsNeedRebuild()) {
    console.log('[card-id] Reference files newer than card-refs.json — rebuilding...')
    const { execSync } = require('child_process')
    execSync(`node "${BUILD_SCRIPT}"`, { stdio: 'inherit' })
    _refs = null
    loadRefs()
    console.log('[card-id] References rebuilt.')
  }
}

// ============================================================
// Main: identify(jpegBuffer) → { ok, code, distance, margin, reason }
// ============================================================

async function identify(jpegBuffer) {
  try {
    const cfg = loadConfig()
    const refs = loadRefs()

    if (!refs || refs.length === 0) {
      return { ok: false, code: null, distance: null, margin: null, reason: 'no_references' }
    }

    const sharp = getSharp()
    const buf = Buffer.isBuffer(jpegBuffer) ? jpegBuffer : Buffer.from(jpegBuffer)

    // Decode JPEG to raw RGBA
    const { data, info } = await sharp(buf)
      .removeAlpha()
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })

    const rgba = new Uint8Array(data)
    const w = info.width
    const h = info.height

    // Area-average resize to 32×32 grayscale
    const gray32 = areaAverageResizeToGray(rgba, w, h, PHASH_SIZE, PHASH_SIZE)

    // Hash at 0° and 180°
    const hash0 = computePhash(gray32)
    const gray180 = rotate180(gray32, PHASH_SIZE, PHASH_SIZE)
    const hash180 = computePhash(gray180)

    // Match against all references — take best of 0°/180° per code
    const byCode = {}

    for (const ref of refs) {
      const dist0 = hammingDistance(hash0, ref.hash)
      const dist180 = hammingDistance(hash180, ref.hash)
      const dist = Math.min(dist0, dist180)

      if (!byCode[ref.code] || dist < byCode[ref.code].distance) {
        byCode[ref.code] = { code: ref.code, distance: dist }
      }
    }

    // Sort by distance ascending
    const results = Object.values(byCode)
    results.sort((a, b) => a.distance - b.distance)

    const best = results[0]
    const runnerUp = results[1]
    const distance = best.distance
    const margin = runnerUp ? runnerUp.distance - best.distance : distance

    // Apply thresholds
    let reason = null
    if (distance > cfg.maxDistance) {
      reason = `distance_${distance}_exceeds_${cfg.maxDistance}`
    } else if (margin < cfg.minMargin) {
      reason = `margin_${margin}_below_${cfg.minMargin}`
    }

    return {
      ok: reason === null,
      code: best.code,
      distance,
      margin,
      reason: reason || 'pass',
    }
  } catch (e) {
    return { ok: false, code: null, distance: null, margin: null, reason: 'error: ' + e.message }
  }
}

// ============================================================
// Public API
// ============================================================

module.exports = {
  identify,
  // Exposed for testing and build script
  areaAverageResizeToGray,
  dct2d,
  computePhash,
  rotate180,
  hammingDistance,
  hashToHex,
  hexToHash,
  loadRefs,
  loadConfig,
  autoRebuildIfNeeded,
  refsNeedRebuild,
  PHASH_SIZE,
  HASH_SIZE,
}
