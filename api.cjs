#!/usr/bin/env node
/**
 * CARDIMG + CARDSET Unified API + Viewer
 * 
 * Single Express server. Serves:
 *   - API endpoints for CARDIMG and CARDSET data
 *   - Static viewer HTML from public/
 *   - Image/thumbnail serving with chain fallback
 * 
 * No uploading, no indexing. Just serving.
 * 
 * Usage:
 *   node api.cjs                      # Default port 3014
 *   node api.cjs --port 3015           # Custom port
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const express = require('express')

// Upload modules — client-side processed images → BSV upload → CARDSET bind
const { uploadCardImg, getUtxos, loadWallet } = require(path.join(
  process.env.HOME || '/root', '.openclaw', 'cardimg-upload', 'lib', 'cardimg.js'
))
let bindCardImages = null
try {
  bindCardImages = require(path.join(
    process.env.HOME || '/root', '.openclaw', 'cardimg-bind', 'lib', 'cardimg-bind.js'
  )).bindCardImages
} catch (e) {
  console.warn('cardimg-bind not found — CARDSET creation disabled (single uploads only)')
}

// Card identifier — cardid-detector integration
// Card identification — new unified module
const { identify, autoRebuildIfNeeded } = require(path.join(__dirname, 'lib', 'card-id.cjs'))

// Auto-rebuild references if source files changed
autoRebuildIfNeeded()

const cardIdCfg = require(path.join(__dirname, 'config', 'card-id.json'))
console.log(`[card-id] maxDistance=${cardIdCfg.maxDistance} minMargin=${cardIdCfg.minMargin}`)

const multer = require('multer')
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB — processed JPEGs are small
})

const EXPLORER_WALLET = path.join(
  process.env.HOME || '/root', '.openclaw', 'cardimg-explorer-wallet.json'
)

const WoC_API = 'https://api.whatsonchain.com/v1/bsv/main'
const DATA_DIR = __dirname
const IMAGES_DIR = path.join(DATA_DIR, 'images')
const THUMBS_DIR = path.join(DATA_DIR, 'thumbs')
const PUBLIC_DIR = path.join(DATA_DIR, 'public')

let sharp = null
try { sharp = require('sharp') } catch {}

// --- Shared parsing (same as indexer) ---

function parsePushData(buf, offset) {
  const b = buf[offset]
  if (b <= 0x4b) return { data: buf.slice(offset + 1, offset + 1 + b), next: offset + 1 + b }
  if (b === 0x4c) { const l = buf[offset + 1]; return { data: buf.slice(offset + 2, offset + 2 + l), next: offset + 2 + l } }
  if (b === 0x4d) { const l = buf.readUInt16LE(offset + 1); return { data: buf.slice(offset + 3, offset + 3 + l), next: offset + 3 + l } }
  if (b === 0x4e) { const l = buf.readUInt32LE(offset + 1); return { data: buf.slice(offset + 5, offset + 5 + l), next: offset + 5 + l } }
  return null
}

function parseOpReturn(outputs) {
  for (const out of outputs) {
    const buf = Buffer.from(out.hex, 'hex')
    let pos = 0
    if (buf[pos] !== 0x00) continue
    pos++
    if (buf[pos] !== 0x6a) continue
    pos++
    const prefixPush = parsePushData(buf, pos)
    if (!prefixPush) continue
    const prefix = prefixPush.data.toString('ascii')
    if (prefix === 'CARDIMG') {
      const imagePush = parsePushData(buf, prefixPush.next)
      if (!imagePush) continue
      const hash = crypto.createHash('sha256').update(imagePush.data).digest('hex')
      return { protocol: 'CARDIMG', hash, image: imagePush.data, size: imagePush.data.length }
    }
    if (prefix === 'CARDSET') {
      const txids = []
      let p = prefixPush.next
      while (p < buf.length) {
        const push = parsePushData(buf, p)
        if (!push) break
        if (push.data.length === 32) txids.push(push.data.toString('hex'))
        p = push.next
      }
      if (txids.length < 2) continue
      return { protocol: 'CARDSET', txids }
    }
  }
  return null
}

function detectMime(buf) {
  if (buf[0] === 0xFF && buf[1] === 0xD8) return 'image/jpeg'
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png'
  if (buf[0] === 0x52 && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  if (buf[0] === 0x47 && buf[1] === 0x49) return 'image/gif'
  if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79) return 'video/mp4'
  return 'application/octet-stream'
}

// --- State helpers ---

function loadJSON(p, fallback) {
  if (fs.existsSync(p)) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return fallback }
  }
  return fallback
}

function loadCardimgLedger() { return loadJSON(path.join(DATA_DIR, 'ledger.json'), { cards: {}, lastBlock: 0, totalImages: 0, totalBytes: 0 }) }
function loadCardimgMempool() { return loadJSON(path.join(DATA_DIR, 'mempool.json'), { cards: {}, lastScan: 0 }) }
function loadCardsetLedger() { return loadJSON(path.join(DATA_DIR, 'cardset-ledger.json'), { sets: [], lastBlock: 0, totalSets: 0 }) }
function loadCardsetMempool() { return loadJSON(path.join(DATA_DIR, 'cardset-mempool.json'), { sets: [], lastScan: 0 }) }
function loadExclusions() { return loadJSON(path.join(DATA_DIR, 'exclusions.json'), { cardimg: [], cardset: [] }) }
function loadCardCodes() { return loadJSON(path.join(DATA_DIR, 'card-codes.json'), { mappings: {} }) }
function loadCardReference() { return loadJSON(path.join(DATA_DIR, 'card-reference.json'), []) }

function saveExclusions(excl) { fs.writeFileSync(path.join(DATA_DIR, 'exclusions.json'), JSON.stringify(excl, null, 2)) }
function saveCardCodes(data) { fs.writeFileSync(path.join(DATA_DIR, 'card-codes.json'), JSON.stringify(data, null, 2)) }
function saveCardReference(data) { fs.writeFileSync(path.join(DATA_DIR, 'card-reference.json'), JSON.stringify(data, null, 2)) }

function isExcluded(type, txid) {
  const excl = loadExclusions()
  return excl[type].includes(txid)
}

// --- Image helpers ---

async function fetchImageFromChain(txid) {
  const res = await fetch(`${WoC_API}/tx/${txid}/opreturn`)
  if (!res.ok) return null
  const outputs = await res.json()
  if (!outputs || outputs.length === 0) return null
  const parsed = parseOpReturn(outputs)
  if (!parsed || parsed.protocol !== 'CARDIMG') return null
  return parsed.image
}

async function getImageByHash(hash) {
  const imgPath = path.join(IMAGES_DIR, `${hash}.bin`)
  if (fs.existsSync(imgPath)) return fs.readFileSync(imgPath)
  return null
}

async function getImageByTxid(txid) {
  const ledger = loadCardimgLedger()
  const mempool = loadCardimgMempool()
  const card = ledger.cards[txid] || mempool.cards[txid]

  if (card && card.hash) {
    const buf = await getImageByHash(card.hash)
    if (buf) return { buf, hash: card.hash }
  }

  // Fetch from chain
  const imageBuf = await fetchImageFromChain(txid)
  if (!imageBuf) return null
  const hash = crypto.createHash('sha256').update(imageBuf).digest('hex')
  fs.mkdirSync(IMAGES_DIR, { recursive: true })
  fs.writeFileSync(path.join(IMAGES_DIR, `${hash}.bin`), imageBuf)
  return { buf: imageBuf, hash }
}

function getTxidForHash(hash) {
  const ledger = loadCardimgLedger()
  const mempool = loadCardimgMempool()
  const all = { ...mempool.cards, ...ledger.cards }
  for (const [txid, meta] of Object.entries(all)) {
    if (meta.hash === hash) return txid
  }
  return null
}

// --- CARDSET helpers ---

function resolveCardsetMembers(txids) {
  const ledger = loadCardimgLedger()
  const mempool = loadCardimgMempool()
  const allCards = { ...mempool.cards, ...ledger.cards }
  const excl = loadExclusions()

  return txids.map((txid, i) => {
    if (excl.cardimg.includes(txid)) return null
    const meta = allCards[txid]
    if (meta) {
      return {
        txid,
        position: i,
        role: i === 0 ? 'front' : i === 1 ? 'back' : 'supplementary',
        hash: meta.hash,
        blockHeight: meta.blockHeight,
        size: meta.size,
        imageUrl: `/img/${meta.hash}`,
        woCLink: `https://whatsonchain.com/tx/${txid}`
      }
    }
    return {
      txid,
      position: i,
      role: i === 0 ? 'front' : i === 1 ? 'back' : 'supplementary',
      unresolved: true,
      woCLink: `https://whatsonchain.com/tx/${txid}`
    }
  }).filter(Boolean)
}

function findSetsForTxid(txid) {
  const ledger = loadCardsetLedger()
  const mempool = loadCardsetMempool()
  const excl = loadExclusions()
  const allSets = [...mempool.sets, ...ledger.sets].filter(s => !excl.cardset.includes(s.cardsetTxid))
  return allSets
    .filter(s => s.txids.includes(txid))
    .map(s => ({
      cardsetTxid: s.cardsetTxid,
      position: s.txids.indexOf(txid),
      role: s.txids.indexOf(txid) === 0 ? 'front' : s.txids.indexOf(txid) === 1 ? 'back' : 'supplementary',
      totalMembers: s.txids.length,
      blockHeight: s.blockHeight || null,
      woCLink: `https://whatsonchain.com/tx/${s.cardsetTxid}`
    }))
}

// --- Thumbnails ---

async function getOrCreateThumb(buf, hash, width) {
  const thumbPath = path.join(THUMBS_DIR, `${hash}_${width}.jpg`)
  if (fs.existsSync(thumbPath)) return fs.readFileSync(thumbPath)
  if (!sharp) return null
  fs.mkdirSync(THUMBS_DIR, { recursive: true })
  try {
    const thumb = await sharp(buf).resize({ width, withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer()
    fs.writeFileSync(thumbPath, thumb)
    return thumb
  } catch { return null }
}

// --- Express app ---

const app = express()

// --- Localhost-only restriction ---
// Reject all non-localhost connections unless bypassed by trusted proxy
app.use((req, res, next) => {
  const addr = req.ip || req.socket.remoteAddress || ''
  const isLocal = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
  if (!isLocal) {
    return res.status(403).json({ error: 'Localhost only' })
  }
  next()
})
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.sendStatus(200)
  next()
})
app.use(express.json())

// ─── API: CARDIMG endpoints ───

app.get('/stats', (req, res) => {
  const imgLedger = loadCardimgLedger()
  const imgMempool = loadCardimgMempool()
  const setLedger = loadCardsetLedger()
  const setMempool = loadCardsetMempool()
  const excl = loadExclusions()
  const allCards = { ...imgMempool.cards, ...imgLedger.cards }
  const visibleCards = Object.entries(allCards).filter(([txid]) => !excl.cardimg.includes(txid))
  const allSets = [...setMempool.sets, ...setLedger.sets]
  const visibleSets = allSets.filter(s => !excl.cardset.includes(s.cardsetTxid))
  res.json({
    confirmed: visibleCards.filter(([, m]) => m.blockHeight).length,
    mempool: visibleCards.filter(([, m]) => !m.blockHeight).length,
    totalImages: visibleCards.length,
    totalBytes: Object.values(imgLedger.cards).reduce((s, c) => s + (c.size || 0), 0),
    lastBlock: imgLedger.lastBlock,
    sets: {
      confirmed: visibleSets.filter(s => s.blockHeight).length,
      mempool: visibleSets.filter(s => !s.blockHeight).length,
      totalSets: visibleSets.length
    }
  })
})

app.get('/list', (req, res) => {
  const imgLedger = loadCardimgLedger()
  const imgMempool = loadCardimgMempool()
  const excl = loadExclusions()
  const allCards = { ...imgMempool.cards, ...imgLedger.cards }
  const list = Object.entries(allCards)
    .filter(([txid]) => !excl.cardimg.includes(txid))
    .map(([txid, meta]) => ({
      txid,
      hash: meta.hash,
      blockHeight: meta.blockHeight ?? null,
      size: meta.size ?? 0,
      imageUrl: `/img/${meta.hash}`,
      txUrl: `/tx/${txid}`,
      woCLink: `https://whatsonchain.com/tx/${txid}`
    }))
  res.json(list)
})

app.get('/cards', (req, res) => {
  const imgLedger = loadCardimgLedger()
  const imgMempool = loadCardimgMempool()
  res.json({ ...imgMempool.cards, ...imgLedger.cards })
})

app.get('/cards/:txid', (req, res) => {
  const imgLedger = loadCardimgLedger()
  const imgMempool = loadCardimgMempool()
  const card = imgLedger.cards[req.params.txid] || imgMempool.cards[req.params.txid]
  if (!card) return res.status(404).json({ error: 'Not found' })
  res.json({ txid: req.params.txid, ...card })
})

app.get('/card/:hash', (req, res) => {
  const hash = req.params.hash
  const txid = getTxidForHash(hash)
  if (!txid) return res.status(404).json({ error: 'Not found' })
  if (isExcluded('cardimg', txid)) return res.status(404).json({ error: 'Not found' })
  const imgLedger = loadCardimgLedger()
  const imgMempool = loadCardimgMempool()
  const card = imgLedger.cards[txid] || imgMempool.cards[txid]
  const sets = findSetsForTxid(txid).filter(s => !isExcluded('cardset', s.cardsetTxid))
  res.json({
    hash,
    txid,
    blockHeight: card.blockHeight,
    size: card.size,
    woCLink: `https://whatsonchain.com/tx/${txid}`,
    imageUrl: `/img/${hash}`,
    txUrl: `/tx/${txid}`,
    cardsets: sets
  })
})

app.get('/img/:hash', async (req, res) => {
  try {
    const txid = getTxidForHash(req.params.hash)
    if (txid && isExcluded('cardimg', txid)) return res.status(404).json({ error: 'Image not found' })
    const buf = await getImageByHash(req.params.hash)
    if (!buf) return res.status(404).json({ error: 'Image not found' })
    res.setHeader('Content-Type', detectMime(buf))
    res.setHeader('Cache-Control', 'public, max-age=31536000')
    res.send(buf)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/tx/:txid', async (req, res) => {
  try {
    const txid = req.params.txid
    if (isExcluded('cardimg', txid)) return res.status(404).json({ error: 'Not found' })
    const result = await getImageByTxid(txid)
    if (!result) return res.status(404).json({ error: 'No CARDIMG output found for this txid' })
    res.setHeader('Content-Type', detectMime(result.buf))
    res.setHeader('Cache-Control', 'public, max-age=31536000')
    res.send(result.buf)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/cards/:txid/image', async (req, res) => {
  try {
    const result = await getImageByTxid(req.params.txid)
    if (!result) return res.status(404).json({ error: 'Image not found' })
    res.setHeader('Content-Type', detectMime(result.buf))
    res.send(result.buf)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/thumb/:hash', async (req, res) => {
  try {
    const txid = getTxidForHash(req.params.hash)
    if (txid && isExcluded('cardimg', txid)) return res.status(404).json({ error: 'Not found' })
    const buf = await getImageByHash(req.params.hash)
    if (!buf) return res.status(404).json({ error: 'Image not found' })
    const thumb = await getOrCreateThumb(buf, req.params.hash, 400)
    if (thumb) {
      res.setHeader('Content-Type', 'image/jpeg')
      res.setHeader('Cache-Control', 'public, max-age=31536000')
      return res.send(thumb)
    }
    res.setHeader('Content-Type', detectMime(buf))
    res.setHeader('Cache-Control', 'public, max-age=31536000')
    res.send(buf)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/thumb/tx/:txid', async (req, res) => {
  try {
    const txid = req.params.txid
    if (isExcluded('cardimg', txid)) return res.status(404).json({ error: 'Not found' })
    const result = await getImageByTxid(txid)
    if (!result) return res.status(404).json({ error: 'Not found' })
    const thumb = await getOrCreateThumb(result.buf, result.hash, 400)
    if (thumb) {
      res.setHeader('Content-Type', 'image/jpeg')
      res.setHeader('Cache-Control', 'public, max-age=31536000')
      return res.send(thumb)
    }
    res.setHeader('Content-Type', detectMime(result.buf))
    res.send(result.buf)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ─── API: CARDSET endpoints ───

app.get('/sets/list', (req, res) => {
  const setLedger = loadCardsetLedger()
  const setMempool = loadCardsetMempool()
  const excl = loadExclusions()
  const allSets = [...setMempool.sets, ...setLedger.sets].filter(s => !excl.cardset.includes(s.cardsetTxid))
  res.json(allSets.map(s => ({
    cardsetTxid: s.cardsetTxid,
    txids: s.txids,
    memberCount: s.txids.length,
    blockHeight: s.blockHeight || null,
    woCLink: `https://whatsonchain.com/tx/${s.cardsetTxid}`
  })))
})

app.get('/sets/:txid', (req, res) => {
  const setLedger = loadCardsetLedger()
  const setMempool = loadCardsetMempool()
  const excl = loadExclusions()
  if (excl.cardset.includes(req.params.txid)) return res.status(404).json({ error: 'Not found' })
  const allSets = [...setMempool.sets, ...setLedger.sets]
  const set = allSets.find(s => s.cardsetTxid === req.params.txid)
  if (!set) return res.status(404).json({ error: 'Not found' })
  const members = resolveCardsetMembers(set.txids)
  res.json({
    cardsetTxid: set.cardsetTxid,
    blockHeight: set.blockHeight || null,
    memberCount: members.length,
    members,
    woCLink: `https://whatsonchain.com/tx/${set.cardsetTxid}`
  })
})

app.get('/card/:hash/sets', (req, res) => {
  const txid = getTxidForHash(req.params.hash)
  if (!txid) return res.json({ hash: req.params.hash, cardsets: [] })
  const sets = findSetsForTxid(txid).filter(s => !isExcluded('cardset', s.cardsetTxid))
  res.json({ hash: req.params.hash, cardsets: sets })
})

// ─── API: Exclusions ───

app.get('/exclusions', (req, res) => res.json(loadExclusions()))

app.post('/exclusions', (req, res) => {
  const { type, txid } = req.body
  if (!type || !txid) return res.status(400).json({ error: 'Missing type or txid' })
  if (type !== 'cardimg' && type !== 'cardset') return res.status(400).json({ error: 'Invalid type' })
  const excl = loadExclusions()
  if (!excl[type].includes(txid)) {
    excl[type].push(txid)
    saveExclusions(excl)
  }
  res.json({ success: true, type, txid, total: excl[type].length })
})

app.delete('/exclusions', (req, res) => {
  const { type, txid } = req.body
  if (!type || !txid) return res.status(400).json({ error: 'Missing type or txid' })
  const excl = loadExclusions()
  excl[type] = excl[type].filter(t => t !== txid)
  saveExclusions(excl)
  res.json({ success: true, type, txid, total: excl[type].length })
})

// ─── API: Card codes ───

app.get('/card-codes', (req, res) => res.json(loadCardCodes()))

app.post('/card-codes', (req, res) => {
  const { cardsetTxid, code } = req.body
  if (!cardsetTxid || !code) return res.status(400).json({ error: 'Missing cardsetTxid or code' })
  const data = loadCardCodes()
  data.mappings[cardsetTxid] = code
  saveCardCodes(data)
  res.json({ success: true, cardsetTxid, code, total: Object.keys(data.mappings).length })
})

app.delete('/card-codes', (req, res) => {
  const { cardsetTxid } = req.body
  if (!cardsetTxid) return res.status(400).json({ error: 'Missing cardsetTxid' })
  const data = loadCardCodes()
  delete data.mappings[cardsetTxid]
  saveCardCodes(data)
  res.json({ success: true, cardsetTxid, total: Object.keys(data.mappings).length })
})

// ─── API: Card reference ───

app.get('/card-reference', (req, res) => res.json(loadCardReference()))

app.post('/card-reference', (req, res) => {
  if (!Array.isArray(req.body)) return res.status(400).json({ error: 'Expected an array' })
  saveCardReference(req.body)
  res.json({ success: true, count: req.body.length })
})

// ─── API: Front card matching + validator references ───

// Serve references.json (dHash + histogram for all 42 cards + back)
// Used by the browser-side validator (validator.js)
const REFERENCES_PATH = path.join(__dirname, 'lib', 'validator', 'references.json')
let referencesCache = null
app.get('/references/json', (req, res) => {
  try {
    if (!referencesCache) {
      if (!fs.existsSync(REFERENCES_PATH)) {
        return res.status(404).json({ error: 'references.json not found — run build-references.js' })
      }
      referencesCache = JSON.parse(fs.readFileSync(REFERENCES_PATH, 'utf8'))
    }
    res.json(referencesCache)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Legacy: Get reference thumbnails for client-side comparison (base64 JPEGs, ~84KB total)
// ─── API: Upload (receives client-processed JPEGs) ───

app.get('/wallet/status', async (req, res) => {
  try {
    if (!fs.existsSync(EXPLORER_WALLET)) {
      return res.json({ configured: false, address: null, balance: null })
    }
    const wallet = loadWallet(EXPLORER_WALLET)
    const utxos = await getUtxos(wallet.addr.toString())
    const total = utxos.reduce((s, u) => s + u.satoshis, 0)
    res.json({
      configured: true,
      address: wallet.addr.toString(),
      balance: { confirmed: total, unconfirmed: 0, total },
      utxos: utxos.length
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ─── Upload job store (in-memory, TTL 1hr) ───

const uploadJobs = new Map()
const JOB_TTL_MS = 60 * 60 * 1000
setInterval(() => {
  const now = Date.now()
  for (const [id, job] of uploadJobs) {
    if (now - job.started > JOB_TTL_MS) uploadJobs.delete(id)
  }
}, 10 * 60 * 1000)

// ─── Card identification endpoint ───

// POST /verify — identify a front card JPEG
// Input: multipart form with 'image' field (processed JPEG from browser)
// Output: { ok, code, distance, margin, reason }
const verifyUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } })
app.post('/verify', verifyUpload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image provided' })
  try {
    const result = await identify(req.file.buffer)
    res.json(result)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /verify/status — show config + reference count
app.get('/verify/status', (req, res) => {
  const refsData = JSON.parse(fs.readFileSync(path.join(__dirname, 'card-refs.json'), 'utf8'))
  res.json({
    maxDistance: cardIdCfg.maxDistance,
    minMargin: cardIdCfg.minMargin,
    indexedCodes: refsData.indexedCodes,
    totalCodes: refsData.totalCodes,
    missingCodes: refsData.missingCodes,
  })
})

// Upload processed JPEGs — returns jobId immediately, processes in background
app.post('/upload-all', upload.array('files', 50), (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No files provided' })
  }

  const jobId = crypto.randomUUID()
  const files = req.files.map(f => ({ name: f.originalname, buffer: f.buffer, size: f.size }))

  uploadJobs.set(jobId, {
    id: jobId,
    status: 'processing',
    files: files.map(f => ({ name: f.name, size: f.size })),
    uploaded: [],
    errors: [],
    cardset: null,
    started: Date.now(),
    progress: { step: 0, total: files.length, message: 'Starting upload...' }
  })

  // Respond immediately — client polls /upload-status/:jobId
  res.json({ jobId })

  // Process in background
  processUploadJob(jobId, files, req.ip).catch(err => {
    console.error(`[UPLOAD JOB ${jobId}] Fatal error:`, err)
    const job = uploadJobs.get(jobId)
    if (job) {
      job.status = 'failed'
      job.errors.push({ error: 'Fatal: ' + err.message })
      job.progress = { step: job.progress.step, total: job.progress.total, message: 'Fatal error: ' + err.message }
    }
  })
})

// Poll upload status
app.get('/upload-status/:jobId', (req, res) => {
  const job = uploadJobs.get(req.params.jobId)
  if (!job) return res.status(404).json({ error: 'Job not found' })
  res.json({
    jobId: job.id,
    status: job.status,
    progress: job.progress,
    files: job.files,
    uploaded: job.uploaded,
    errors: job.errors,
    cardset: job.cardset
  })
})

// Background upload processor
async function processUploadJob(jobId, files, ip) {
  const job = uploadJobs.get(jobId)
  if (!job) return

  const walletPath = EXPLORER_WALLET
  const spentOutpoints = new Set()
  const extraUtxos = []
  const fileBuffers = new Map(files.map(f => [f.name, f.buffer]))

  const LOG_PATH = path.join(DATA_DIR, 'upload-log.jsonl')
  const logEntry = (fields) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), ip, ...fields })
    fs.appendFile(LOG_PATH, line + '\n', () => {})
  }
  logEntry({ event: 'upload-start', jobId, files: files.map(f => ({ name: f.name, size: f.size })) })

  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    job.progress = { step: i, total: files.length, message: `Verifying ${file.name} (${i + 1}/${files.length})...` }

    // --- Server-side card identification gate ---
    let idResult
    try {
      idResult = await identify(file.buffer)
    } catch (e) {
      idResult = { ok: false, code: null, distance: null, margin: null, reason: `id_error: ${e.message}` }
    }

    if (!idResult.ok) {
      job.errors.push({ filename: file.name, error: `Rejected: ${idResult.reason}` })
      logEntry({ event: 'image-rejected', jobId, filename: file.name, reason: idResult.reason, code: idResult.code, distance: idResult.distance, margin: idResult.margin })
      continue
    }

    logEntry({ event: 'image-verified', jobId, filename: file.name, code: idResult.code, distance: idResult.distance, margin: idResult.margin })

    // --- Upload to chain ---
    job.progress = { step: i, total: files.length, message: `Uploading ${file.name} (${i + 1}/${files.length})...` }
    if (i > 0) await new Promise(r => setTimeout(r, 2000))
    try {
      const imageBuf = file.buffer
      const result = await uploadCardImg(imageBuf, walletPath, { spentOutpoints })
      const cleanTxid = typeof result.txid === 'string' ? result.txid.trim().replace(/^["']+|["']+$/g, '') : result.txid
      job.uploaded.push({
        filename: file.name,
        hash: result.hash,
        txid: cleanTxid,
        fee: result.fee,
        size: imageBuf.length
      })
      if (result.changeUtxo) extraUtxos.push(result.changeUtxo)
      logEntry({ event: 'image-uploaded', jobId, filename: file.name, txid: cleanTxid, hash: result.hash, fee: result.fee, size: imageBuf.length })
    } catch (e) {
      job.errors.push({ filename: file.name, error: e.message })
      logEntry({ event: 'image-failed', jobId, filename: file.name, error: e.message })
    }
  }

  // Create CARDSET if 2+ images uploaded successfully
  if (job.uploaded.length >= 2 && bindCardImages) {
    job.progress = { step: files.length, total: files.length, message: 'Creating CARDSET...' }
    try {
      const txids = job.uploaded.map(u => u.txid)
      const bindResult = await bindCardImages(txids, walletPath, { spentOutpoints, extraUtxos })
      job.cardset = {
        txid: bindResult.txid,
        txidCount: bindResult.txidCount,
        fee: bindResult.fee
      }
      logEntry({ event: 'cardset-created', jobId, txid: bindResult.txid, txidCount: bindResult.txidCount, fee: bindResult.fee, members: job.uploaded.map(u => u.txid) })
    } catch (e) {
      console.error('[CARDSET BIND FAILED] error:', e.message)
      job.errors.push({ error: 'CARDSET binding failed: ' + e.message + '. Images are uploaded but not linked.' })
      logEntry({ event: 'cardset-failed', jobId, error: e.message, members: job.uploaded.map(u => u.txid) })
    }
  }

  // Zero-conf caching
  const imagesDir = path.join(DATA_DIR, 'images')
  fs.mkdirSync(imagesDir, { recursive: true })
  const mempoolPath = path.join(DATA_DIR, 'mempool.json')
  let mempool = loadCardimgMempool()
  for (const u of job.uploaded) {
    const imgBuf = fileBuffers.get(u.filename)
    if (imgBuf) {
      const imgPath = path.join(imagesDir, `${u.hash}.bin`)
      if (!fs.existsSync(imgPath)) fs.writeFileSync(imgPath, imgBuf)
    }
    mempool.cards[u.txid] = { hash: u.hash, size: u.size, blockHeight: null }
  }
  if (job.cardset) {
    const csMempoolPath = path.join(DATA_DIR, 'cardset-mempool.json')
    let csMempool = loadCardsetMempool()
    csMempool.sets.push({
      cardsetTxid: job.cardset.txid,
      txids: job.uploaded.map(u => u.txid),
      blockHeight: null
    })
    csMempool.lastScan = Date.now()
    fs.writeFileSync(csMempoolPath, JSON.stringify(csMempool, null, 2))
  }
  mempool.lastScan = Date.now()
  fs.writeFileSync(mempoolPath, JSON.stringify(mempool, null, 2))

  // Queue for indexer backfill
  const UPLOAD_QUEUE = path.join(DATA_DIR, 'upload-queue.json')
  const allTxids = [...job.uploaded.map(u => u.txid)]
  if (job.cardset) allTxids.push(job.cardset.txid)
  if (allTxids.length > 0) {
    let queue = []
    if (fs.existsSync(UPLOAD_QUEUE)) {
      try { queue = JSON.parse(fs.readFileSync(UPLOAD_QUEUE, 'utf8')); if (!Array.isArray(queue)) queue = [] } catch {}
    }
    for (const txid of allTxids) {
      if (!queue.includes(txid)) queue.push(txid)
    }
    fs.writeFileSync(UPLOAD_QUEUE, JSON.stringify(queue, null, 2))
  }

  job.status = 'complete'
  job.progress = { step: files.length, total: files.length, message: 'Upload complete' }
  logEntry({ event: 'upload-complete', jobId, uploaded: job.uploaded.length, errors: job.errors.length, cardset: job.cardset ? job.cardset.txid : null })
}

// ─── Static viewer ───

// Serve public/ if it exists
if (fs.existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR))
  // SPA fallback
  app.get('*', (req, res) => {
    const indexPath = path.join(PUBLIC_DIR, 'index.html')
    if (fs.existsSync(indexPath)) {
      res.sendFile(indexPath)
    } else {
      res.status(404).json({ error: 'Not found' })
    }
  })
} else {
  // Minimal HTML fallback if public/ doesn't exist yet
  app.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/html')
    res.send('<!DOCTYPE html><html><head><title>CARDIMG API</title></head><body><h1>CARDIMG API</h1><p>Viewer not installed. Put static files in <code>public/</code>.</p><p>API: <a href="/list">/list</a>, <a href="/stats">/stats</a>, <a href="/sets/list">/sets/list</a></p></body></html>')
  })
}

// --- Start ---

const args = process.argv.slice(2)
const portArg = args.indexOf('--port')
const PORT = portArg >= 0 ? parseInt(args[portArg + 1]) : 3014

app.listen(PORT, () => {
  console.log(`CARDIMG + CARDSET API running at http://localhost:${PORT}`)
  console.log('')
  console.log('CARDIMG endpoints:')
  console.log('  GET  /list              — all cards')
  console.log('  GET  /card/:hash        — card metadata + CARDSET associations')
  console.log('  GET  /img/:hash         — raw image by hash')
  console.log('  GET  /tx/:txid          — raw image by txid')
  console.log('  GET  /thumb/:hash       — thumbnail by hash')
  console.log('  GET  /thumb/tx/:txid    — thumbnail by txid')
  console.log('  GET  /stats             — index stats')
  console.log('')
  console.log('CARDSET endpoints:')
  console.log('  GET  /sets/list         — all CARDSETs')
  console.log('  GET  /sets/:txid        — CARDSET with resolved members')
  console.log('  GET  /card/:hash/sets   — reverse lookup: which sets contain this card')
  console.log('')
  console.log('Management:')
  console.log('  GET/POST/DELETE /exclusions')
  console.log('  GET/POST/DELETE /card-codes')
  console.log('  GET/POST       /card-reference')
  console.log('')
  console.log('Front matching:')
  console.log('  GET  /references/fronts  — 42 reference thumbnails (base64 JPEG)')
  console.log('  POST /references/match    — server-side match for an image')
  console.log('')
  if (fs.existsSync(PUBLIC_DIR)) {
    console.log(`Viewer: serving from ${PUBLIC_DIR}`)
  } else {
    console.log('Viewer: public/ not found — create it and add static files')
  }
})
