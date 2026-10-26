/**
 * Browser validator — OpenCV contour crop + back validation
 * 
 * Pipeline:
 *   1. File sanity (format, size)
 *   2. Decode → canvas → JPEG q0.90 (upfront conversion, smaller for all downstream)
 *   3. OpenCV contour crop (brown ring detection + quad scoring) → portrait JPEG
 *   4. Back validation: dHash + histogram against reference
 * 
 * Exposes window.HBValidator with validateCardImage(file, zoneName, refs)
 */

(function () {
  'use strict'

  // ============================================================
  // Constants
  // ============================================================
  const JPEG_QUALITY = 0.90
  const MIN_BYTES = 50 * 1024
  const MIN_SHORT_SIDE = 400
  const MAX_LONG_SIDE = 6000

  // Back validation
  const CANONICAL_W = 256
  const CANONICAL_H = 358
  const DEFAULTS = { BACK_HASH_MAX: 40, BACK_HIST_MIN: 0.80 }

  // OpenCV contour crop constants
  const TARGET_RATIO = 2.5 / 3.5
  const RATIO_TOLERANCE = 0.15
  const RING_GATE = 0.03
  const DETECT_W = 400

  // ============================================================
  // Format detection + file sanity
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
  // Decode → canvas → JPEG q0.90 (upfront conversion)
  // ============================================================
  async function decodeToJPEG(file) {
    const bitmap = await createImageBitmap(file)
    const w = bitmap.width
    const h = bitmap.height

    // Resolution check
    const shortSide = Math.min(w, h)
    const longSide = Math.max(w, h)
    if (shortSide < MIN_SHORT_SIDE || longSide > MAX_LONG_SIDE) {
      bitmap.close && bitmap.close()
      return { error: 'Image resolution too low or too high.' }
    }

    // Draw to canvas
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(bitmap, 0, 0)

    // Convert to JPEG q0.90
    const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', JPEG_QUALITY))
    const jpegBuf = new Uint8Array(await blob.arrayBuffer())

    // Also get RGBA for OpenCV
    const imageData = ctx.getImageData(0, 0, w, h)
    const rgba = new Uint8Array(imageData.data)

    bitmap.close && bitmap.close()
    return { jpegBuf, rgba, w, h, canvas, ctx }
  }

  // ============================================================
  // OpenCV helpers (ported from crop.js)
  // ============================================================
  function waitForOpenCV() {
    return new Promise((resolve, reject) => {
      if (typeof cv !== 'undefined' && cv.Mat) return resolve()

      // cv is loaded async — it calls onRuntimeInitialized
      if (typeof cv !== 'undefined' && typeof cv.then === 'function') {
        cv().then(resolve).catch(reject)
        return
      }

      // Wait for global cv to be ready
      let tries = 0
      const interval = setInterval(() => {
        tries++
        if (typeof cv !== 'undefined' && cv.Mat) {
          clearInterval(interval)
          resolve()
        } else if (tries > 200) { // 10 seconds
          clearInterval(interval)
          reject(new Error('OpenCV.js failed to load'))
        }
      }, 50)
    })
  }

  function rgbaToMat(cv, data, width, height) {
    const mat = new cv.Mat(height, width, cv.CV_8UC4)
    mat.data.set(data)
    return mat
  }

  function orderPoints(pts) {
    const sorted = [...pts].sort((a, b) => a[0] + a[1] - b[0] - b[1])
    const tl = sorted[0]
    const br = sorted[sorted.length - 1]
    const remaining = pts.filter(p => p !== tl && p !== br)
    const tr = remaining[0][0] > remaining[1][0] ? remaining[0] : remaining[1]
    const bl = remaining[0][0] <= remaining[1][0] ? remaining[0] : remaining[1]
    return [tl, tr, br, bl]
  }

  function dist(a, b) {
    const dx = a[0] - b[0], dy = a[1] - b[1]
    return Math.sqrt(dx * dx + dy * dy)
  }

  function angleAt(a, b, c) {
    const v1x = a[0] - b[0], v1y = a[1] - b[1]
    const v2x = c[0] - b[0], v2y = c[1] - b[1]
    const dot = v1x * v2x + v1y * v2y
    const mag1 = Math.sqrt(v1x * v1x + v1y * v1y)
    const mag2 = Math.sqrt(v2x * v2x + v2y * v2y)
    if (mag1 === 0 || mag2 === 0) return 0
    const cosA = Math.max(-1, Math.min(1, dot / (mag1 * mag2)))
    return Math.acos(cosA) * 180 / Math.PI
  }

  function scoreQuad(quad) {
    const [tl, tr, br, bl] = quad
    const top = dist(tl, tr)
    const right = dist(tr, br)
    const bottom = dist(br, bl)
    const left = dist(bl, tl)
    const avgW = (top + bottom) / 2
    const avgH = (left + right) / 2

    if (avgH === 0) return { score: 0, ratio: 0, ratioScore: 0, angleScore: 0, sideScore: 0, angles: [] }
    const ratio = avgW / avgH
    const ratioOff = Math.abs(ratio - TARGET_RATIO) / TARGET_RATIO
    if (ratioOff > RATIO_TOLERANCE) return { score: 0, ratio, ratioScore: 0, angleScore: 0, sideScore: 0, angles: [] }
    const ratioScore = 1 - Math.min(1, ratioOff)

    const angles = [
      angleAt(bl, tl, tr),
      angleAt(tl, tr, br),
      angleAt(tr, br, bl),
      angleAt(br, bl, tl),
    ]
    const angleScore = angles.reduce((s, a) => s + (1 - Math.min(1, Math.abs(a - 90) / 45)), 0) / 4

    const topBotDiff = Math.abs(top - bottom) / Math.max(top, bottom, 1)
    const leftRightDiff = Math.abs(left - right) / Math.max(left, right, 1)
    const sideScore = (1 - topBotDiff + 1 - leftRightDiff) / 2

    const score = ratioScore * 0.35 + angleScore * 0.35 + sideScore * 0.30
    return { score, ratio, ratioScore, angleScore, sideScore, angles }
  }

  function brownRingCheck(cv, src, quad, width, height) {
    const xs = quad.map(c => c[0])
    const ys = quad.map(c => c[1])
    const x0 = Math.max(0, Math.round(Math.min(...xs)))
    const y0 = Math.max(0, Math.round(Math.min(...ys)))
    const x1 = Math.min(width - 1, Math.round(Math.max(...xs)))
    const y1 = Math.min(height - 1, Math.round(Math.max(...ys)))
    const bw = x1 - x0
    const bh = y1 - y0
    if (bw < 10 || bh < 10) return 0

    const region = src.roi(new cv.Rect(x0, y0, bw, bh))
    const hsv = new cv.Mat()
    cv.cvtColor(region, hsv, cv.COLOR_RGBA2HSV)
    const low = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [10, 40, 40, 0])
    const high = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [30, 255, 220, 255])
    const mask = new cv.Mat()
    cv.inRange(hsv, low, high, mask)

    const band = 5
    let brownCount = 0, totalCount = 0
    for (let y = 0; y < Math.min(band, bh); y++) {
      for (let x = 0; x < bw; x++) { totalCount++; if (mask.data[y * bw + x]) brownCount++ }
    }
    for (let y = Math.max(0, bh - band); y < bh; y++) {
      for (let x = 0; x < bw; x++) { totalCount++; if (mask.data[y * bw + x]) brownCount++ }
    }
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < Math.min(band, bw); x++) { totalCount++; if (mask.data[y * bw + x]) brownCount++ }
    }
    for (let y = 0; y < bh; y++) {
      for (let x = Math.max(0, bw - band); x < bw; x++) { totalCount++; if (mask.data[y * bw + x]) brownCount++ }
    }

    region.delete(); hsv.delete(); low.delete(); high.delete(); mask.delete()
    return totalCount > 0 ? brownCount / totalCount : 0
  }

  // ============================================================
  // OpenCV contour-based card crop
  // ============================================================
  function detectCardOpenCV(cv, rgba, width, height) {
    // Work at detectW=400 for speed
    const detectH = Math.round(DETECT_W * (height / width))
    const scaleCanvas = document.createElement('canvas')
    scaleCanvas.width = DETECT_W
    scaleCanvas.height = detectH
    const scaleCtx = scaleCanvas.getContext('2d', { willReadFrequently: true })

    // Draw scaled from source RGBA
    const srcCanvas = document.createElement('canvas')
    srcCanvas.width = width
    srcCanvas.height = height
    const srcCtx = srcCanvas.getContext('2d')
    const imgData = new ImageData(new Uint8ClampedArray(rgba), width, height)
    srcCtx.putImageData(imgData, 0, 0)
    scaleCtx.drawImage(srcCanvas, 0, 0, DETECT_W, detectH)

    const scaledData = scaleCtx.getImageData(0, 0, DETECT_W, detectH)
    const src = rgbaToMat(cv, new Uint8Array(scaledData.data), DETECT_W, detectH)

    const gray = new cv.Mat()
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY)

    const blurred = new cv.Mat()
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT)

    const cannyThresholds = [[50, 150], [75, 200], [30, 100]]
    const imageSize = DETECT_W * detectH
    const candidates = []

    for (const [lo, hi] of cannyThresholds) {
      const edges = new cv.Mat()
      cv.Canny(blurred, edges, lo, hi, 3, false)
      const dilated = new cv.Mat()
      const kernel = cv.Mat.ones(3, 3, cv.CV_8U)
      cv.dilate(edges, dilated, kernel, new cv.Point(-1, -1), 1, cv.BORDER_CONSTANT, cv.morphologyDefaultBorderValue())

      const contours = new cv.MatVector()
      const hierarchy = new cv.Mat()
      cv.findContours(dilated, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE)

      for (let i = 0; i < contours.size(); i++) {
        const contour = contours.get(i)
        const area = cv.contourArea(contour)
        if (area < imageSize * 0.2) { contour.delete(); continue }

        const approx = new cv.Mat()
        const peri = cv.arcLength(contour, true)
        cv.approxPolyDP(contour, approx, 0.02 * peri, true)
        if (approx.rows !== 4) { approx.delete(); contour.delete(); continue }

        const pts = []
        for (let j = 0; j < 4; j++) pts.push([approx.data32S[j * 2], approx.data32S[j * 2 + 1]])
        approx.delete(); contour.delete()

        const ordered = orderPoints(pts)
        const metrics = scoreQuad(ordered)
        if (metrics.score < 0.1) continue

        candidates.push({ corners: ordered, area, areaPct: area / imageSize, canny: [lo, hi], ...metrics })
      }

      edges.delete(); dilated.delete(); kernel.delete()
      contours.delete(); hierarchy.delete()
    }

    // Brown ring check + final score
    for (const c of candidates) {
      c.ringScore = brownRingCheck(cv, src, c.corners, DETECT_W, detectH)
      const ringBonus = Math.min(1, c.ringScore / 0.15)
      c.finalScore = c.score * 0.6 + ringBonus * 0.4
    }

    let passed = candidates.filter(c => c.ringScore >= RING_GATE)
    passed.sort((a, b) => b.finalScore - a.finalScore)

    // Hull fallback
    if (passed.length === 0) {
      for (const [lo, hi] of cannyThresholds) {
        const edges = new cv.Mat()
        cv.Canny(blurred, edges, lo, hi, 3, false)
        const dilated = new cv.Mat()
        const kernel = cv.Mat.ones(3, 3, cv.CV_8U)
        cv.dilate(edges, dilated, kernel, new cv.Point(-1, -1), 1, cv.BORDER_CONSTANT, cv.morphologyDefaultBorderValue())
        const contours = new cv.MatVector()
        const hierarchy = new cv.Mat()
        cv.findContours(dilated, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE)

        for (let i = 0; i < contours.size(); i++) {
          const contour = contours.get(i)
          const area = cv.contourArea(contour)
          if (area < imageSize * 0.2) { contour.delete(); continue }

          let quadPts = null
          const hull = new cv.Mat()
          cv.convexHull(contour, hull, false, true)
          if (hull.rows >= 4) {
            const hullPeri = cv.arcLength(hull, true)
            for (const eps of [0.01, 0.02, 0.03, 0.05, 0.08, 0.1, 0.15]) {
              const hullApprox = new cv.Mat()
              cv.approxPolyDP(hull, hullApprox, eps * hullPeri, true)
              if (hullApprox.rows === 4) {
                quadPts = []
                for (let j = 0; j < 4; j++) quadPts.push([hullApprox.data32S[j * 2], hullApprox.data32S[j * 2 + 1]])
                hullApprox.delete()
                break
              }
              hullApprox.delete()
            }
          }

          if (!quadPts) {
            const rect = cv.minAreaRect(contour)
            const boxPts = cv.boxPoints(rect)
            if (boxPts && boxPts.rows === 4) {
              quadPts = []
              for (let j = 0; j < 4; j++) quadPts.push([Math.round(boxPts.data32F[j * 2]), Math.round(boxPts.data32F[j * 2 + 1])])
            }
          }

          hull.delete(); contour.delete()
          if (!quadPts) continue

          const ordered = orderPoints(quadPts)
          const metrics = scoreQuad(ordered)
          if (metrics.score < 0.1) continue
          const ringScore = brownRingCheck(cv, src, ordered, DETECT_W, detectH)
          if (ringScore < RING_GATE) continue
          const ringBonus = Math.min(1, ringScore / 0.15)
          passed.push({ corners: ordered, area, areaPct: area / imageSize, canny: [lo, hi], method: 'hull', ...metrics, ringScore, finalScore: metrics.score * 0.6 + ringBonus * 0.4 })
        }

        edges.delete(); dilated.delete(); kernel.delete()
        contours.delete(); hierarchy.delete()
        if (passed.length > 0) break
      }
    }

    src.delete(); gray.delete(); blurred.delete()

    if (passed.length === 0) return null

    // Select outermost candidate
    const BORDER_MARGIN = 3
    function bbox(c) {
      const xs = c.corners.map(p => p[0])
      const ys = c.corners.map(p => p[1])
      return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }
    }
    function touchesBorder(c) {
      const b = bbox(c)
      return b.minX < BORDER_MARGIN || b.minY < BORDER_MARGIN || b.maxX > DETECT_W - BORDER_MARGIN || b.maxY > detectH - BORDER_MARGIN
    }
    function contains(a, b) {
      const ba = bbox(a), bb = bbox(b)
      return bb.minX >= ba.minX && bb.maxX <= ba.maxX && bb.minY >= ba.minY && bb.maxY <= ba.maxY
    }
    const nonBorder = passed.filter(c => !touchesBorder(c))
    const pool = nonBorder.length > 0 ? nonBorder : passed
    let best = pool[0]
    for (const c of pool) { if (contains(c, best)) best = c }

    // Scale corners back to full resolution
    const scaleX = width / DETECT_W
    const scaleY = height / detectH
    const scaledCorners = best.corners.map(([x, y]) => [Math.round(x * scaleX), Math.round(y * scaleY)])

    // Compute bounding box from corners
    const xs = scaledCorners.map(c => c[0])
    const ys = scaledCorners.map(c => c[1])
    return {
      left: Math.max(0, Math.round(Math.min(...xs))),
      top: Math.max(0, Math.round(Math.min(...ys))),
      right: Math.min(width, Math.round(Math.max(...xs))),
      bottom: Math.min(height, Math.round(Math.max(...ys))),
      corners: scaledCorners,
      method: best.method || 'contour',
    }
  }

  // ============================================================
  // Brown border HSV fallback
  // ============================================================
  function detectBrownBorder(cv, rgba, width, height) {
    const detectH = Math.round(DETECT_W * (height / width))
    const scaleCanvas = document.createElement('canvas')
    scaleCanvas.width = DETECT_W
    scaleCanvas.height = detectH
    const scaleCtx = scaleCanvas.getContext('2d', { willReadFrequently: true })

    const srcCanvas = document.createElement('canvas')
    srcCanvas.width = width
    srcCanvas.height = height
    const srcCtx = srcCanvas.getContext('2d')
    const imgData = new ImageData(new Uint8ClampedArray(rgba), width, height)
    srcCtx.putImageData(imgData, 0, 0)
    scaleCtx.drawImage(srcCanvas, 0, 0, DETECT_W, detectH)

    const scaledData = scaleCtx.getImageData(0, 0, DETECT_W, detectH)
    const src = rgbaToMat(cv, new Uint8Array(scaledData.data), DETECT_W, detectH)

    const hsv = new cv.Mat()
    cv.cvtColor(src, hsv, cv.COLOR_RGBA2HSV)
    const low = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [10, 40, 40, 0])
    const high = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [30, 255, 220, 255])
    const mask = new cv.Mat()
    cv.inRange(hsv, low, high, mask)

    const contours = new cv.MatVector()
    const hierarchy = new cv.Mat()
    cv.findContours(mask, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE)

    let bestContour = null, bestArea = 0
    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i)
      const area = cv.contourArea(contour)
      if (area > bestArea) { bestContour = contour; bestArea = area }
    }

    if (!bestContour) {
      src.delete(); hsv.delete(); low.delete(); high.delete(); mask.delete()
      contours.delete(); hierarchy.delete()
      return null
    }

    const rect = cv.boundingRect(bestContour)
    const scaleX = width / DETECT_W
    const scaleY = height / detectH
    const bounds = {
      left: Math.max(0, Math.round(rect.x * scaleX)),
      top: Math.max(0, Math.round(rect.y * scaleY)),
      right: Math.min(width, Math.round((rect.x + rect.width) * scaleX)),
      bottom: Math.min(height, Math.round((rect.y + rect.height) * scaleY)),
    }

    src.delete(); hsv.delete(); low.delete(); high.delete(); mask.delete()
    contours.delete(); hierarchy.delete()
    return bounds
  }

  // ============================================================
  // Crop canvas → JPEG q0.90 (portrait)
  // ============================================================
  function cropCanvasToJPEG(sourceCanvas, left, top, w, h) {
    // First crop to the bounds
    const cropCanvas = document.createElement('canvas')
    cropCanvas.width = w
    cropCanvas.height = h
    const cropCtx = cropCanvas.getContext('2d', { willReadFrequently: true })
    cropCtx.drawImage(sourceCanvas, left, top, w, h, 0, 0, w, h)

    // If landscape, rotate 90 CW to portrait
    if (w > h) {
      const rotated = document.createElement('canvas')
      rotated.width = h
      rotated.height = w
      const rctx = rotated.getContext('2d', { willReadFrequently: true })
      rctx.translate(rotated.width, 0)
      rctx.rotate(Math.PI / 2)
      rctx.drawImage(cropCanvas, 0, 0)
      return rotated
    }

    return cropCanvas
  }

  async function canvasToJPEG(canvas) {
    const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', JPEG_QUALITY))
    return new Uint8Array(await blob.arrayBuffer())
  }

  // ============================================================
  // Back validation (dHash + histogram)
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

  function rgbaToGray(rgba, w, h) {
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
    let d = 0
    const len = Math.min(a.length, b.length)
    for (let i = 0; i < len; i++) { let x = a[i] ^ b[i]; while (x) { d++; x &= (x - 1) } }
    return d
  }

  function hexToHash(hex, words) {
    const arr = new Uint32Array(words || (hex.length / 8))
    for (let i = 0; i < arr.length; i++) arr[i] = parseInt(hex.substr(i * 8, 8), 16)
    return arr
  }

  function histogramIntersection(a, b) {
    let sum = 0
    for (let i = 0; i < HIST_BINS; i++) sum += Math.min(a[i], b[i])
    return sum
  }

  function validateBack(cropRGBA, cropW, cropH, backRef, thresholds) {
    const t = Object.assign({}, DEFAULTS, thresholds || {})
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
  // Main validation
  // ============================================================
  async function validateCardImage(file, zoneName, refs) {
    const buf = new Uint8Array(await file.arrayBuffer())

    // File sanity
    const sanity = checkFile(buf)
    if (!sanity.valid) {
      const errors = sanity.errors.map(e => {
        if (e.includes('small')) return { code: 'E_SIZE', message: 'File must be at least 50 KB.' }
        return { code: 'E_FORMAT', message: 'File must be a JPEG, PNG, or WebP image.' }
      })
      return { passed: false, errors, warnings: [] }
    }

    // Decode → JPEG upfront (smaller for all downstream processing)
    let decoded
    try {
      decoded = await decodeToJPEG(file)
    } catch (e) {
      return { passed: false, errors: [{ code: 'E_DECODE', message: 'Could not decode the image file.' }], warnings: [] }
    }
    if (decoded.error) {
      return { passed: false, errors: [{ code: 'E_DIMENSIONS', message: decoded.error }], warnings: [] }
    }

    const { rgba, w, h, canvas } = decoded

    // OpenCV contour crop
    let cropBounds = null
    let cropMethod = null
    try {
      await waitForOpenCV()
      cropBounds = detectCardOpenCV(cv, rgba, w, h)
      if (cropBounds) {
        cropMethod = cropBounds.method || 'contour'
      } else {
        // Fallback: brown border HSV
        cropBounds = detectBrownBorder(cv, rgba, w, h)
        if (cropBounds) cropMethod = 'brown-hsv'
      }
    } catch (e) {
      console.warn('OpenCV crop failed, using full image:', e.message)
    }

    // If no crop detected, use full image
    if (!cropBounds) {
      cropBounds = { left: 0, top: 0, right: w, bottom: h }
      cropMethod = 'none'
    }

    const cropW = cropBounds.right - cropBounds.left
    const cropH = cropBounds.bottom - cropBounds.top

    if (cropW < 10 || cropH < 10) {
      return { passed: false, errors: [{ code: 'E_EDGES', message: 'Card not detected — ensure the card is on a dark background.' }], warnings: [] }
    }

    // Crop to canvas (ensures portrait orientation)
    const cropCanvas = cropCanvasToJPEG(canvas, cropBounds.left, cropBounds.top, cropW, cropH)
    const portraitW = cropCanvas.width
    const portraitH = cropCanvas.height

    // Build JPEG from cropped canvas
    const jpegBuf = await canvasToJPEG(cropCanvas)
    const hash = await sha256(jpegBuf)

    // Build result
    const result = {
      passed: true,
      hash,
      uploadBuffer: jpegBuf,
      size: jpegBuf.length,
      originalHash: await sha256(buf),
      width: w,
      height: h,
      cardWidth: cropW,
      cardHeight: cropH,
      cropMethod,
      warnings: [],
    }

    // --- Back validation (if back zone) ---
    if (zoneName === 'back') {
      const thresholds = (refs && refs.thresholds) || {}
      const backRef = refs && refs.back

      if (backRef) {
        const backImageData = cropCanvas.getContext('2d').getImageData(0, 0, portraitW, portraitH)
        const backRGBA = new Uint8Array(backImageData.data)
        const backResult = validateBack(backRGBA, portraitW, portraitH, backRef, thresholds)

        if (!backResult.matched) {
          return {
            passed: false,
            errors: [{ code: 'E_BACK_MISMATCH', message: "Back image doesn't match the Hyper Battle card back." }],
            warnings: [],
            backResult,
          }
        }
        result.backResult = backResult
      }
    }

    return result
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
    waitForOpenCV,
    CANONICAL_W,
    CANONICAL_H,
  }
})()
