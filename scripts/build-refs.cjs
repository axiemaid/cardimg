#!/usr/bin/env node
/**
 * build-refs.cjs — Build card-refs.json from reference images
 * 
 * For each file in cardid-detector/references/ named C## or S## (optionally _n):
 *   1. Read file into buffer
 *   2. Decode with sharp → area-average resize to 32×32 grayscale → DCT pHash (64-bit)
 *   3. Write { code, hash (hex) } to card-refs.json
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

const {
  areaAverageResizeToGray,
  computePhash,
  hashToHex,
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
    const fileBuffer = fs.readFileSync(fullPath)

    try {
      const { data, info } = await sharp(fileBuffer)
        .removeAlpha()
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true })

      // Area-average resize to 32×32 grayscale → DCT pHash
      const gray32 = areaAverageResizeToGray(new Uint8Array(data), info.width, info.height, PHASH_SIZE, PHASH_SIZE)
      const hash = computePhash(gray32)

      refs.push({ code, hash: hashToHex(hash) })
      console.log(`  ${code}: ${info.width}×${info.height} hash=${hashToHex(hash)}`)
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
