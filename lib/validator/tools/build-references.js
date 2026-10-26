#!/usr/bin/env node
/**
 * build-references.js — offline reference set generator.
 * 
 * Reads the 42 front reference images + back card images,
 * runs them through the same normalize + feature pipeline,
 * and outputs references.json.
 * 
 * Usage:
 *   node tools/build-references.js [--fronts <dir>] [--backs <dir...>] [--out <path>]
 * 
 * Defaults:
 *   --fronts  ~/.openclaw/hyperbattle/first-stage/images
 *   --backs   ~/.openclaw/cardimg/resources/back-of-card-images
 *   --out     ~/.openclaw/cardimg/lib/validator/references.json
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

// We need sharp for Node-side image decode
let sharp
try { sharp = require('sharp') } catch {
  console.error('sharp is required: npm install sharp')
  process.exit(1)
}

// Import validator modules
const VAL_DIR = path.join(__dirname, '..')
const { normalize } = require(path.join(VAL_DIR, 'normalize.js'))
const { computeFeatures } = require(path.join(VAL_DIR, 'identify.js'))
const { hashToHex } = require(path.join(VAL_DIR, 'hash.js'))
const { sha256 } = require(path.join(VAL_DIR, 'record.js'))

const CANONICAL_W = 256
const CANONICAL_H = 358

// --- Helpers ---

async function decodePng(filePath) {
  const buf = fs.readFileSync(filePath)
  const { data, info } = await sharp(buf)
    .removeAlpha()
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  return { data: new Uint8Array(data), w: info.width, h: info.height }
}

function featuresToRef(features, id, name, number) {
  return {
    id,
    name,
    number,
    artGroup: null,
    h_full: hashToHex(features.h_full),
    h_art: hashToHex(features.h_art),
    h_art_q: features.h_art_q.map(q => hashToHex(q)),
    h_id: hashToHex(features.h_id),
    hist: Array.from(features.hist),
  }
}

// --- Main ---

async function main() {
  const args = process.argv.slice(2)
  
  // Parse args
  const getArg = (name) => {
    const idx = args.indexOf(name)
    return idx >= 0 ? args[idx + 1] : null
  }
  
  const home = process.env.HOME || '/root'
  const frontsDir = getArg('--fronts') || path.join(home, '.openclaw', 'hyperbattle', 'first-stage', 'images')
  const backsDirArg = getArg('--backs')
  const outPath = getArg('--out') || path.join(VAL_DIR, 'references.json')
  
  // Collect back image dirs (can be multiple)
  const backDirs = []
  if (backsDirArg) {
    backDirs.push(backsDirArg)
    // Also check for additional --backs args
  } else {
    const defaultBackDir = path.join(home, '.openclaw', 'cardimg', 'resources', 'back-of-card-images')
    if (fs.existsSync(defaultBackDir)) {
      backDirs.push(defaultBackDir)
    }
  }
  
  console.log('Building reference set...')
  console.log('  Fronts dir:', frontsDir)
  console.log('  Back dirs:', backDirs)
  console.log('  Output:', outPath)
  
  // --- Process fronts ---
  const frontFiles = fs.readdirSync(frontsDir)
    .filter(f => f.match(/^[c-z]\d+\.png$/i))
    .sort()
  
  console.log(`\nProcessing ${frontFiles.length} front images...`)
  
  const cards = []
  for (const file of frontFiles) {
    const code = path.basename(file, '.png').toUpperCase()
    const filePath = path.join(frontsDir, file)
    
    console.log(`  ${code}...`, end='')
    const { data, w, h } = await decodePng(filePath)
    const norm = normalize(data, w, h, { tryCrop: true })
    const features = computeFeatures(norm.rgb, CANONICAL_W, CANONICAL_H)
    cards.push(featuresToRef(features, code, code, code))
    console.log(` ${w}×${h} → ${CANONICAL_W}×${CANONICAL_H}`)
  }
  
  // --- Process back ---
  console.log('\nProcessing back images...')
  const backFiles = []
  for (const dir of backDirs) {
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        if (f.match(/\.(png|jpe?g|webp)$/i)) {
          backFiles.push(path.join(dir, f))
        }
      }
    }
  }
  
  if (backFiles.length === 0) {
    console.error('No back images found!')
    process.exit(1)
  }
  
  // Process all back images, pick the one with median features (most representative)
  const backFeaturesList = []
  for (const filePath of backFiles) {
    const fileName = path.basename(filePath)
    console.log(`  ${fileName}...`, end='')
    const { data, w, h } = await decodePng(filePath)
    const norm = normalize(data, w, h, { tryCrop: true })
    const features = computeFeatures(norm.rgb, CANONICAL_W, CANONICAL_H)
    backFeaturesList.push({ features, file: fileName, w, h })
    console.log(` ${w}×${h} → ${CANONICAL_W}×${CANONICAL_H} (cropped: ${norm.cropped})`)
  }
  
  // Pick median back: compute pairwise Hamming distances, pick the one closest to all others
  let bestIdx = 0
  let bestTotalDist = Infinity
  const { hammingDistance } = require(path.join(VAL_DIR, 'hash.js'))
  
  if (backFeaturesList.length > 1) {
    for (let i = 0; i < backFeaturesList.length; i++) {
      let total = 0
      for (let j = 0; j < backFeaturesList.length; j++) {
        if (i === j) continue
        total += hammingDistance(backFeaturesList[i].features.h_full, backFeaturesList[j].features.h_full)
      }
      if (total < bestTotalDist) {
        bestTotalDist = total
        bestIdx = i
      }
    }
  }
  
  const chosen = backFeaturesList[bestIdx]
  console.log(`\nSelected back: ${chosen.file} (total Hamming to others: ${bestTotalDist})`)
  
  const backRef = {
    h_full: hashToHex(chosen.features.h_full),
    h_art: hashToHex(chosen.features.h_art),
    h_art_q: chosen.features.h_art_q.map(q => hashToHex(q)),
    h_id: hashToHex(chosen.features.h_id),
    hist: Array.from(chosen.features.hist),
  }
  
  // --- Build references.json ---
  const refs = {
    schema: 'hb-refs/1',
    version: '1.0.0',
    canonical: { w: CANONICAL_W, h: CANONICAL_H },
    regions: {
      art: [0.07, 0.10, 0.93, 0.60],
      id:  [0.05, 0.92, 0.35, 0.98],
    },
    back: backRef,
    cards,
    thresholds: {
      BACK_HASH_MAX: 40,
      BACK_HIST_MIN: 0.80,
      FRONT_MAX_DIST: 0.25,
      FRONT_MARGIN: 0.70,
    },
  }
  
  // Compute refSetHash
  const refsJson = JSON.stringify(refs, null, 2)
  refs.refSetHash = crypto.createHash('sha256').update(refsJson).digest('hex')
  
  // Re-serialize with refSetHash included
  const finalJson = JSON.stringify(refs, null, 2)
  fs.writeFileSync(outPath, finalJson)
  
  console.log(`\n✓ Written ${outPath}`)
  console.log(`  ${cards.length} front references + 1 back reference`)
  console.log(`  refSetHash: ${refs.refSetHash}`)
  console.log(`  Size: ${(Buffer.byteLength(finalJson) / 1024).toFixed(1)} KB`)
}

main().catch(err => {
  console.error('Error:', err)
  process.exit(1)
})
