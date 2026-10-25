/**
 * Browser validator bundle — loaded via <script> tag in the upload page.
 * 
 * Exposes window.HBValidator with validateCardImage(file, zoneName) method.
 * Fetches references.json from the API on first use.
 * 
 * Cropping logic ported from cardimg-scan/lib/scan.js for high-fidelity matching:
 *   - Saturation-based content detection (filters translucent sleeve edges)
 *   - Edge detection from each border inward
 *   - 5% max margin crop (trim excess background, keep small margins)
 *   - DPI detection from metadata or inferred from card content
 *   - Dimension validation against empirical reference (1386×2005 @ 600 DPI)
 *   - Full-resolution JPEG output at quality 0.90
 */

(function () {
  'use strict'

  // ============================================================
  // Constants (from scan.js)
  // ============================================================
  const REF_CARD_WIDTH_600 = 1386
  const REF_CARD_HEIGHT_600 = 2005
  const REF_DPI = 600
  const CARD_SIZE_TOLERANCE = 0.10
  const MIN_DPI = 150
  const BLACK_THRESHOLD = 30
  const WHITE_THRESHOLD = 225
  const CONTENT_SAT_THRESHOLD = 0.08
  const MAX_MARGIN_RATIO = 0.05
  const JPEG_QUALITY = 0.90

  // Validator constants
  const CANONICAL_W = 256
  const CANONICAL_H = 358
  const ASPECT_RATIO = 63 / 88
  const ASPECT_TOLERANCE = 0.06
  const MIN_BYTES = 50 * 1024
  const MIN_SHORT_SIDE = 400
  const MAX_LONG_SIDE = 6000

  // ============================================================
  // sanity.js — format + size checks
  // ============================================================
  function detectFormat(buf) {
    if (!buf || buf.length < 12) return { format: null, mime: null }
    if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return { format: 'jpeg', mime: 'image/jpeg' }
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return { format: 'png', mime: 'image/png' }
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
        buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return { format: 'webp', mime: 'image/webp' }
    return { format: null, mime: null }
  }

  function checkFile(buf) {
    const errors = []
    if (!buf || buf.length === 0) return { valid: false, errors: ['Empty file'], format: null, mime: null }
    if (buf.length < MIN_BYTES) errors.push(`File too small: ${(buf.length / 1024).toFixed(1)} KB (min ${MIN_BYTES / 1024} KB)`)

    const { format, mime } = detectFormat(buf)
    if (!format) errors.push('Unrecognized format (must be JPEG, PNG, or WebP)')
    return { valid: errors.length === 0, errors, format, mime }
  }

  // ============================================================
  // Pixel detection (ported from scan.js)
  // ============================================================

  function isBlack(p) { return p.r < BLACK_THRESHOLD && p.g < BLACK_THRESHOLD && p.b < BLACK_THRESHOLD }
  function isWhite(p) { return p.r > WHITE_THRESHOLD && p.g > WHITE_THRESHOLD && p.b > WHITE_THRESHOLD }
  function isBackground(p) { return isBlack(p) || isWhite(p) }

  function isContent(p) {
    if (isBackground(p)) return false
    const maxC = Math.max(p.r, p.g, p.b)
    const minC = Math.min(p.r, p.g, p.b)
    const sat = maxC === 0 ? 0 : (maxC - minC) / maxC
    if (maxC < 50 && sat < CONTENT_SAT_THRESHOLD) return false
    if (maxC >= 50 && maxC <= 220 && sat < CONTENT_SAT_THRESHOLD) return false
    return true
  }

  function getPixel(data, w, x, y, ch) {
    const idx = (y * w + x) * ch
    return { r: data[idx], g: data[idx + 1], b: data[idx + 2] }
  }

  // ============================================================
  // Edge detection (ported from scan.js detectCardEdges)
  // ============================================================

  function detectCardEdges(data, w, h, ch) {
    const sampleStep = Math.max(1, Math.floor(Math.min(w, h) / 100))
    const thresholdRatio = 0.3

    let top = 0
    for (let y = 0; y < h; y += sampleStep) {
      let cc = 0, sc = 0
      for (let x = 0; x < w; x += sampleStep) { sc++; if (isContent(getPixel(data, w, x, y, ch))) cc++ }
      if (cc / sc > thresholdRatio) { top = y; break }
    }

    let bottom = h - 1
    for (let y = h - 1; y >= 0; y -= sampleStep) {
      let cc = 0, sc = 0
      for (let x = 0; x < w; x += sampleStep) { sc++; if (isContent(getPixel(data, w, x, y, ch))) cc++ }
      if (cc / sc > thresholdRatio) { bottom = y; break }
    }

    let left = 0
    for (let x = 0; x < w; x += sampleStep) {
      let cc = 0, sc = 0
      for (let y = top; y <= bottom; y += sampleStep) { sc++; if (isContent(getPixel(data, w, x, y, ch))) cc++ }
      if (cc / sc > thresholdRatio) { left = x; break }
    }

    let right = w - 1
    for (let x = w - 1; x >= 0; x -= sampleStep) {
      let cc = 0, sc = 0
      for (let y = top; y <= bottom; y += sampleStep) { sc++; if (isContent(getPixel(data, w, x, y, ch))) cc++ }
      if (cc / sc > thresholdRatio) { right = x; break }
    }

    const cardWidth = right - left
    const cardHeight = bottom - top
    return { top, bottom, left, right, cardWidth, cardHeight, found: cardWidth > 0 && cardHeight > 0 }
  }

  // ============================================================
  // DPI + dimension validation (ported from scan.js)
  // ============================================================

  function detectCardDPI(edges, imageDpi) {
    const { cardWidth, cardHeight } = edges
    let dpi, source
    if (imageDpi) {
      dpi = imageDpi
      source = 'metadata'
    } else {
      const widthDpi = (cardWidth / REF_CARD_WIDTH_600) * REF_DPI
      const heightDpi = (cardHeight / REF_CARD_HEIGHT_600) * REF_DPI
      dpi = Math.round((widthDpi + heightDpi) / 2)
      source = 'inferred'
    }
    return { cardWidth, cardHeight, effectiveDPI: dpi, meetsMinimum: dpi >= MIN_DPI, source }
  }

  function validateCardDimensions(edges, dpi) {
    const { cardWidth, cardHeight } = edges
    if (cardWidth <= 0 || cardHeight <= 0) return { valid: false, reason: 'Card dimensions zero or negative' }

    const isPortrait = cardHeight >= cardWidth
    const scale = dpi / REF_DPI
    const expectedW = Math.round((isPortrait ? REF_CARD_WIDTH_600 : REF_CARD_HEIGHT_600) * scale)
    const expectedH = Math.round((isPortrait ? REF_CARD_HEIGHT_600 : REF_CARD_WIDTH_600) * scale)
    const widthRatio = cardWidth / expectedW
    const heightRatio = cardHeight / expectedH
    const minAcceptable = 1 - CARD_SIZE_TOLERANCE
    const valid = widthRatio >= minAcceptable && heightRatio >= minAcceptable

    if (!valid) {
      const worst = Math.min(widthRatio, heightRatio) < widthRatio ? 'height' : 'width'
      const actual = worst === 'height' ? cardHeight : cardWidth
      const expected = worst === 'height' ? expectedH : expectedW
      return { valid: false, reason: `Card ${worst} is ${actual}px but expected ~${expected}px at ${dpi} DPI (±10%) — card may be cut off` }
    }
    return { valid: true, orientation: isPortrait ? 'portrait' : 'landscape' }
  }

  function detectFlushEdges(edges, w, h) {
    const flush = []
    if (edges.top <= 0) flush.push('top')
    if (edges.bottom >= h - 1) flush.push('bottom')
    if (edges.left <= 0) flush.push('left')
    if (edges.right >= w - 1) flush.push('right')
    return { flush, hasFlush: flush.length > 0 }
  }

  function validateBackground(data, w, h, ch, edges) {
    const { top, bottom, left, right } = edges
    const step = Math.max(1, Math.floor(Math.min(w, h) / 200))
    let bg = 0, total = 0
    for (let y = 0; y < top; y += step)
      for (let x = 0; x < w; x += step) { total++; if (isBackground(getPixel(data, w, x, y, ch))) bg++ }
    for (let y = bottom + 1; y < h; y += step)
      for (let x = 0; x < w; x += step) { total++; if (isBackground(getPixel(data, w, x, y, ch))) bg++ }
    for (let x = 0; x < left; x += step)
      for (let y = top; y <= bottom; y += step) { total++; if (isBackground(getPixel(data, w, x, y, ch))) bg++ }
    for (let x = right + 1; x < w; x += step)
      for (let y = top; y <= bottom; y += step) { total++; if (isBackground(getPixel(data, w, x, y, ch))) bg++ }
    const ratio = total > 0 ? bg / total : 0
    return { bgRatio: Math.round(ratio * 100) / 100, isBackground: ratio >= 0.9 }
  }

  // ============================================================
  // Crop logic (ported from scan.js — 5% max margin)
  // ============================================================

  function computeCrop(edges, w, h) {
    const maxMargin = Math.round(edges.cardWidth * MAX_MARGIN_RATIO)
    const leftMargin = edges.left
    const rightMargin = w - edges.right - 1
    const topMargin = edges.top
    const bottomMargin = h - edges.bottom - 1

    const cropLeft = leftMargin > maxMargin ? edges.left - maxMargin : 0
    const cropTop = topMargin > maxMargin ? edges.top - maxMargin : 0
    const cropRight = rightMargin > maxMargin ? edges.right + maxMargin : w
    const cropBottom = bottomMargin > maxMargin ? edges.bottom + maxMargin : h

    if (cropLeft > 0 || cropTop > 0 || cropRight < w || cropBottom < h) {
      return {
        left: Math.max(0, cropLeft),
        top: Math.max(0, cropTop),
        width: Math.min(w, cropRight) - Math.max(0, cropLeft),
        height: Math.min(h, cropBottom) - Math.max(0, cropTop),
      }
    }
    return null
  }

  // ============================================================
  // Normalize (for back validation only — not used for upload)
  // ============================================================

  function areaAverageResize(rgba, srcW, srcH, dstW, dstH) {
    const out = new Uint8Array(dstW * dstH * 4)
    const xRatio = srcW / dstW, yRatio = srcH / dstH
    for (let dy = 0; dy < dstH; dy++) {
      const y0 = Math.floor(dy * yRatio), y1 = Math.min(Math.floor((dy + 1) * yRatio), srcH)
      for (let dx = 0; dx < dstW; dx++) {
        const x0 = Math.floor(dx * xRatio), x1 = Math.min(Math.floor((dx + 1) * xRatio), srcW)
        let r = 0, g = 0, b = 0, a = 0, count = 0
        for (let sy = y0; sy < y1; sy++) {
          for (let sx = x0; sx < x1; sx++) {
            const idx = (sy * srcW + sx) * 4
            r += rgba[idx]; g += rgba[idx + 1]; b += rgba[idx + 2]; a += rgba[idx + 3]; count++
          }
        }
        const oi = (dy * dstW + dx) * 4
        if (count > 0) { out[oi] = Math.round(r / count); out[oi + 1] = Math.round(g / count); out[oi + 2] = Math.round(b / count); out[oi + 3] = Math.round(a / count) }
      }
    }
    return out
  }

  function toGrayscale(rgba, w, h) {
    const gray = new Uint8Array(w * h)
    for (let i = 0; i < w * h; i++) {
      const idx = i * 4
      gray[i] = Math.round(0.2126 * rgba[idx] + 0.7152 * rgba[idx + 1] + 0.0722 * rgba[idx + 2])
    }
    return gray
  }

  function rotate90CW(rgba, w, h) {
    const out = new Uint8Array(w * h * 4)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const srcIdx = (y * w + x) * 4
        const nx = h - 1 - y, ny = x
        const dstIdx = (ny * h + nx) * 4
        out[dstIdx] = rgba[srcIdx]; out[dstIdx + 1] = rgba[srcIdx + 1]; out[dstIdx + 2] = rgba[srcIdx + 2]; out[dstIdx + 3] = rgba[srcIdx + 3]
      }
    }
    return { data: out, w: h, h: w }
  }

  function normalizeForHash(rgba, w, h) {
    let pixels = rgba, pw = w, ph = h
    if (pw > ph) { const r = rotate90CW(pixels, pw, ph); pixels = r.data; pw = r.w; ph = r.h }
    const rgb = areaAverageResize(pixels, pw, ph, CANONICAL_W, CANONICAL_H)
    return { rgb, w: CANONICAL_W, h: CANONICAL_H }
  }

  // ============================================================
  // hash.js
  // ============================================================
  function dHash256(gray, w, h) {
    const cols = 17, rows = 16
    const xRatio = w / cols, yRatio = h / rows
    const small = new Float32Array(cols * rows)
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x0 = Math.floor(c * xRatio), x1 = Math.min(Math.floor((c + 1) * xRatio), w)
        const y0 = Math.floor(r * yRatio), y1 = Math.min(Math.floor((r + 1) * yRatio), h)
        let sum = 0, count = 0
        for (let y = y0; y < y1; y++) { for (let x = x0; x < x1; x++) { sum += gray[y * w + x]; count++ } }
        small[r * cols + c] = count > 0 ? sum / count : 0
      }
    }
    const hash = new Uint32Array(8)
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < 16; c++) {
        const bit = small[r * cols + c] > small[r * cols + c + 1] ? 1 : 0
        const bitIndex = r * 16 + c
        if (bit) hash[bitIndex >> 5] |= (1 << (bitIndex & 31))
      }
    }
    return hash
  }

  function hammingDistance(a, b) {
    let dist = 0
    const len = Math.min(a.length, b.length)
    for (let i = 0; i < len; i++) { let x = a[i] ^ b[i]; while (x) { dist++; x &= (x - 1) } }
    return dist
  }

  function hexToHash(hex, words) {
    const arr = new Uint32Array(words || (hex.length / 8))
    for (let i = 0; i < arr.length; i++) arr[i] = parseInt(hex.substr(i * 8, 8), 16)
    return arr
  }

  // ============================================================
  // histogram.js
  // ============================================================
  const HIST_BINS = 64

  function computeHistogram(rgba, w, h) {
    const hist = new Float32Array(HIST_BINS)
    const total = w * h
    for (let i = 0; i < total; i++) {
      const idx = i * 4
      const ri = rgba[idx] >> 6, gi = rgba[idx + 1] >> 6, bi = rgba[idx + 2] >> 6
      hist[(ri << 4) | (gi << 2) | bi]++
    }
    for (let i = 0; i < HIST_BINS; i++) hist[i] /= total
    return hist
  }

  function histogramIntersection(a, b) {
    let sum = 0
    for (let i = 0; i < HIST_BINS; i++) sum += Math.min(a[i], b[i])
    return sum
  }

  // ============================================================
  // Back validation
  // ============================================================
  const DEFAULTS = { BACK_HASH_MAX: 40, BACK_HIST_MIN: 0.80 }

  function rgbaToGray(rgba, w, h) {
    const gray = new Uint8Array(w * h)
    for (let i = 0; i < w * h; i++) {
      const idx = i * 4
      gray[i] = Math.round(0.2126 * rgba[idx] + 0.7152 * rgba[idx + 1] + 0.0722 * rgba[idx + 2])
    }
    return gray
  }

  function validateBack(cropRGBA, cropW, cropH, backRef, thresholds) {
    const t = Object.assign({}, DEFAULTS, thresholds || {})
    // Normalize cropped image for hashing
    const norm = normalizeForHash(cropRGBA, cropW, cropH)
    const gray = rgbaToGray(norm.rgb, CANONICAL_W, CANONICAL_H)
    const h_full = dHash256(gray, CANONICAL_W, CANONICAL_H)
    const hist = computeHistogram(norm.rgb, CANONICAL_W, CANONICAL_H)

    const refH_full = typeof backRef.h_full === 'string' ? hexToHash(backRef.h_full, 8) : backRef.h_full
    const refHist = backRef.hist
    const hashDist = hammingDistance(h_full, refH_full)
    const histSim = histogramIntersection(hist, refHist)

    const matched = hashDist <= t.BACK_HASH_MAX && histSim >= t.BACK_HIST_MIN
    return { matched, hashDist, histSim: Math.round(histSim * 100) / 100 }
  }

  // ============================================================
  // sha256
  // ============================================================
  async function sha256(buf) {
    const hashBuf = await crypto.subtle.digest('SHA-256', buf)
    return Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('')
  }

  // ============================================================
  // Error messages
  // ============================================================
  const ERRORS = {
    E_FORMAT: 'File must be a JPEG, PNG, or WebP image.',
    E_SIZE: 'File must be at least 50 KB.',
    E_DECODE: 'Could not decode the image file.',
    E_EDGES: 'Card edges not detected — ensure the card is on a dark or white background.',
    E_DPI: (dpi) => `Scanner DPI ${dpi} (minimum ${MIN_DPI})`,
    E_DIMENSIONS: (reason) => reason,
    E_ASPECT: "Image doesn't look like a single card. Crop to the card edges.",
    E_BACK_MISMATCH: 'Back image doesn\'t match the Hyper Battle card back.',
  }

  // ============================================================
  // Decode helper
  // ============================================================
  async function decodeToRGBA(file) {
    const bitmap = await createImageBitmap(file)
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(bitmap, 0, 0)
    const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height)
    return { data: new Uint8Array(imageData.data), w: bitmap.width, h: bitmap.height, bitmap }
  }

  // ============================================================
  // Main validation — scanner-quality crop + back check
  // ============================================================
  async function validateCardImage(file, zoneName, refs) {
    const buf = new Uint8Array(await file.arrayBuffer())

    // File sanity
    const sanity = checkFile(buf)
    if (!sanity.valid) {
      const errors = sanity.errors.map(e => {
        if (e.includes('small')) return { code: 'E_SIZE', message: ERRORS.E_SIZE }
        return { code: 'E_FORMAT', message: ERRORS.E_FORMAT }
      })
      return { passed: false, errors, warnings: [] }
    }

    // Decode
    let rgba, bitmap
    try {
      const decoded = await decodeToRGBA(file)
      rgba = decoded.data
      bitmap = decoded.bitmap
    } catch (e) {
      return { passed: false, errors: [{ code: 'E_DECODE', message: ERRORS.E_DECODE }], warnings: [] }
    }

    const w = bitmap.width
    const h = bitmap.height
    const ch = 4

    // Resolution check
    const shortSide = Math.min(w, h)
    const longSide = Math.max(w, h)
    if (shortSide < MIN_SHORT_SIDE || longSide > MAX_LONG_SIDE) {
      return { passed: false, errors: [{ code: 'E_DIMENSIONS', message: 'Image resolution too low or too high.' }], warnings: [] }
    }

    // Edge detection (scanner algorithm)
    const edges = detectCardEdges(rgba, w, h, ch)
    if (!edges.found) {
      return { passed: false, errors: [{ code: 'E_EDGES', message: ERRORS.E_EDGES }], warnings: [] }
    }

    // DPI detection
    let imageDpi = null
    // createImageBitmap doesn't expose DPI in browsers; try file name heuristic or skip
    // In practice, scanner images embed DPI in EXIF — browser strips it.
    // We infer from card content size vs empirical reference.
    const cardDpi = detectCardDPI(edges, imageDpi)
    if (!cardDpi.meetsMinimum) {
      return { passed: false, errors: [{ code: 'E_DPI', message: ERRORS.E_DPI(cardDpi.effectiveDPI) }], warnings: [] }
    }

    // Dimension validation
    const dimensions = validateCardDimensions(edges, cardDpi.effectiveDPI)
    if (!dimensions.valid) {
      return { passed: false, errors: [{ code: 'E_DIMENSIONS', message: ERRORS.E_DIMENSIONS(dimensions.reason) }], warnings: [] }
    }

    // Background validation
    const background = validateBackground(rgba, w, h, ch, edges)

    // Flush edge detection
    const flushEdges = detectFlushEdges(edges, w, h)

    // Crop (scanner 5% max margin logic)
    const crop = computeCrop(edges, w, h)

    // Build warnings
    const warnings = []
    if (flushEdges.hasFlush) warnings.push(`Card is flush with image edge (${flushEdges.flush.join(', ')}) — verify card is not cut off`)
    if (!background.isBackground) warnings.push(`Background not uniform (${Math.round(background.bgRatio * 100)}%) — scanner bed may have debris`)

    // --- Crop to canvas (full resolution) ---
    let cropCanvas, cropCtx, cropW, cropH
    if (crop) {
      cropCanvas = document.createElement('canvas')
      cropCanvas.width = crop.width
      cropCanvas.height = crop.height
      cropCtx = cropCanvas.getContext('2d', { willReadFrequently: true })
      cropCtx.drawImage(bitmap, crop.left, crop.top, crop.width, crop.height, 0, 0, crop.width, crop.height)
      cropW = crop.width
      cropH = crop.height
    } else {
      cropCanvas = document.createElement('canvas')
      cropCanvas.width = w
      cropCanvas.height = h
      cropCtx = cropCanvas.getContext('2d', { willReadFrequently: true })
      cropCtx.drawImage(bitmap, 0, 0)
      cropW = w
      cropH = h
    }

    // Normalize to portrait for back validation
    let portraitCanvas = cropCanvas, portraitCtx = cropCtx, portraitW = cropW, portraitH = cropH
    if (cropW > cropH) {
      portraitCanvas = document.createElement('canvas')
      portraitCanvas.width = cropH
      portraitCanvas.height = cropW
      portraitCtx = portraitCanvas.getContext('2d', { willReadFrequently: true })
      portraitCtx.translate(cropH, 0)
      portraitCtx.rotate(Math.PI / 2)
      portraitCtx.drawImage(cropCanvas, 0, 0)
      portraitW = cropH
      portraitH = cropW
    }

    // --- Back validation (if back zone) ---
    if (zoneName === 'back') {
      const thresholds = (refs && refs.thresholds) || {}
      const backRef = refs && refs.back

      if (backRef) {
        // Get RGBA from portrait canvas for hashing
        const backImageData = portraitCtx.getImageData(0, 0, portraitW, portraitH)
        const backRGBA = new Uint8Array(backImageData.data)
        const backResult = validateBack(backRGBA, portraitW, portraitH, backRef, thresholds)

        if (!backResult.matched) {
          return {
            passed: false,
            errors: [{ code: 'E_BACK_MISMATCH', message: ERRORS.E_BACK_MISMATCH }],
            warnings,
            backResult,
          }
        }

        // Build upload JPEG (full resolution, quality 0.90)
        const jpegBuf = await canvasToJPEG(cropCanvas)
        const hash = await sha256(jpegBuf)
        return {
          passed: true,
          hash,
          uploadBuffer: jpegBuf,
          size: jpegBuf.length,
          originalHash: await sha256(buf),
          width: w,
          height: h,
          cardWidth: edges.cardWidth,
          cardHeight: edges.cardHeight,
          imageDpi: cardDpi.effectiveDPI,
          orientation: dimensions.orientation,
          cropped: !!crop,
          backResult,
          warnings,
        }
      } else {
        // No back reference loaded — skip back validation
        const jpegBuf = await canvasToJPEG(cropCanvas)
        const hash = await sha256(jpegBuf)
        return {
          passed: true,
          hash,
          uploadBuffer: jpegBuf,
          size: jpegBuf.length,
          originalHash: await sha256(buf),
          width: w,
          height: h,
          cardWidth: edges.cardWidth,
          cardHeight: edges.cardHeight,
          imageDpi: cardDpi.effectiveDPI,
          orientation: dimensions.orientation,
          cropped: !!crop,
          warnings,
        }
      }
    }

    // --- Front (no identification — just sanity + crop) ---
    const jpegBuf = await canvasToJPEG(cropCanvas)
    const hash = await sha256(jpegBuf)
    return {
      passed: true,
      hash,
      uploadBuffer: jpegBuf,
      size: jpegBuf.length,
      originalHash: await sha256(buf),
      width: w,
      height: h,
      cardWidth: edges.cardWidth,
      cardHeight: edges.cardHeight,
      imageDpi: cardDpi.effectiveDPI,
      orientation: dimensions.orientation,
      cropped: !!crop,
      warnings,
    }
  }

  // ============================================================
  // Canvas → JPEG at quality 0.90 (browser equivalent of sharp q90)
  // ============================================================
  async function canvasToJPEG(canvas) {
    const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', JPEG_QUALITY))
    return new Uint8Array(await blob.arrayBuffer())
  }

  // ============================================================
  // References loader
  // ============================================================
  let _refs = null
  let _refsPromise = null

  async function loadReferences(apiBase) {
    if (_refs) return _refs
    if (_refsPromise) return _refsPromise
    _refsPromise = fetch(`${apiBase}/references/json`)
      .then(r => { if (!r.ok) throw new Error('Failed to load references'); return r.json() })
      .then(data => { _refs = data; return data })
    return _refsPromise
  }

  // ============================================================
  // Public API
  // ============================================================
  window.HBValidator = {
    validateCardImage,
    loadReferences,
    sha256,
    ERRORS,
    CANONICAL_W,
    CANONICAL_H,
    MIN_DPI,
    REF_CARD_WIDTH_600,
    REF_CARD_HEIGHT_600,
  }
})()
