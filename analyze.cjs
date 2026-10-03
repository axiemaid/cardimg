#!/usr/bin/env node
/**
 * CARDIMG Analyzer
 * 
 * Extracts Card ID (OCR) + Centering from card images.
 * Used for matching scanned cards against uploaded cards.
 * 
 * Usage:
 *   node analyze.cjs <image_path>
 *   node analyze.cjs --hash <sha256_hash>  (analyze uploaded card)
 */

const fs = require('fs')
const path = require('path')
const sharp = require('sharp')
const Tesseract = require('tesseract.js')

const IMAGES_DIR = path.join(__dirname, 'images')
const META_PATH = path.join(__dirname, 'cards-meta.json')

// Load metadata index
function loadMeta() {
  if (fs.existsSync(META_PATH)) {
    return JSON.parse(fs.readFileSync(META_PATH, 'utf8'))
  }
  return {}
}

function saveMeta(meta) {
  fs.writeFileSync(META_PATH, JSON.stringify(meta, null, 2))
}

/**
 * Extract Card ID via OCR
 * Hyper Battle cards: Card ID usually at bottom (e.g., "OP05-119")
 */
async function extractCardId(imageBuf) {
  // Focus on bottom region of card (where card ID typically is)
  const metadata = await sharp(imageBuf).metadata()
  const height = metadata.height
  const width = metadata.width
  
  // Extract bottom 15% of card for OCR
  const bottomRegion = await sharp(imageBuf)
    .extract({ left: 0, top: Math.floor(height * 0.85), width: width, height: Math.floor(height * 0.15) })
    .grayscale()
    .threshold(128) // Binarize for better OCR
    .toBuffer()
  
  // OCR
  const result = await Tesseract.recognize(bottomRegion, 'eng', {
    tessedit_char_whitelist: 'OP0123456789-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
  })
  
  const text = result.data.text.trim()
  
  // Find card ID pattern: OP05-119, OP-119, etc.
  const patterns = [
    /OP\d{2}-\d{3}/i,      // OP05-119
    /OP\d{2}\d{3}/i,       // OP05119 (no dash)
    /OP-\d{3}/i,           // OP-119
    /\d{2}-\d{3}/          // 05-119 (missing OP)
  ]
  
  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (match) {
      // Normalize to OP05-119 format
      let cardId = match[0].toUpperCase()
      if (!cardId.startsWith('OP')) cardId = 'OP' + cardId
      if (!cardId.includes('-') && cardId.length > 5) {
        cardId = 'OP' + cardId.slice(2, 4) + '-' + cardId.slice(4)
      }
      return cardId
    }
  }
  
  // Fallback: try full image OCR
  const fullResult = await Tesseract.recognize(imageBuf, 'eng')
  const fullText = fullResult.data.text.trim()
  
  for (const pattern of patterns) {
    const match = fullText.match(pattern)
    if (match) {
      let cardId = match[0].toUpperCase()
      if (!cardId.startsWith('OP')) cardId = 'OP' + cardId
      return cardId
    }
  }
  
  return null // Could not extract Card ID
}

/**
 * Calculate Centering
 * Measure border widths (top/bottom/left/right) relative to card dimensions
 * 
 * Centering = how centered the artwork is within the card borders
 * Perfect centering: top=bottom, left=right
 * 
 * For Hyper Battle cards: detect color/brightness boundary, not white border
 */
