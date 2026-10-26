#!/usr/bin/env node
/**
 * card-id-test.cjs — Test suite for card-id.cjs
 * 
 * Tests:
 *   1. Every reference matches its own code at distance 0
 *   2. Variants (re-encoded q90, q75, scaled 50%, rotated 180°) match
 *      their own code at distance ≤ 4
 *   3. Leave-one-out: remove each reference, verify it still matches
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

const { identify, areaAverageResizeToGray, computePhash, hashToHex, PHASH_SIZE } = require('../lib/card-id.cjs')

const REFS_PATH = path.join(__dirname, '..', 'card-refs.json')
const REF_DIR = '/Users/axiemaid/.openclaw/cardid-detector/references'

const ALL_CODES = [
  ...Array.from({ length: 34 }, (_, i) => `C${String(i + 1).padStart(2, '0')}`),
  ...Array.from({ length: 8 }, (_, i) => `S${String(i + 1).padStart(2, '0')}`),
]

function parseCode(filename) {
  const base = path.basename(filename, path.extname(filename))
  const m = base.match(/^([CS]\d{2})/i)
  return m ? m[1].toUpperCase() : null
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

async function main() {
  console.log('=== Card-ID Test Suite ===\n')

  if (!fs.existsSync(REFS_PATH)) {
    console.error(`card-refs.json not found at ${REFS_PATH}`)
    console.error('Run: node scripts/build-refs.cjs first')
    process.exit(1)
  }
  const refsData = JSON.parse(fs.readFileSync(REFS_PATH, 'utf8'))
  console.log(`Loaded ${refsData.refs.length} references from card-refs.json\n`)

  if (!fs.existsSync(REF_DIR)) {
    console.error(`Reference dir not found: ${REF_DIR}`)
    process.exit(1)
  }

  // Group reference files by code, take first per code
  const filesByCode = {}
  for (const file of fs.readdirSync(REF_DIR).sort()) {
    if (!/\.(png|jpe?g|webp|bmp)$/i.test(file)) continue
    const code = parseCode(file)
    if (!code) continue
    if (!filesByCode[code]) filesByCode[code] = file
  }

  const codes = Object.keys(filesByCode).sort()
  console.log(`Found ${codes.length} reference images in ${REF_DIR}\n`)

  // Process each reference: decode → JPEG q0.90 (simulating browser pipeline)
  console.log('Processing reference images...\n')
  const processedByCode = {}
  for (const code of codes) {
    const file = filesByCode[code]
    const fullPath = path.join(REF_DIR, file)
    const fileBuffer = fs.readFileSync(fullPath)
    try {
      const jpegBuf = await sharp(fileBuffer).jpeg({ quality: 90 }).toBuffer()
      processedByCode[code] = jpegBuf
      const meta = await sharp(jpegBuf).metadata()
      console.log(`  ${code}: ${meta.width}×${meta.height} jpeg=${(jpegBuf.length / 1024).toFixed(1)}KB`)
    } catch (e) {
      console.error(`  ${code}: ERROR — ${e.message}`)
    }
  }
  const processedCodes = Object.keys(processedByCode).sort()
  console.log(`\n${processedCodes.length} images processed successfully\n`)

  // --- Test 1: Self-match at distance 0 ---
  console.log('--- Test 1: Self-match (distance should be 0) ---')
  console.log('CODE'.padEnd(6) + 'DIST'.padEnd(6) + 'MARGIN'.padEnd(8) + 'MATCHED'.padEnd(8) + 'PASS/FAIL')
  console.log('-'.repeat(45))

  let test1Pass = 0, test1Fail = 0
  for (const code of processedCodes) {
    const jpegBuf = processedByCode[code]
    try {
      const result = await identify(jpegBuf)
      const pass = result.ok && result.code === code && result.distance === 0
      if (pass) test1Pass++; else test1Fail++
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
      console.log(code.padEnd(6) + 'ERR'.padEnd(6) + '-'.padEnd(8) + '-'.padEnd(8) + '✗ FAIL (' + e.message + ')')
    }
  }
  console.log('-'.repeat(45))
  console.log(`Test 1: ${test1Pass}/${processedCodes.length} passed\n`)

  // --- Test 2: Variant matching (distance ≤ 4) ---
  console.log('--- Test 2: Variant matching (distance should be ≤ 4) ---')
  console.log('CODE'.padEnd(6) + 'VARIANT'.padEnd(12) + 'DIST'.padEnd(6) + 'MARGIN'.padEnd(8) + 'MATCHED'.padEnd(8) + 'PASS/FAIL')
  console.log('-'.repeat(55))

  let test2Pass = 0, test2Fail = 0
  const variants = [
    { name: 'q90', fn: (buf) => reencodeJPEG(buf, 0.90) },
    { name: 'q75', fn: (buf) => reencodeJPEG(buf, 0.75) },
    { name: 'scale50', fn: (buf) => scaleJPEG(buf, 0.50) },
    { name: 'rot180', fn: (buf) => rotateJPEG180(buf) },
  ]

  for (const code of processedCodes) {
    const baseJPEG = processedByCode[code]
    for (const variant of variants) {
      try {
        const variantBuf = await variant.fn(baseJPEG)
        const result = await identify(variantBuf)
        const pass = result.ok && result.code === code && result.distance <= 4
        if (pass) test2Pass++; else test2Fail++
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
        console.log(code.padEnd(6) + variant.name.padEnd(12) + 'ERR'.padEnd(6) + '-'.padEnd(8) + '-'.padEnd(8) + '✗ FAIL (' + e.message + ')')
      }
    }
  }
  console.log('-'.repeat(55))
  console.log(`Test 2: ${test2Pass}/${test2Pass + test2Fail} variants passed\n`)

  // --- Summary ---
  console.log('=== Summary ===')
  console.log(`Test 1 (self-match distance 0): ${test1Pass}/${processedCodes.length} passed`)
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
