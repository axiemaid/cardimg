/**
 * card-matcher.js — Shared pure-JS card identification module
 * 
 * Used by:
 *   - Browser (validator.js) for client-side identification
 *   - Node CLI (gen-refs.cjs) for reference generation
 * 
 * No canvas, no sharp, no OpenCV. Pure JS.
 * Image input is always raw RGBA Uint8Array + dimensions.
 * Resize is area-average (not bilinear/bicubic) for deterministic cross-platform results.
 * 
 * Pipeline: RGBA → area-average resize → grayscale → DCT pHash (64-bit)
 *           + color histogram (512-bin Bhattacharyya)
 *           + SSIM (8×8 windows) — optional, needs grayscale thumbnails
 * 
 * Matching: Hamming distance on pHash (primary) + histogram similarity (secondary)
 */

// ============================================================
// Constants — must match cardid-detector for comparability
// ============================================================

const STD_WIDTH = 343;    // match.js STD_WIDTH
const STD_HEIGHT = 480;   // match.js STD_HEIGHT
const PHASH_SIZE = 32;    // phash.js STD_SIZE (input to DCT)
const HASH_SIZE = 8;      // phash.js HASH_SIZE (top-left 8×8 of DCT)
const HIST_BINS_PER_CH = 8;
const HIST_SHIFT = 5;     // 256 / 8 = 32 → shift by 5
const HIST_NUM_BINS = HIST_BINS_PER_CH * HIST_BINS_PER_CH * HIST_BINS_PER_CH; // 512

// ============================================================
// Area-average resize (RGBA → RGBA)
// Deterministic, no interpolation artifacts.
// ============================================================

function areaAverageResizeRGBA(rgba, srcW, srcH, dstW, dstH) {
  const out = new Uint8Array(dstW * dstH * 4);
  const xRatio = srcW / dstW;
  const yRatio = srcH / dstH;

  for (let dy = 0; dy < dstH; dy++) {
    const y0 = Math.floor(dy * yRatio);
    const y1 = Math.min(Math.floor((dy + 1) * yRatio), srcH);
    for (let dx = 0; dx < dstW; dx++) {
      const x0 = Math.floor(dx * xRatio);
      const x1 = Math.min(Math.floor((dx + 1) * xRatio), srcW);
      let r = 0, g = 0, b = 0, a = 0, count = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const idx = (sy * srcW + sx) * 4;
          r += rgba[idx];
          g += rgba[idx + 1];
          b += rgba[idx + 2];
          a += rgba[idx + 3];
          count++;
        }
      }
      const oi = (dy * dstW + dx) * 4;
      if (count > 0) {
        out[oi] = Math.round(r / count);
        out[oi + 1] = Math.round(g / count);
        out[oi + 2] = Math.round(b / count);
        out[oi + 3] = Math.round(a / count);
      }
    }
  }
  return out;
}

// ============================================================
// RGBA → Grayscale (Rec. 601 luma — same as cardid-detector's 0.299/0.587/0.114)
// ============================================================

function rgbaToGrayscale(rgba, w, h) {
  const gray = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const idx = i * 4;
    gray[i] = Math.round(0.299 * rgba[idx] + 0.587 * rgba[idx + 1] + 0.114 * rgba[idx + 2]);
  }
  return gray;
}

// ============================================================
// DCT-based pHash (ported from cardid-detector/lib/phash.js)
// Input: 32×32 grayscale. Output: 64-bit BigInt hash.
// ============================================================

function dct1d(input) {
  const n = input.length;
  const output = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      sum += input[i] * Math.cos((Math.PI / n) * (i + 0.5) * k);
    }
    output[k] = sum;
  }
  return output;
}

function dct2d(data, width, height) {
  // DCT on rows
  const temp = new Float64Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = new Float64Array(width);
    for (let x = 0; x < width; x++) row[x] = data[y * width + x];
    const dctRow = dct1d(row);
    for (let x = 0; x < width; x++) temp[y * width + x] = dctRow[x];
  }

  // DCT on columns
  const result = new Float64Array(width * height);
  for (let x = 0; x < width; x++) {
    const col = new Float64Array(height);
    for (let y = 0; y < height; y++) col[y] = temp[y * width + x];
    const dctCol = dct1d(col);
    for (let y = 0; y < height; y++) result[y * width + x] = dctCol[y];
  }
  return result;
}

function computePhash(gray32) {
  // gray32 is 32×32 = 1024 values
  const dct = dct2d(gray32, PHASH_SIZE, PHASH_SIZE);

  // Extract top-left 8×8 (low frequencies)
  const values = [];
  for (let y = 0; y < HASH_SIZE; y++) {
    for (let x = 0; x < HASH_SIZE; x++) {
      values.push(dct[y * PHASH_SIZE + x]);
    }
  }

  // Median excluding DC term (index 0)
  const sorted = values.slice(1).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];

  // Build 64-bit hash
  let hash = 0n;
  for (let i = 0; i < values.length; i++) {
    if (values[i] > median) {
      hash |= (1n << BigInt(i));
    }
  }
  return hash;
}

