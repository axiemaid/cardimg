#!/usr/bin/env node
/**
 * gen-refs.cjs — Generate reference data for browser-side card matching
 * 
 * Reads reference images from cardid-detector/references/
 * Applies the SAME browser crop pipeline (card-crop.js) that the validator uses
 * Then hashes the cropped result with card-matcher.js (pHash + histogram)
 * 
 * Output: { code, hash (hex), hist (array) } — no SSIM, no grayThumb
 * ~25KB total for 42 cards
 * 
 * Usage: node gen-refs.cjs [--ref-dir <path>] [--out <path>]
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const {
  normalizeImage,
  serializeRef,
  STD_WIDTH,
  STD_HEIGHT,
} = require('../lib/card-matcher.js');

const { cropCardFromRGBA } = require('../lib/card-crop.js');

const DEFAULT_REF_DIR = '/Users/axiemaid/.openclaw/cardid-detector/references';
const DEFAULT_OUT = path.join(__dirname, '..', 'public', 'card-refs.json');

// All 42 expected card codes
const ALL_CODES = [
  ...Array.from({ length: 34 }, (_, i) => `C${String(i + 1).padStart(2, '0')}`),
  ...Array.from({ length: 8 }, (_, i) => `S${String(i + 1).padStart(2, '0')}`),
];

function parseCode(filename) {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  const m = base.match(/^([A-Za-z]+\d+)/);
  return m ? m[1].toUpperCase() : base.toUpperCase();
}

async function main() {
  const args = process.argv.slice(2);
  const refDirIdx = args.indexOf('--ref-dir');
  const refDir = refDirIdx >= 0 ? args[refDirIdx + 1] : DEFAULT_REF_DIR;
  const outIdx = args.indexOf('--out');
  const outPath = outIdx >= 0 ? args[outIdx + 1] : DEFAULT_OUT;

  if (!fs.existsSync(refDir)) {
    console.error(`Reference dir not found: ${refDir}`);
    process.exit(1);
  }

  // Group files by code — take first file per code
  const filesByCode = {};
  for (const file of fs.readdirSync(refDir).sort()) {
    if (!/\.(png|jpe?g|webp|bmp)$/i.test(file)) continue;
    const code = parseCode(file);
    if (!filesByCode[code]) filesByCode[code] = file;
  }

  const presentCodes = Object.keys(filesByCode).sort();
  const missingCodes = ALL_CODES.filter(c => !filesByCode[c]);

  console.log(`Reference dir: ${refDir}`);
  console.log(`Found ${presentCodes.length}/${ALL_CODES.length} codes: ${presentCodes.join(', ')}`);
  if (missingCodes.length > 0) {
    console.log(`Missing ${missingCodes.length}: ${missingCodes.join(', ')}`);
  }
  console.log('');

  if (presentCodes.length === 0) {
    console.error('No reference images found. Aborting.');
    process.exit(1);
  }

  const refs = [];

  for (const code of presentCodes) {
    const file = filesByCode[code];
    const fullPath = path.join(refDir, file);

    // Decode to raw RGBA
    const { data, info } = await sharp(fullPath)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const rgba = new Uint8Array(data);
    const w = info.width;
    const h = info.height;

    // Apply browser crop pipeline (same as validator.js)
    const cropped = cropCardFromRGBA(rgba, w, h);
    let cropRGBA = rgba;
    let cropW = w;
    let cropH = h;
    let cropInfo = 'none';

    if (cropped) {
      cropRGBA = cropped.rgba;
      cropW = cropped.w;
      cropH = cropped.h;
      cropInfo = cropped.crop ? 'cropped' : 'no-crop-needed';
    } else {
      // No edges detected — use original (will be noisy but won't crash)
      cropInfo = 'no-edges-detected';
      console.warn(`  WARNING: ${code} — no card edges detected, using full image`);
    }

    // Normalize the cropped image (pHash + histogram)
    const norm = normalizeImage(cropRGBA, cropW, cropH);
    const serialized = serializeRef({ ...norm, code });

    refs.push(serialized);
    console.log(`  ${code}: crop=${cropInfo} ${cropW}×${cropH} hash=${serialized.hash} hist[0]=${serialized.hist[0].toFixed(6)}`);
  }

  const output = {
    version: 2,
    generated: new Date().toISOString(),
    stdWidth: STD_WIDTH,
    stdHeight: STD_HEIGHT,
    totalCodes: ALL_CODES.length,
    indexedCodes: refs.length,
    missingCodes,
    refs,
  };

  fs.writeFileSync(outPath, JSON.stringify(output));
  const sizeKB = (fs.statSync(outPath).size / 1024).toFixed(1);
  console.log(`\nWrote ${refs.length} references to ${outPath} (${sizeKB} KB)`);
  if (missingCodes.length > 0) {
    console.log(`Missing ${missingCodes.length} codes — matching will only work for indexed cards.`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
