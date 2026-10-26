#!/usr/bin/env node
/**
 * build-refs.cjs — Build card-refs.json from reference images
 * 
 * For each file in cardid-detector/references/ named C## or S## (optionally _n):
 *   1. Decode image
 *   2. Run through the browser crop pipeline (card-crop.js — same as validator.js)
 *   3. Ensure portrait orientation
 *   4. Encode to JPEG q0.90 (same as browser output)
 *   5. Area-average resize to 32×32 grayscale
 *   6. DCT pHash (64-bit)
 *   7. Write { code, hash (hex) } to card-refs.json
 * 
 * Lists skipped files and missing codes.
 * 
 * Usage: node scripts/build-refs.cjs [--ref-dir <path>] [--out <path>]
 */

const fs = require('fs')
const path = require('path')

let sharp
try { sharp = require('sharp') } catch {
  console.error('sharp is required: npm install sharp')
  process.exit(1)
}

const { cropCardFromRGBA } = require('../lib/card-crop.js')
const {
  _areaAverageResizeToGray: areaAverageResizeToGray,
  _computePhash: computePhash,
  _hashToHex: hashToHex,
  PHASH_SIZE,
} = require('../lib/card-id.cjs')

const DEFAULT_REF_DIR = '/Users/axiemaid/.openclaw/cardid-detector/references'
const DEFAULT_OUT = path.join(__dirname, '..', 'card-refs.json')

const ALL_CODES = [
  ...Array.from({ length: 34 }, (_, i) => `C${String(i + 1).padStart(2, '0')}`),
  ...Array.from({ length: 8 }, (_, i) => `S${String(i + 1).padStart(2, '0')}`),
]

function parseCode(filename) {
  const ext = path.extname(filename)
  const base = path.basename(filename, ext)
  const m = base.match(/^([CS]\d{2})/i)
  return m ? m[1].toUpperCase() : null
}

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

async function processReference(filePath) {
  // Full browser pipeline: decode → crop → portrait → JPEG q90 → hash
  const { data, w, h } = await decodeToRGBA(filePath)

  // Crop using shared card-crop.js (same as validator.js)
  const cropped = cropCardFromRGBA(data, w, h)
  let cropRGBA = data
  let cropW = w
  let cropH = h
  let cropInfo = 'none'

  if (cropped) {
    cropRGBA = cropped.rgba
    cropW = cropped.w
    cropH = cropped.h
    cropInfo = cropped.crop ? 'cropped' : 'no-crop-needed'
  } else {
    cropInfo = 'no-edges-detected'
  }

  // Ensure portrait (rotate 90 CW if landscape)
  let finalRGBA = cropRGBA
  let finalW = cropW
  let finalH = cropH
  if (finalW > finalH) {
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

  // Encode to JPEG q0.90 (same as browser)
  const jpegBuf = await rgbaToJPEG(finalRGBA, finalW, finalH, 0.90)

  // Decode JPEG back to RGBA for hashing (simulates what identify() receives)
  const { data: jpegRGBA, info: jpegInfo } = await sharp(jpegBuf)
    .removeAlpha()
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  // Area-average resize to 32×32 grayscale
  const gray32 = areaAverageResizeToGray(new Uint8Array(jpegRGBA), jpegInfo.width, jpegInfo.height, PHASH_SIZE, PHASH_SIZE)

  // DCT pHash
  const hash = computePhash(gray32)

  return {
    hash: hashToHex(hash),
    cropInfo,
    dimensions: `${jpegInfo.width}×${jpegInfo.height}`,
    jpegSize: jpegBuf.length,
  }
}

async function main() {
  const args = process.argv.slice(2)
  const refDirIdx = args.indexOf('--ref-dir')
  const refDir = refDirIdx >= 0 ? args[refDirIdx + 1] : DEFAULT_REF_DIR
  const outIdx = args.indexOf('--out')
  const outPath = outIdx >= 0 ? args[outIdx + 1] : DEFAULT_OUT

  if (!fs.existsSync(refDir)) {
    console.error(`Reference dir not found: ${refDir}`)
    process.exit(1)
  }

  // Group files by code — take first file per code
  const filesByCode = {}
  const skipped = []
  for (const file of fs.readdirSync(refDir).sort()) {
    if (!/\.(png|jpe?g|webp|bmp)$/i.test(file)) {
      skipped.push({ file, reason: 'not_an_image' })
      continue
    }
    const code = parseCode(file)
    if (!code) {
      skipped.push({ file, reason: 'cannot_parse_code' })
      continue
    }
    // Only take first file per code (ignore _n variants for reference building)
    if (!filesByCode[code]) {
      filesByCode[code] = file
    } else {
      skipped.push({ file, reason: `duplicate_of_${code}` })
    }
  }

  const presentCodes = Object.keys(filesByCode).sort()
  const missingCodes = ALL_CODES.filter(c => !filesByCode[c])

  console.log(`Reference dir: ${refDir}`)
  console.log(`Found ${presentCodes.length}/${ALL_CODES.length} codes: ${presentCodes.join(', ')}`)
  if (missingCodes.length > 0) {
    console.log(`Missing ${missingCodes.length}: ${missingCodes.join(', ')}`)
  }
  if (skipped.length > 0) {
    console.log(`\nSkipped files:`)
    for (const s of skipped) {
      console.log(`  ${s.file} — ${s.reason}`)
    }
  }
  console.log('')

  if (presentCodes.length === 0) {
    console.error('No reference images found. Aborting.')
    process.exit(1)
  }

  const refs = []

  for (const code of presentCodes) {
    const file = filesByCode[code]
    const fullPath = path.join(refDir, file)

    try {
      const result = await processReference(fullPath)
      refs.push({ code, hash: result.hash })
      console.log(`  ${code}: ${result.dimensions} crop=${result.cropInfo} jpeg=${(result.jpegSize / 1024).toFixed(1)}KB hash=${result.hash}`)
    } catch (e) {
      console.error(`  ${code}: ERROR — ${e.message}`)
    }
  }

  const output = {
    version: 3,
    generated: new Date().toISOString(),
    totalCodes: ALL_CODES.length,
    indexedCodes: refs.length,
    missingCodes,
    refs,
  }

  fs.writeFileSync(outPath, JSON.stringify(output, null, 2))
  const sizeKB = (fs.statSync(outPath).size / 1024).toFixed(1)
  console.log(`\nWrote ${refs.length} references to ${outPath} (${sizeKB} KB)`)
  if (missingCodes.length > 0) {
    console.log(`Missing ${missingCodes.length} codes — matching will only work for indexed cards.`)
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
