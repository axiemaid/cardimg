#!/usr/bin/env node
/**
 * compare-detectors.cjs — Run browser pipeline and server (cardid-detector)
 * on the same test images, print results side by side.
 * 
 * Browser: sharp decode → card-crop → card-matcher (pHash + hist)
 * Server:  cardid-detector matchCard() → OpenCV crop + pHash + hist + SSIM
 * 
 * Usage: node compare-detectors.cjs [--test-dir <path>]
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  normalizeImage,
  matchAgainstRefs,
  hexToHash,
} = require('../lib/card-matcher.js');
const { cropCardFromRGBA } = require('../lib/card-crop.js');

const TEST_DIR = '/Users/axiemaid/.openclaw/cardid-detector/test-images';
const REFS_PATH = path.join(__dirname, '..', 'public', 'card-refs.json');

function loadBrowserRefs() {
  const data = JSON.parse(fs.readFileSync(REFS_PATH, 'utf8'));
  return data.refs.map(r => ({
    code: r.code,
    hash: hexToHash(r.hash),
    hist: Float64Array.from(r.hist),
  }));
}

// Run browser pipeline in-process (uses sharp for decode only)
async function browserMatch(filePath, refs) {
  const sharp = require('sharp');
  const { data, info } = await sharp(filePath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const rgba = new Uint8Array(data);
  
  // Apply browser crop
  const cropped = cropCardFromRGBA(rgba, info.width, info.height);
  let cropRGBA = rgba, cropW = info.width, cropH = info.height;
  if (cropped) {
    cropRGBA = cropped.rgba;
    cropW = cropped.w;
    cropH = cropped.h;
  }
  
  const norm = normalizeImage(cropRGBA, cropW, cropH);
  return matchAgainstRefs(norm, refs);
}

// Run server pipeline in a separate process to avoid sharp/OpenCV conflict
function serverMatch(filePath) {
  const result = spawnSync('node', ['-e', `
    const { matchCard } = require('${path.join('/Users/axiemaid/.openclaw/cardid-detector', 'lib', 'match.js')}');
    const refDir = '/Users/axiemaid/.openclaw/cardid-detector/references';
    matchCard('${filePath}', refDir).then(result => {
      const matches = result.results || [];
      if (matches.length === 0) {
        process.stdout.write(JSON.stringify({ ok: false }));
        return;
      }
      const byH = [...matches].sort((a, b) => a.hamming - b.hamming);
      const best = byH[0];
      const ru = byH[1];
      process.stdout.write(JSON.stringify({
        ok: true,
        code: best.code,
        distance: best.hamming,
        margin: ru ? ru.hamming - best.hamming : 0,
        hist: best.hist,
        score: best.score,
      }));
    }).catch(e => {
      process.stdout.write(JSON.stringify({ ok: false, error: e.message }));
    });
  `], { encoding: 'utf8', timeout: 30000 });
  
  if (result.error || result.status !== 0) {
    return { ok: false, error: result.error?.message || `exit ${result.status}` };
  }
  try {
    return JSON.parse(result.stdout.trim());
  } catch (e) {
    return { ok: false, error: 'parse error: ' + result.stdout.slice(0, 200) };
  }
}

async function main() {
  const refs = loadBrowserRefs();
  console.log(`Loaded ${refs.length} browser references\n`);

  const testFiles = fs.readdirSync(TEST_DIR)
    .filter(f => /\.(png|jpe?g|webp|bmp)$/i.test(f))
    .sort();

  console.log('IMAGE'.padEnd(35) + ' | BROWSER'.padEnd(40) + ' | SERVER'.padEnd(40));
  console.log(''.padEnd(35) + ' | code     dist  marg  hist   score | code     dist  marg  hist   score');
  console.log('-'.repeat(120));

  for (const file of testFiles) {
    const fullPath = path.join(TEST_DIR, file);

    // Browser
    let b = { ok: false };
    try {
      b = await browserMatch(fullPath, refs);
    } catch (e) {
      b = { ok: false, error: e.message };
    }

    // Server (separate process)
    const s = serverMatch(fullPath);

    const fmt = (r) => {
      if (!r.ok) return `${'ERROR'.padEnd(8)} ${'-'.padEnd(5)} ${'-'.padEnd(5)} ${'-'.padEnd(6)} ${'-'}`;
      return `${(r.code || '-').padEnd(8)} ${String(r.distance).padEnd(5)} ${String(r.margin).padEnd(5)} ${(r.hist || 0).toFixed(3).padEnd(6)} ${(r.score || 0).toFixed(3)}`;
    };

    const bStr = b.error ? `error: ${b.error.slice(0, 30)}` : fmt(b);
    const sStr = s.error ? `error: ${s.error.slice(0, 30)}` : fmt(s);

    console.log(`${file.padEnd(35)} | ${bStr.padEnd(40)} | ${sStr.padEnd(40)}`);
  }

  console.log('-'.repeat(120));
  console.log('\nNotes:');
  console.log('  Browser: card-crop.js + card-matcher.js (pHash + histogram, no SSIM)');
  console.log('  Server:  cardid-detector (OpenCV crop + pHash + histogram + SSIM)');
  console.log('  dist = Hamming distance (lower=better, 0=identical)');
  console.log('  marg  = runner-up distance - best distance (higher=more confident)');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
