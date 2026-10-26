#!/usr/bin/env node
/**
 * card-id-test.cjs — Test suite for card-id.cjs
 * 
 * Tests:
 *   1. Every reference matches its own code at distance 0
 *   2. Variants (re-encoded q90, q75, scaled 50%, rotated 180°) match
 *      their own code at distance ≤ 4
 *   3. Reports distances in a table
 *
 * Usage: node scripts/card-id-test.cjs
 */

const fs = require('fs')
const path = require('path')

let sharp
try { sharp = require('sharp') } catch {
  console.error('sharp is required: npm install sharp')
  process.exit(1)
}

const { identify } = require('../lib/card-id.cjs')
const { cropCardFromRGBA } = require('../lib/card-crop.js')

const REFS_PATH = path.join(__dirname, '..', 'card-refs.json')
const REF_DIR = '/Users/axiemaid/.openclaw/cardid-detector/references'

// --- Helpers ---

async function decodeToRGBA(filePath) {
  const { data, info } = await sharp(filePath)
    .removeAlpha()
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  return { data: new Uint8Array(data), w: info.width, h: info.height }
}

async function rgbaToJPEG(rgba, w, h, quality = 0.90) {
  const buf = Buffer.from(rgba)
  return sharp(buf, { raw: { width: w, height: h, channels: 4 } })
    .jpeg({ quality: Math.round(quality * 100) })
    .toBuffer()
}

async function processReferenceToJPEG(filePath) {
  // Full browser pipeline: decode → crop → portrait rotate → JPEG q90
  const { data, w, h } = await decodeToRGBA(filePath)
  const cropped = cropCardFromRGBA(data, w, h)
  let cropRGBA = data
  let cropW = w
  let cropH = h
  if (cropped) {
    cropRGBA = cropped.rgba
    cropW = cropped.w
    cropH = cropped.h
  }
  // Ensure portrait
  let finalRGBA = cropRGBA
  let finalW = cropW
  let finalH = cropH
  if (finalW > finalH) {
    // Rotate 90 CW
    const rotated = new Uint8Array(finalW * finalH * 4)
    for (let y = 0; y < finalH; y++) {
      for (let x = 0; x < finalW; x++) {
        const srcIdx = (y * finalW + x) * 4
        const nx = finalH - 1 - y
        const ny = x
        const dstIdx = (ny * finalH + nx) * 4
        rotated[dstIdx] = cropRGBA[srcIdx]
        rotated[dstIdx + 1] = cropRGBA[srcIdx + 1]
        rotated[dstIdx + 2] = cropRGBA[srcIdx + 2]
        rotated[dstIdx + 3] = cropRGBA[srcIdx + 3]
      }
    }
    finalRGBA = rotated
    const tmp = finalW
    finalW = finalH
    finalH = tmp
  }
  const jpeg = await rgbaToJPEG(finalRGBA, finalW, finalH, 0.90)
  return jpeg
}

async function reencodeJPEG(jpegBuf, quality) {
  return sharp(jpegBuf).jpeg({ quality: Math.round(quality * 100) }).toBuffer()
}

async function scaleJPEG(jpegBuf, scale) {
  const meta = await sharp(jpegBuf).metadata()
  const newW = Math.round(meta.width * scale)
  return sharp(jpegBuf).resize({ width: newW }).jpeg({ quality: 90 }).toBuffer()
}

async function rotateJPEG180(jpegBuf) {
  const meta = await sharp(jpegBuf).metadata()
  const { data } = await sharp(jpegBuf)
    .removeAlpha()
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const rgba = new Uint8Array(data)
  const w = meta.width
  const h = meta.height
  const rotated = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const srcIdx = (y * w + x) * 4
      const dstIdx = ((h - 1 - y) * w + (w - 1 - x)) * 4
      rotated[dstIdx] = rgba[srcIdx]
      rotated[dstIdx + 1] = rgba[srcIdx + 1]
      rotated[dstIdx + 2] = rgba[srcIdx + 2]
      rotated[dstIdx + 3] = rgba[srcIdx + 3]
    }
  }
  return sharp(Buffer.from(rotated), { raw: { width: w, height: h, channels: 4 } })
    .jpeg({ quality: 90 })
    .toBuffer()
}

function parseCode(filename) {
  const base = path.basename(filename, path.extname(filename))
  const m = base.match(/^([CS]\d{2})/i)
  return m ? m[1].toUpperCase() : null
}

// --- Main ---

