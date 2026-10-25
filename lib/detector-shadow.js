/**
 * Detector Shadow — wraps cardid-detector for parallel evaluation.
 *
 * Modes:
 *   off    — not loaded, no endpoints active
 *   shadow — runs alongside front-match, logs both results, no gate
 *   enforce— detector gates uploads (requires all 42 references)
 *
 * Does NOT modify front-match.js or HBValidator. Runs in parallel.
 * Does NOT touch the back-scan validation or CARDSET binding.
 */

const fs = require('fs')
const path = require('path')

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'detector.json')
const LOG_PATH = path.join(__dirname, '..', 'detector-shadow-log.jsonl')

// All 42 expected card codes
const ALL_CODES = [
  ...Array.from({ length: 34 }, (_, i) => `C${String(i + 1).padStart(2, '0')}`),
  ...Array.from({ length: 8 }, (_, i) => `S${String(i + 1).padStart(2, '0')}`),
]

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
  } catch {
    return { mode: 'off' }
  }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n')
}

// Check which card codes have reference images
function checkReferences(referenceDir) {
  const present = new Set()
  const missing = []

  if (!fs.existsSync(referenceDir)) {
    return { present: [], missing: ALL_CODES, total: 0, expected: 42 }
  }

  const files = fs.readdirSync(referenceDir)
  for (const f of files) {
    // Accept C01.png, C01_2.png, etc. — extract base code
    const m = f.match(/^([CS]\d{2})/i)
    if (m) present.add(m[1].toUpperCase())
  }

  for (const code of ALL_CODES) {
    if (!present.has(code)) missing.push(code)
  }

  return {
    present: [...present].sort(),
    missing: missing.sort(),
    total: present.size,
    expected: 42,
    complete: missing.length === 0,
  }
}

// Lazy-load the detector
let _matchCard = null
function getMatchCard(detectorPath) {
  if (_matchCard) return _matchCard
  const p = path.join(detectorPath, 'lib', 'match.js')
  if (!fs.existsSync(p)) throw new Error(`Detector not found at ${p}`)
  _matchCard = require(p).matchCard
  return _matchCard
}

// Run the detector on an image buffer
async function runDetector(imageBuffer, cfg) {
  const matchCard = getMatchCard(cfg.detectorPath)
  // matchCard expects a file path, not a buffer. Write to temp.
  const tmpPath = path.join(require('os').tmpdir(), `det-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`)
  fs.writeFileSync(tmpPath, imageBuffer)
  try {
    const result = await matchCard(tmpPath, cfg.referenceDir)
    const matches = result.results || []

    if (matches.length === 0) {
      return { ok: false, reason: 'no_match', code: null, distance: null, margin: null }
    }

    // Sort by hamming distance
    const byHamming = [...matches].sort((a, b) => a.hamming - b.hamming)
    const closest = byHamming[0]
    const runnerUp = byHamming[1]
    const distance = closest.hamming
    const margin = runnerUp ? runnerUp.hamming - closest.hamming : closest.hamming

    return {
      ok: true,
      code: closest.code,
      distance,
      margin,
      runnerUp: runnerUp ? { code: runnerUp.code, distance: runnerUp.hamming } : null,
      top5: byHamming.slice(0, 5).map(m => ({ code: m.code, hamming: m.hamming, score: m.score })),
    }
  } finally {
    try { fs.unlinkSync(tmpPath) } catch {}
  }
}

// Log a comparison entry
function logComparison(entry) {
  fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n')
}

// Read the full comparison log
function readLog() {
  try {
    return fs.readFileSync(LOG_PATH, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
  } catch {
    return []
  }
}

// Generate agreement report
function generateReport() {
  const entries = readLog()
  const report = {
    total: entries.length,
    agree: 0,
    disagree: 0,
    frontMatchOnly: 0,
    detectorOnly: 0,
    bothPass: 0,
    bothFail: 0,
    details: [],
  }

  for (const e of entries) {
    const fm = e.frontMatch || {}
    const det = e.detector || {}

    const fmCode = fm.code || null
    const detCode = det.code || null
    const fmPass = fm.matched !== false
    const detPass = det.ok !== false

    const item = {
      filename: e.filename,
      timestamp: e.timestamp,
      frontMatch: { code: fmCode, mae: fm.mae, matched: fm.matched },
      detector: { code: detCode, distance: det.distance, margin: det.margin, ok: det.ok },
      agree: fmCode === detCode,
    }
    report.details.push(item)

    if (fmCode && detCode && fmCode === detCode) report.agree++
    else if (fmCode && detCode && fmCode !== detCode) report.disagree++
    else if (fmCode && !detCode) report.frontMatchOnly++
    else if (!fmCode && detCode) report.detectorOnly++

    if (fmPass && detPass) report.bothPass++
    else if (!fmPass && !detPass) report.bothFail++
  }

  return report
}

module.exports = {
  ALL_CODES,
  loadConfig,
  saveConfig,
  checkReferences,
  runDetector,
  logComparison,
  readLog,
  generateReport,
}