async function calculateCentering(imageBuf) {
  const metadata = await sharp(imageBuf).metadata()
  const { width, height } = metadata
  
  // Get raw pixel data for analysis
  const { data, info } = await sharp(imageBuf)
    .raw()
    .toBuffer({ resolveWithObject: true })
  
  const pixels = data
  const channels = info.channels
  
  // Calculate brightness for a pixel
  const getBrightness = (idx) => (pixels[idx] + pixels[idx+1] + pixels[idx+2]) / 3
  
  // Detect edge color (sample corner)
  const cornerIdx = 0 // top-left corner
  const edgeBrightness = getBrightness(cornerIdx)
  const artworkThreshold = edgeBrightness * 0.6 // Artwork is darker than edge
  
  // Find borders by detecting brightness transition from edge to artwork
  
  // Find left border (scan from left edge inward)
  let leftBorder = 0
  for (let x = 0; x < width * 0.2; x++) {
    // Sample vertical line
    let avgBrightness = 0
    for (let y = Math.floor(height * 0.3); y < height * 0.7; y += 5) {
      const idx = (y * width + x) * channels
      avgBrightness += getBrightness(idx)
    }
    avgBrightness /= Math.floor(height * 0.4 / 5)
    
    if (avgBrightness < artworkThreshold) {
      leftBorder = x
      break
    }
  }
  
  // Find right border (scan from right edge inward)
  let rightBorder = 0
  for (let x = width - 1; x > width * 0.8; x--) {
    let avgBrightness = 0
    for (let y = Math.floor(height * 0.3); y < height * 0.7; y += 5) {
      const idx = (y * width + x) * channels
      avgBrightness += getBrightness(idx)
    }
    avgBrightness /= Math.floor(height * 0.4 / 5)
    
    if (avgBrightness < artworkThreshold) {
      rightBorder = width - x - 1
      break
    }
  }
  
  // Find top border (scan from top edge downward)
  let topBorder = 0
  for (let y = 0; y < height * 0.15; y++) {
    let avgBrightness = 0
    for (let x = Math.floor(width * 0.3); x < width * 0.7; x += 5) {
      const idx = (y * width + x) * channels
      avgBrightness += getBrightness(idx)
    }
    avgBrightness /= Math.floor(width * 0.4 / 5)
    
    if (avgBrightness < artworkThreshold) {
      topBorder = y
      break
    }
  }
  
  // Find bottom border (scan from bottom edge upward)
  let bottomBorder = 0
  for (let y = height - 1; y > height * 0.85; y--) {
    let avgBrightness = 0
    for (let x = Math.floor(width * 0.3); x < width * 0.7; x += 5) {
      const idx = (y * width + x) * channels
      avgBrightness += getBrightness(idx)
    }
    avgBrightness /= Math.floor(width * 0.4 / 5)
    
    if (avgBrightness < artworkThreshold) {
      bottomBorder = height - y - 1
      break
    }
  }
  
  // Calculate centering percentages
  // Horizontal centering: deviation from (left = right)
  const horizontalCenter = (leftBorder + rightBorder) / 2
  const horizontalDeviation = horizontalCenter > 0 
    ? Math.abs(leftBorder - rightBorder) / horizontalCenter * 100 
    : 0
  
  // Vertical centering: deviation from (top = bottom)
  const verticalCenter = (topBorder + bottomBorder) / 2
  const verticalDeviation = verticalCenter > 0 
    ? Math.abs(topBorder - bottomBorder) / verticalCenter * 100 
    : 0
  
  // Overall centering score (100 = perfect)
  const centeringScore = 100 - (horizontalDeviation + verticalDeviation) / 2
  
  return {
    borders: {
      top: topBorder,
      bottom: bottomBorder,
      left: leftBorder,
      right: rightBorder
    },
    percentages: {
      topPercent: (topBorder / height * 100).toFixed(2),
      bottomPercent: (bottomBorder / height * 100).toFixed(2),
      leftPercent: (leftBorder / width * 100).toFixed(2),
      rightPercent: (rightBorder / width * 100).toFixed(2)
    },
    deviation: {
      horizontal: horizontalDeviation.toFixed(2),
      vertical: verticalDeviation.toFixed(2)
    },
    score: Math.max(0, centeringScore).toFixed(1), // 100 = perfect centering
    summary: `Top:${topBorder}px Bottom:${bottomBorder}px Left:${leftBorder}px Right:${rightBorder}px`
  }
}

/**
 * Analyze a card image
 */