async function main() {
  console.log('=== Card-ID Test Suite ===\n')

  // Load references
  if (!fs.existsSync(REFS_PATH)) {
    console.error(`card-refs.json not found at ${REFS_PATH}`)
    console.error('Run: node scripts/build-refs.cjs first')
    process.exit(1)
  }
  const refsData = JSON.parse(fs.readFileSync(REFS_PATH, 'utf8'))
  console.log(`Loaded ${refsData.refs.length} references from card-refs.json\n`)

  // Collect reference files, group by code, take first per code
  const filesByCode = {}
  if (!fs.existsSync(REF_DIR)) {
    console.error(`Reference dir not found: ${REF_DIR}`)
    process.exit(1)
  }
  for (const file of fs.readdirSync(REF_DIR).sort()) {
    if (!/\.(png|jpe?g|webp|bmp)$/i.test(file)) continue
    const code = parseCode(file)
    if (!code) continue
    if (!filesByCode[code]) filesByCode[code] = file
  }

  const codes = Object.keys(filesByCode).sort()
  console.log(`Found ${codes.length} reference images in ${REF_DIR}\n`)

  // --- Test 1: Self-match at distance 0 ---
  console.log('--- Test 1: Self-match (distance should be 0) ---')
  console.log('CODE'.padEnd(6) + 'DIST'.padEnd(6) + 'MARGIN'.padEnd(8) + 'MATCHED'.padEnd(8) + 'PASS/FAIL')
  console.log('-'.repeat(45))

  let test1Pass = 0
  let test1Fail = 0
  const selfMatchResults = []

  for (const code of codes) {
    const file = filesByCode[code]
    const fullPath = path.join(REF_DIR, file)
    try {
      const jpegBuf = await processReferenceToJPEG(fullPath)
      const result = await identify(jpegBuf)
      const pass = result.ok && result.code === code && result.distance === 0
      if (pass) {
        test1Pass++
      } else {
        test1Fail++
      }
      selfMatchResults.push({ code, result })
      console.log(
        code.padEnd(6) +
        String(result.distance ?? '-').padEnd(6) +
        String(result.margin ?? '-').padEnd(8) +
        (result.code || '-').padEnd(8) +
        (pass ? '✓ PASS' : '✗ FAIL') +
        (result.reason && !result.ok ? ' (' + result.reason + ')' : '')
      )
    } catch (e) {
      test1Fail++
      selfMatchResults.push({ code, result: { ok: false, reason: e.message } })
      console.log(code.padEnd(6) + 'ERR'.padEnd(6) + '-'.padEnd(8) + '-'.padEnd(8) + '✗ FAIL (' + e.message + ')')
    }
  }

  console.log('-'.repeat(45))
  console.log(`Test 1: ${test1Pass}/${codes.length} passed\n`)

  // --- Test 2: Variant matching (distance ≤ 4) ---
  console.log('--- Test 2: Variant matching (distance should be ≤ 4) ---')
  console.log('CODE'.padEnd(6) + 'VARIANT'.padEnd(12) + 'DIST'.padEnd(6) + 'MARGIN'.padEnd(8) + 'MATCHED'.padEnd(8) + 'PASS/FAIL')
  console.log('-'.repeat(55))

  let test2Pass = 0
  let test2Fail = 0
  const variantResults = []

  const variants = [
    { name: 'q90', fn: (buf) => reencodeJPEG(buf, 0.90) },
    { name: 'q75', fn: (buf) => reencodeJPEG(buf, 0.75) },
    { name: 'scale50', fn: (buf) => scaleJPEG(buf, 0.50) },
    { name: 'rot180', fn: (buf) => rotateJPEG180(buf) },
  ]

  for (const code of codes) {
    const file = filesByCode[code]
    const fullPath = path.join(REF_DIR, file)

    // Get the processed base JPEG
    const baseJPEG = await processReferenceToJPEG(fullPath)

    for (const variant of variants) {
      try {
        const variantBuf = await variant.fn(baseJPEG)
        const result = await identify(variantBuf)
        const pass = result.ok && result.code === code && result.distance <= 4
        if (pass) {
          test2Pass++
        } else {
          test2Fail++
        }
        variantResults.push({ code, variant: variant.name, result })
        console.log(
          code.padEnd(6) +
          variant.name.padEnd(12) +
          String(result.distance ?? '-').padEnd(6) +
          String(result.margin ?? '-').padEnd(8) +
          (result.code || '-').padEnd(8) +
          (pass ? '✓ PASS' : '✗ FAIL') +
          (result.reason && !result.ok ? ' (' + result.reason + ')' : '')
        )
      } catch (e) {
        test2Fail++
        variantResults.push({ code, variant: variant.name, result: { ok: false, reason: e.message } })
        console.log(
          code.padEnd(6) +
          variant.name.padEnd(12) +
          'ERR'.padEnd(6) +
          '-'.padEnd(8) +
          '-'.padEnd(8) +
          '✗ FAIL (' + e.message + ')'
        )
      }
    }
  }

  console.log('-'.repeat(55))
  console.log(`Test 2: ${test2Pass}/${test2Pass + test2Fail} variants passed\n`)

  // --- Distance table ---
  console.log('--- Distance Table ---')
  const header = 'CODE'.padEnd(6)
  const variantNames = variants.map(v => v.name.padEnd(10))
  console.log(header + variantNames.join(''))
  console.log('-'.repeat(6 + variantNames.length * 10))

  for (const code of codes) {
    let row = code.padEnd(6)
    for (const variant of variants) {
      const entry = variantResults.find(v => v.code === code && v.variant === variant.name)
      const dist = entry && entry.result && entry.result.distance !== null && entry.result.distance !== undefined
        ? String(entry.result.distance)
        : 'ERR'
      row += dist.padEnd(10)
    }
    console.log(row)
  }

  // --- Summary ---
  console.log('\n=== Summary ===')
  console.log(`Test 1 (self-match distance 0): ${test1Pass}/${codes.length} passed`)
  console.log(`Test 2 (variants distance ≤ 4): ${test2Pass}/${test2Pass + test2Fail} passed`)

  if (test1Fail > 0 || test2Fail > 0) {
    console.log('\n⚠ FAILURES — see details above')
    process.exit(1)
  } else {
    console.log('\n✓ All tests passed.')
  }
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
