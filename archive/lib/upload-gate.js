/**
 * upload-gate.js — Server-side card verification gate for /upload-all
 * 
 * Uses the same pure-JS pipeline as the browser (card-crop.js + card-matcher.js)
 * to verify every uploaded image:
 *   1. Decode image to RGBA (via sharp, decode only)
 *   2. Detect card edges + crop (card-crop.js — same as validator.js)
 *   3. Compute pHash + histogram (card-matcher.js)
 *   4. Match against reference data (card-refs.json)
 *   5. Apply distance/margin thresholds
 * 
 * Fails closed: rejects if no card detected, distance too high,
 * margin too low, or any error/timeout.
 * 
 * Logs every verdict to upload-verdicts.jsonl
 */

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'upload-gate.json');
const VERDICT_LOG = path.join(__dirname, '..', 'upload-verdicts.jsonl');
const REFS_PATH = path.join(__dirname, '..', 'public', 'card-refs.json');

// Lazy-load sharp (shared with api.cjs)
let _sharp = null;
function getSharp() {
  if (_sharp) return _sharp;
  _sharp = require('sharp');
  return _sharp;
}

// Lazy-load the matcher modules
let _matcher = null;
let _crop = null;
function getMatcher() {
  if (!_matcher) _matcher = require('./card-matcher.js');
  return _matcher;
}
function getCrop() {
  if (!_crop) _crop = require('./card-crop.js');
  return _crop;
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return { maxDistance: 6, minMargin: 6, detectorTimeoutMs: 10000 };
  }
}

// Load + deserialize references
let _refs = null;
let _refsLoadedAt = 0;
function loadRefs() {
  const stats = fs.statSync(REFS_PATH);
  if (_refs && _refsLoadedAt === stats.mtimeMs) return _refs;
  
  const data = JSON.parse(fs.readFileSync(REFS_PATH, 'utf8'));
  const { deserializeRef } = getMatcher();
  _refs = data.refs
    .filter(r => r.code.match(/^([CS]\d{2})$/))
    .map(deserializeRef);
  _refsLoadedAt = stats.mtimeMs;
  return _refs;
}

// Log a verdict entry
function logVerdict(fields) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...fields });
  fs.appendFileSync(VERDICT_LOG, line + '\n');
}

// Read all verdicts (for reporting)
function readVerdicts() {
  try {
    return fs.readFileSync(VERDICT_LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  } catch {
    return [];
  }
}

/**
 * Verify a single image buffer.
 * Returns { passed, code, distance, margin, reason }
 */
async function verifyImage(imageBuffer, filename) {
  const cfg = loadConfig();
  const sharp = getSharp();
  const { normalizeImage, matchAgainstRefs } = getMatcher();
  const { cropCardFromRGBA } = getCrop();
  const refs = loadRefs();

  const start = Date.now();
  const elapsed = () => `${Date.now() - start}ms`;

  // 1. Decode image
  let rgba, w, h;
  try {
    const { data, info } = await sharp(imageBuffer)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    rgba = new Uint8Array(data);
    w = info.width;
    h = info.height;
  } catch (e) {
    const verdict = { passed: false, code: null, distance: null, margin: null, reason: `decode_failed: ${e.message}`, elapsed: elapsed() };
    logVerdict({ filename, ...verdict });
    return verdict;
  }

  // Check timeout
  if (Date.now() - start > cfg.detectorTimeoutMs) {
    const verdict = { passed: false, code: null, distance: null, margin: null, reason: 'timeout_decode', elapsed: elapsed() };
    logVerdict({ filename, ...verdict });
    return verdict;
  }

  // 2. Detect card edges + crop
  const cropped = cropCardFromRGBA(rgba, w, h);
  if (!cropped) {
    const verdict = { passed: false, code: null, distance: null, margin: null, reason: 'no_card_detected', elapsed: elapsed() };
    logVerdict({ filename, ...verdict });
    return verdict;
  }

  let cropRGBA = cropped.rgba;
  let cropW = cropped.w;
  let cropH = cropped.h;

  // Check timeout
  if (Date.now() - start > cfg.detectorTimeoutMs) {
    const verdict = { passed: false, code: null, distance: null, margin: null, reason: 'timeout_crop', elapsed: elapsed() };
    logVerdict({ filename, ...verdict });
    return verdict;
  }

  // 3. Normalize + match
  let result;
  try {
    const norm = normalizeImage(cropRGBA, cropW, cropH);
    result = matchAgainstRefs(norm, refs);
  } catch (e) {
    const verdict = { passed: false, code: null, distance: null, margin: null, reason: `matcher_error: ${e.message}`, elapsed: elapsed() };
    logVerdict({ filename, ...verdict });
    return verdict;
  }

  // Check timeout
  if (Date.now() - start > cfg.detectorTimeoutMs) {
    const verdict = { passed: false, code: null, distance: null, margin: null, reason: 'timeout_match', elapsed: elapsed() };
    logVerdict({ filename, ...verdict });
    return verdict;
  }

  // 4. Apply thresholds
  const { code, distance, margin } = result;

  let reason = null;
  if (distance > cfg.maxDistance) {
    reason = `distance_${distance}_exceeds_${cfg.maxDistance}`;
  } else if (margin < cfg.minMargin) {
    reason = `margin_${margin}_below_${cfg.minMargin}`;
  }

  const verdict = {
    passed: reason === null,
    code,
    distance,
    margin,
    reason: reason || 'pass',
    elapsed: elapsed(),
  };

  logVerdict({ filename, ...verdict });
  return verdict;
}

module.exports = {
  loadConfig,
  loadRefs,
  verifyImage,
  logVerdict,
  readVerdicts,
};