function hammingDistance(a, b) {
  let x = a ^ b;
  let count = 0;
  while (x > 0n) {
    count += Number(x & 1n);
    x >>= 1n;
  }
  return count;
}

function hashToHex(hash) {
  return hash.toString(16).padStart(16, '0');
}

function hexToHash(hex) {
  return BigInt('0x' + hex);
}

// ============================================================
// Color histogram (Bhattacharyya coefficient) — from match.js
// 8 bins per channel → 512 bins. Input: RGB (packed in RGBA, 4 channels)
// ============================================================

function computeHistogram(rgba, w, h) {
  const hist = new Float64Array(HIST_NUM_BINS);
  const total = w * h;
  for (let i = 0; i < total; i++) {
    const idx = i * 4;
    const ri = rgba[idx] >> HIST_SHIFT;
    const gi = rgba[idx + 1] >> HIST_SHIFT;
    const bi = rgba[idx + 2] >> HIST_SHIFT;
    hist[ri * HIST_BINS_PER_CH * HIST_BINS_PER_CH + gi * HIST_BINS_PER_CH + bi]++;
  }
  for (let i = 0; i < HIST_NUM_BINS; i++) hist[i] /= total;
  return hist;
}

function histogramSimilarity(a, b) {
  // Bhattacharyya coefficient
  let bc = 0;
  for (let i = 0; i < HIST_NUM_BINS; i++) {
    bc += Math.sqrt(a[i] * b[i]);
  }
  return bc;
}

// ============================================================
// Normalize image: RGBA → { rgb, gray, gray32, hash, hist }
// Full pipeline in one call.
// ============================================================

function normalizeImage(rgba, w, h) {
  // Resize to STD_WIDTH × STD_HEIGHT (area average)
  const stdRGBA = areaAverageResizeRGBA(rgba, w, h, STD_WIDTH, STD_HEIGHT);
  const stdGray = rgbaToGrayscale(stdRGBA, STD_WIDTH, STD_HEIGHT);

  // Resize to 32×32 grayscale for pHash (area average on the original, not the std)
  const gray32RGBA = areaAverageResizeRGBA(rgba, w, h, PHASH_SIZE, PHASH_SIZE);
  const gray32 = rgbaToGrayscale(gray32RGBA, PHASH_SIZE, PHASH_SIZE);

  // pHash
  const hash = computePhash(gray32);

  // Histogram
  const hist = computeHistogram(stdRGBA, STD_WIDTH, STD_HEIGHT);

  return {
    rgb: stdRGBA,
    gray: stdGray,
    gray32,
    hash,
    hist,
    width: STD_WIDTH,
    height: STD_HEIGHT,
  };
}

// ============================================================
// Match: compare normalized input against references
// Score = 0.7×pHashScore + 0.3×hist (SSIM dropped — never changed winner)
// ============================================================

function matchAgainstRefs(inputNorm, refs) {
  // Group by code, take best (lowest Hamming) per code
  const byCode = {};

  for (const ref of refs) {
    const hamming = hammingDistance(inputNorm.hash, ref.hash);
    const hist = histogramSimilarity(inputNorm.hist, ref.hist);
    const phashScore = Math.max(0, 1 - hamming / 24);
    const score = (phashScore * 0.7) + (hist * 0.3);

    const entry = {
      code: ref.code,
      hamming,
      hist: Math.round(hist * 1000) / 1000,
      phashScore: Math.round(phashScore * 1000) / 1000,
      score: Math.round(score * 1000) / 1000,
    };

    if (!byCode[ref.code] || hamming < byCode[ref.code].hamming) {
      byCode[ref.code] = entry;
    }
  }

  const results = Object.values(byCode);
  results.sort((a, b) => b.score - a.score);

  // Format like detector-shadow output
  const best = results[0];
  const runnerUp = results[1];
  const distance = best.hamming;
  const margin = runnerUp ? runnerUp.hamming - best.hamming : best.hamming;

  return {
    ok: true,
    code: best.code,
    distance,
    margin,
    runnerUp: runnerUp ? { code: runnerUp.code, distance: runnerUp.hamming } : null,
    hist: best.hist,
    score: best.score,
    top5: results.slice(0, 5),
  };
}

// ============================================================
// Serialize/deserialize references for JSON transport
// ============================================================

function serializeRef(norm) {
  return {
    code: norm.code,
    hash: hashToHex(norm.hash),
    hist: Array.from(norm.hist),
  };
}

function deserializeRef(data) {
  return {
    code: data.code,
    hash: hexToHash(data.hash),
    hist: Float64Array.from(data.hist),
  };
}

// ============================================================
// Public API
// ============================================================

module.exports = {
  // Constants
  STD_WIDTH,
  STD_HEIGHT,
  PHASH_SIZE,
  HASH_SIZE,
  HIST_NUM_BINS,

  // Resize
  areaAverageResizeRGBA,

  // Convert
  rgbaToGrayscale,

  // pHash
  computePhash,
  dct1d,
  dct2d,
  hammingDistance,
  hashToHex,
  hexToHash,

  // Histogram
  computeHistogram,
  histogramSimilarity,

  // Full pipeline
  normalizeImage,
  matchAgainstRefs,

  // Serialization
  serializeRef,
  deserializeRef,
};