async function analyzeCard(imagePath, hash = null) {
  console.log(`Analyzing: ${imagePath}`)
  
  const imageBuf = fs.readFileSync(imagePath)
  
  // Extract Card ID
  console.log('Running OCR for Card ID...')
  const cardId = await extractCardId(imageBuf)
  console.log(`Card ID: ${cardId || 'NOT FOUND'}`)
  
  // Calculate Centering
  console.log('Calculating centering...')
  const centering = await calculateCentering(imageBuf)
  console.log(`Centering: ${centering.summary}`)
  console.log(`Score: ${centering.score}/100`)
  
  const result = {
    cardId,
    centering,
    analyzedAt: Date.now(),
    imagePath
  }
  
  if (hash) {
    result.hash = hash
  }
  
  return result
}

/**
 * Match a scan against uploaded cards
 */
async function matchCard(scanPath, meta = loadMeta()) {
  console.log('Matching scan against uploaded cards...')
  
  const scanAnalysis = await analyzeCard(scanPath)
  
  if (!scanAnalysis.cardId) {
    console.log('Could not extract Card ID from scan')
    return { match: null, reason: 'Card ID not found' }
  }
  
  // Filter by Card ID
  const candidates = Object.entries(meta)
    .filter(([hash, data]) => data.cardId === scanAnalysis.cardId)
    .map(([hash, data]) => ({ hash, ...data }))
  
  console.log(`Found ${candidates.length} candidates with Card ID ${scanAnalysis.cardId}`)
  
  if (candidates.length === 0) {
    return { match: null, reason: 'No cards with matching Card ID' }
  }
  
  // Compare centering
  const matches = candidates.map(c => {
    const hDiff = Math.abs(
      parseFloat(c.centering.deviation.horizontal) - 
      parseFloat(scanAnalysis.centering.deviation.horizontal)
    )
    const vDiff = Math.abs(
      parseFloat(c.centering.deviation.vertical) - 
      parseFloat(scanAnalysis.centering.deviation.vertical)
    )
    const totalDiff = hDiff + vDiff
    
    return {
      ...c,
      centeringDiff: totalDiff.toFixed(2),
      matchScore: (100 - totalDiff).toFixed(1)
    }
  }).sort((a, b) => parseFloat(b.matchScore) - parseFloat(a.matchScore))
  
  console.log('\nTop matches:')
  matches.slice(0, 3).forEach(m => {
    console.log(`  ${m.hash.slice(0, 16)}... - Score: ${m.matchScore}%`)
  })
  
  return {
    scan: scanAnalysis,
    matches,
    bestMatch: matches[0]
  }
}

// CLI
async function main() {
  const args = process.argv.slice(2)
  
  if (args.length === 0) {
    console.log('Usage:')
    console.log('  node analyze.cjs <image_path>')
    console.log('  node analyze.cjs --hash <hash>')
    console.log('  node analyze.cjs --match <scan_path>')
    process.exit(1)
  }
  
  const matchMode = args.includes('--match')
  const hashMode = args.includes('--hash')
  
  if (matchMode) {
    const scanPath = args[args.indexOf('--match') + 1]
    const result = await matchCard(scanPath)
    console.log('\n=== MATCH RESULT ===')
    console.log(JSON.stringify(result, null, 2))
    return
  }
  
  if (hashMode) {
    const hash = args[args.indexOf('--hash') + 1]
    const imgPath = path.join(IMAGES_DIR, `${hash}.bin`)
    if (!fs.existsSync(imgPath)) {
      console.error('Image not found for hash:', hash)
      process.exit(1)
    }
    const result = await analyzeCard(imgPath, hash)
    
    // Save to metadata
    const meta = loadMeta()
    meta[hash] = result
    saveMeta(meta)
    console.log('\nSaved to cards-meta.json')
    return
  }
  
  // Analyze local file
  const imagePath = args[0]
  const result = await analyzeCard(imagePath)
  console.log('\n=== ANALYSIS RESULT ===')
  console.log(JSON.stringify(result, null, 2))
}

main().catch(e => {
  console.error('Error:', e.message)
  process.exit(1)
})