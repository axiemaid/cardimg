#!/usr/bin/env node
/**
 * CARDIMG + CARDSET Unified Indexer
 * 
 * Single process. Two JungleBus subscriptions (one per protocol).
 * Catches all CARDIMG and CARDSET transactions from anyone.
 * 
 * Data files (unchanged format, carried over):
 *   ledger.json          — CARDIMG confirmed (txid-keyed)
 *   mempool.json         — CARDIMG zero-conf
 *   cardset-ledger.json  — CARDSET confirmed
 *   cardset-mempool.json — CARDSET zero-conf
 *   images/<hash>.bin    — image cache (hash-keyed)
 * 
 * Usage:
 *   node indexer.cjs                # Start/continue from last block
 *   node indexer.cjs --from <height># Start from specific block
 *   node indexer.cjs --status       # Show index status
 *   node indexer.cjs --once         # Single pass, exit after 10s
 */

// localStorage polyfill (required by js-junglebus)
const _store = {}
const _ls = {
  getItem: k => _store[k] ?? null,
  setItem: (k, v) => { _store[k] = String(v) },
  removeItem: k => { delete _store[k] },
  clear: () => { for (const k in _store) delete _store[k] },
  get length() { return Object.keys(_store).length },
  key: i => Object.keys(_store)[i] ?? null
}
try { Object.defineProperty(globalThis, 'localStorage', { value: _ls, writable: true, configurable: true }) } catch { globalThis.localStorage = _ls }

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { JungleBusClient } = require('@gorillapool/js-junglebus')

// --- Config ---

const WoC_API = 'https://api.whatsonchain.com/v1/bsv/main'
const DATA_DIR = __dirname
const CARDIMG_LEDGER = path.join(DATA_DIR, 'ledger.json')
const CARDIMG_MEMPOOL = path.join(DATA_DIR, 'mempool.json')
const CARDSET_LEDGER = path.join(DATA_DIR, 'cardset-ledger.json')
const CARDSET_MEMPOOL = path.join(DATA_DIR, 'cardset-mempool.json')
const IMAGES_DIR = path.join(DATA_DIR, 'images')
const LOG_PATH = path.join(DATA_DIR, 'upload-log.json')
const CARD_SCANS_DIR = '/Users/axiemaid/.openclaw/card-scans'

const CARDIMG_SUB = process.env.CARDIMG_SUB || 'f25086265e0adc867a6a45f51a8f1be63bf79fc19355513543d1c704c461889a'
const CARDSET_SUB = process.env.CARDSET_SUB || '94572334d5674b3da841c058b4b462c5d83c83350f92918aa175c80b804a50ac'
const START_BLOCK = 957054

// --- Shared parsing ---

function parsePushData(buf, offset) {
  const b = buf[offset]
  if (b <= 0x4b) return { data: buf.slice(offset + 1, offset + 1 + b), next: offset + 1 + b }
  if (b === 0x4c) { const l = buf[offset + 1]; return { data: buf.slice(offset + 2, offset + 2 + l), next: offset + 2 + l } }
  if (b === 0x4d) { const l = buf.readUInt16LE(offset + 1); return { data: buf.slice(offset + 3, offset + 3 + l), next: offset + 3 + l } }
  if (b === 0x4e) { const l = buf.readUInt32LE(offset + 1); return { data: buf.slice(offset + 5, offset + 5 + l), next: offset + 5 + l } }
  return null
}

function parseOpReturn(outputs) {
  // Returns { protocol, hash?, image?, size?, txids? }
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

function detectFormat(buf) {
  if (buf[0] === 0xFF && buf[1] === 0xD8) return 'JPEG'
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'PNG'
  if (buf[0] === 0x52 && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'WebP'
  if (buf[0] === 0x47 && buf[1] === 0x49) return 'GIF'
  return 'unknown'
}

// --- State helpers ---

function loadJSON(p, fallback) {
  if (fs.existsSync(p)) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return fallback }
  }
  return fallback
}

function saveJSON(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2))
}

function loadCardimgLedger() {
  return loadJSON(CARDIMG_LEDGER, { cards: {}, lastBlock: START_BLOCK, totalImages: 0, totalBytes: 0 })
}
function loadCardimgMempool() {
  return loadJSON(CARDIMG_MEMPOOL, { cards: {}, lastScan: 0 })
}
function loadCardsetLedger() {
  return loadJSON(CARDSET_LEDGER, { sets: [], lastBlock: START_BLOCK, totalSets: 0 })
}
function loadCardsetMempool() {
  return loadJSON(CARDSET_MEMPOOL, { sets: [], lastScan: 0 })
}

// --- WoC helpers ---

async function getOpReturn(txid) {
  const res = await fetch(`${WoC_API}/tx/${txid}/opreturn`)
  if (!res.ok) return null
  const data = await res.json()
  return data
}

async function getTxInfo(txid) {
  const res = await fetch(`${WoC_API}/tx/hash/${txid}`)
  if (!res.ok) return null
  return res.json()
}

// Fetch all txids in a block from WoC
async function getBlockTxids(height) {
  const res = await fetch(`${WoC_API}/block/height/${height}`)
  if (!res.ok) return null
  const data = await res.json()
  return data.tx || null
}

// --- Image cache ---

function cacheImage(hash, imageBuf) {
  fs.mkdirSync(IMAGES_DIR, { recursive: true })
  const p = path.join(IMAGES_DIR, `${hash}.bin`)
  if (!fs.existsSync(p)) fs.writeFileSync(p, imageBuf)
}

// --- Upload log ---

function appendLog(entry) {
  let log = []
  if (fs.existsSync(LOG_PATH)) {
    try { log = JSON.parse(fs.readFileSync(LOG_PATH, 'utf8')) } catch { log = [] }
  }
  if (log.some(e => e.txid === entry.txid)) return null
  const n = log.length > 0 ? Math.max(...log.map(e => e.n || 0)) + 1 : 1
  log.push({ n, ...entry })
  saveJSON(LOG_PATH, log)
  if (fs.existsSync(CARD_SCANS_DIR)) {
    try { fs.copyFileSync(LOG_PATH, path.join(CARD_SCANS_DIR, 'upload-log.json')) } catch {}
  }
  return n
}

// --- CARDIMG indexing ---

async function indexCardimg(txid, blockHeight, imgLedger, imgMempool) {
  if (imgLedger.cards[txid]) return false // already confirmed

  const opReturns = await getOpReturn(txid)
  if (!opReturns || opReturns.length === 0) return false

  const parsed = parseOpReturn(opReturns)
  if (!parsed || parsed.protocol !== 'CARDIMG') return false

  cacheImage(parsed.hash, parsed.image)

  imgLedger.cards[txid] = {
    hash: parsed.hash,
    blockHeight: blockHeight || null,
    size: parsed.size
  }
  delete imgMempool.cards[txid]

  const logN = appendLog({
    file: `junglebus-${txid.substring(0, 8)}.bin`,
    format: detectFormat(parsed.image),
    sizeBytes: parsed.size,
    sha256: parsed.hash,
    txid,
    blockHeight: blockHeight || null,
    confirmed: !!blockHeight,
    uploadedAt: new Date().toISOString().split('T')[0],
    sourceFile: 'JungleBus index',
    notes: 'Found via JungleBus subscription'
  })

  console.log(`  📸 ${txid.substring(0, 16)}... | ${(parsed.size / 1024).toFixed(0)}KB | ${detectFormat(parsed.image)} | block ${blockHeight || 'mempool'}${logN ? ' (log #' + logN + ')' : ''}`)
  return true
}

function indexCardimgMempool(txid, imgMempool) {
  // Fetch + parse async, add to mempool
  getOpReturn(txid).then(opReturns => {
    if (!opReturns || opReturns.length === 0) return
    const parsed = parseOpReturn(opReturns)
    if (!parsed || parsed.protocol !== 'CARDIMG') return

    cacheImage(parsed.hash, parsed.image)
    imgMempool.cards[txid] = { hash: parsed.hash, size: parsed.size, blockHeight: null }
    imgMempool.lastScan = Date.now()
    saveJSON(CARDIMG_MEMPOOL, imgMempool)
    console.log(`  📸 [mempool] ${txid.substring(0, 16)}... | ${(parsed.size / 1024).toFixed(0)}KB`)
  }).catch(e => console.error(`CARDIMG mempool error ${txid}:`, e.message))
}

// --- CARDSET indexing ---

async function indexCardset(txid, blockHeight, setLedger, setMempool) {
  const existing = setLedger.sets.find(s => s.cardsetTxid === txid)

  // Already confirmed? Skip.
  if (existing && existing.blockHeight) return false

  // In ledger with null block, now confirmed? Promote.
  if (existing && blockHeight) {
    existing.blockHeight = blockHeight
    setLedger.lastBlock = Math.max(setLedger.lastBlock || 0, blockHeight)
    saveJSON(CARDSET_LEDGER, setLedger)
    setMempool.sets = setMempool.sets.filter(s => s.cardsetTxid !== txid)
    saveJSON(CARDSET_MEMPOOL, setMempool)
    console.log(`  🃏 ↻ ${txid.substring(0, 16)}... promoted to block ${blockHeight}`)
    return true
  }

  if (existing) return false

  const opReturns = await getOpReturn(txid)
  if (!opReturns || opReturns.length === 0) return false

  const parsed = parseOpReturn(opReturns)
  if (!parsed || parsed.protocol !== 'CARDSET') return false

  if (blockHeight) {
    setLedger.sets.push({
      cardsetTxid: txid,
      txids: parsed.txids,
      blockHeight
    })
    setLedger.totalSets = setLedger.sets.length
    setMempool.sets = setMempool.sets.filter(s => s.cardsetTxid !== txid)
    saveJSON(CARDSET_LEDGER, setLedger)
    saveJSON(CARDSET_MEMPOOL, setMempool)
    console.log(`  🃏 ${txid.substring(0, 16)}... | ${parsed.txids.length} txids | block ${blockHeight}`)
  } else {
    setMempool.sets.push({
      cardsetTxid: txid,
      txids: parsed.txids,
      createdAt: Date.now()
    })
    setMempool.lastScan = Date.now()
    saveJSON(CARDSET_MEMPOOL, setMempool)
    console.log(`  🃏 [mempool] ${txid.substring(0, 16)}... | ${parsed.txids.length} txids`)
  }

  parsed.txids.forEach((t, i) => {
    const role = i === 0 ? 'FRONT' : i === 1 ? 'BACK' : 'SUP' + (i - 1)
    console.log(`      ${role}: ${t.substring(0, 16)}...`)
  })
  return true
}

// Sync guard set — prevents race condition where JungleBus fires mempool callback
// multiple times before the first async getOpReturn completes.
const _cardsetMempoolPending = new Set()

async function indexCardsetMempool(txid, setLedger, setMempool) {
  // Sync dedup: check existing entries first
  if (setMempool.sets.some(s => s.cardsetTxid === txid)) return
  if (setLedger.sets.some(s => s.cardsetTxid === txid)) return
  // Sync guard: mark as pending BEFORE any async call
  if (_cardsetMempoolPending.has(txid)) return
  _cardsetMempoolPending.add(txid)

  try {
    const opReturns = await getOpReturn(txid)
    if (!opReturns || opReturns.length === 0) return

    const parsed = parseOpReturn(opReturns)
    if (!parsed || parsed.protocol !== 'CARDSET') return

    setMempool.sets.push({
      cardsetTxid: txid,
      txids: parsed.txids,
      createdAt: Date.now()
    })
    setMempool.lastScan = Date.now()
    saveJSON(CARDSET_MEMPOOL, setMempool)
    console.log(`  🃏 [mempool] ${txid.substring(0, 16)}... | ${parsed.txids.length} txids`)
  } finally {
    _cardsetMempoolPending.delete(txid)
  }
}

// Promote CARDSET mempool entries that have been confirmed
async function promoteCardsetMempool(setLedger, setMempool) {
  for (const set of [...setMempool.sets]) {
    try {
      const info = await getTxInfo(set.cardsetTxid)
      if (!info || info.blockheight == null) continue
      set.blockHeight = info.blockheight
      setLedger.sets.push(set)
      setLedger.totalSets = setLedger.sets.length
      setLedger.lastBlock = Math.max(setLedger.lastBlock || 0, info.blockheight)
      setMempool.sets = setMempool.sets.filter(s => s.cardsetTxid !== set.cardsetTxid)
      console.log(`  🃏 ↻ ${set.cardsetTxid.substring(0, 16)}... promoted to block ${info.blockheight}`)
    } catch (e) {
      console.error(`Promote error ${set.cardsetTxid}:`, e.message)
    }
  }
  saveJSON(CARDSET_LEDGER, setLedger)
  saveJSON(CARDSET_MEMPOOL, setMempool)
}

// --- JungleBus ---

async function startSubscription(subId, name, fromBlock, onPublish, onMempool) {
  const jungle = new JungleBusClient('junglebus.gorillapool.io', {
    onConnected() { console.log(`[${name}] connected`) },
    onConnecting() { console.log(`[${name}] connecting...`) },
    onDisconnected() { console.log(`[${name}] disconnected`) },
    onError(ctx) { console.error(`[${name}] error:`, ctx) }
  })

  const publishCb = (tx) => {
    onPublish(tx).catch(e => console.error(`[${name}] index error ${tx.id}:`, e.message))
  }
  const mempoolCb = (tx) => {
    onMempool(tx).catch(e => console.error(`[${name}] mempool error ${tx.id}:`, e.message))
  }
  const statusCb = (ctx) => {
    if (ctx.statusCode === 200) {
      // Update ledgers via callback
      if (ctx.block) onPublish._updateBlock?.(ctx.block)
    }
  }
  const errorCb = (ctx) => console.error(`[${name}] subscribe error:`, ctx)

  await jungle.Subscribe(subId, fromBlock, publishCb, statusCb, errorCb, mempoolCb)
  return jungle
}

// --- Status ---

function showStatus(imgLedger, imgMempool, setLedger, setMempool) {
  console.log('')
  console.log('=== CARDIMG + CARDSET Index Status ===')
  console.log(`CARDIMG confirmed: ${Object.keys(imgLedger.cards).length}`)
  console.log(`CARDIMG mempool:   ${Object.keys(imgMempool.cards).length}`)
  console.log(`CARDIMG bytes:     ${(Object.values(imgLedger.cards).reduce((s, c) => s + (c.size || 0), 0) / 1024 / 1024).toFixed(1)}MB`)
  console.log(`CARDIMG lastBlock: ${imgLedger.lastBlock}`)
  console.log(`CARDSET confirmed: ${setLedger.sets.length}`)
  console.log(`CARDSET mempool:   ${setMempool.sets.length}`)
  console.log(`CARDSET lastBlock: ${setLedger.lastBlock}`)
  console.log('')
  console.log('CARDIMG entries:')
  for (const [txid, card] of Object.entries(imgLedger.cards)) {
    const cached = fs.existsSync(path.join(IMAGES_DIR, `${card.hash}.bin`)) ? '✓' : '✗'
    console.log(`  ${txid.substring(0, 16)}... | block ${card.blockHeight} | ${(card.size / 1024).toFixed(0)}KB | ${cached}`)
  }
  console.log('')
  console.log('CARDSET entries:')
  for (const set of setLedger.sets) {
    console.log(`  ${set.cardsetTxid.substring(0, 16)}... | ${set.txids.length} txids | block ${set.blockHeight}`)
  }
  if (setMempool.sets.length > 0) {
    console.log('CARDSET mempool:')
    for (const set of setMempool.sets) {
      console.log(`  ${set.cardsetTxid.substring(0, 16)}... | ${set.txids.length} txids`)
    }
  }
}

// --- Repair missed CARDSETs by scanning WoC blocks ---
// JungleBus can miss CARDSETs if the websocket drops during broadcast/confirmation.
// This scans blocks between setLedger.lastBlock and chain tip, finds any CARDSET txs
// that aren't in the ledger, and indexes them.
async function repairCardsetGaps(setLedger, setMempool) {
  // Get current chain tip
  let chainTip
  try {
    const res = await fetch(`${WoC_API}/chain/info`)
    if (!res.ok) return
    const data = await res.json()
    chainTip = data.blocks
  } catch (e) {
    console.error(`[repair] CARDSET gap: failed to get chain tip:`, e.message)
    return
  }

  const fromBlock = (setLedger.lastBlock || START_BLOCK) + 1
  if (fromBlock > chainTip) return // up to date

  const blocksToScan = chainTip - fromBlock + 1
  if (blocksToScan > 50) {
    console.log(`[repair] CARDSET gap: ${blocksToScan} blocks behind (scanning last 50 only)`)
  }
  const scanFrom = Math.max(fromBlock, chainTip - 49)

  let found = 0
  for (let height = scanFrom; height <= chainTip; height++) {
    let txids
    try {
      txids = await getBlockTxids(height)
    } catch (e) {
      console.error(`[repair] CARDSET gap: failed to get block ${height}:`, e.message)
      continue
    }
    if (!txids) continue

    for (const txid of txids) {
      // Skip if already in ledger or mempool
      if (setLedger.sets.some(s => s.cardsetTxid === txid)) continue
      if (setMempool.sets.some(s => s.cardsetTxid === txid)) continue

      try {
        const opReturns = await getOpReturn(txid)
        if (!opReturns || opReturns.length === 0) continue
        const parsed = parseOpReturn(opReturns)
        if (!parsed || parsed.protocol !== 'CARDSET') continue

        setLedger.sets.push({
          cardsetTxid: txid,
          txids: parsed.txids,
          blockHeight: height
        })
        setLedger.totalSets = setLedger.sets.length
        setLedger.lastBlock = Math.max(setLedger.lastBlock || 0, height)
        saveJSON(CARDSET_LEDGER, setLedger)
        saveJSON(CARDSET_MEMPOOL, setMempool)
        console.log(`  🃏 [repair] ${txid.substring(0, 16)}... | ${parsed.txids.length} txids | block ${height}`)
        found++
      } catch (e) {
        // Not a CARDSET or WoC error — skip
      }
    }
  }

  // Update lastBlock even if no new CARDSETs found
  setLedger.lastBlock = Math.max(setLedger.lastBlock || 0, chainTip)
  saveJSON(CARDSET_LEDGER, setLedger)

  if (found > 0) {
    console.log(`[repair] CARDSET gap: found ${found} missed CARDSET(s) in blocks ${scanFrom}-${chainTip}`)
  }
}

// --- Main ---

async function main() {
  const args = process.argv.slice(2)
  const statusOnly = args.includes('--status')
  const fromArg = args.indexOf('--from')
  const fromBlock = fromArg >= 0 ? parseInt(args[fromArg + 1]) : null
  const once = args.includes('--once')

  let imgLedger = loadCardimgLedger()
  let imgMempool = loadCardimgMempool()
  let setLedger = loadCardsetLedger()
  let setMempool = loadCardsetMempool()

  if (statusOnly) {
    showStatus(imgLedger, imgMempool, setLedger, setMempool)
    process.exit(0)
  }

  const imgFrom = fromBlock || imgLedger.lastBlock || START_BLOCK
  const setFrom = fromBlock || setLedger.lastBlock || START_BLOCK

  // Sync totals
  imgLedger.totalImages = Object.keys(imgLedger.cards).length
  imgLedger.totalBytes = Object.values(imgLedger.cards).reduce((s, c) => s + (c.size || 0), 0)
  setLedger.totalSets = setLedger.sets.length

  console.log('CARDIMG + CARDSET Unified Indexer')
  console.log(`CARDIMG: ${Object.keys(imgLedger.cards).length} confirmed, ${Object.keys(imgMempool.cards).length} mempool, from block ${imgFrom}`)
  console.log(`CARDSET: ${setLedger.sets.length} confirmed, ${setMempool.sets.length} mempool, from block ${setFrom}`)
  console.log('')

  // CARDIMG subscription
  console.log('[CARDIMG] Starting subscription...')
  const imgJungle = await startSubscription(
    CARDIMG_SUB, 'CARDIMG', imgFrom,
    async (tx) => {
      const found = await indexCardimg(tx.id, tx.block_height, imgLedger, imgMempool)
      if (found) {
        imgLedger.lastBlock = Math.max(imgLedger.lastBlock || 0, tx.block_height || 0)
        imgLedger.totalImages = Object.keys(imgLedger.cards).length
        imgLedger.totalBytes = Object.values(imgLedger.cards).reduce((s, c) => s + (c.size || 0), 0)
        saveJSON(CARDIMG_LEDGER, imgLedger)
        saveJSON(CARDIMG_MEMPOOL, imgMempool)
      }
    },
    async (tx) => {
      indexCardimgMempool(tx.id, imgMempool)
    }
  )

  // CARDSET subscription
  console.log('[CARDSET] Starting subscription...')
  const setJungle = await startSubscription(
    CARDSET_SUB, 'CARDSET', setFrom,
    async (tx) => {
      const found = await indexCardset(tx.id, tx.block_height, setLedger, setMempool)
      if (found) {
        setLedger.lastBlock = Math.max(setLedger.lastBlock || 0, tx.block_height || 0)
        setLedger.totalSets = setLedger.sets.length
        saveJSON(CARDSET_LEDGER, setLedger)
        saveJSON(CARDSET_MEMPOOL, setMempool)
      }
    },
    async (tx) => {
      await indexCardsetMempool(tx.id, setLedger, setMempool)
    }
  )

  if (once) {
    console.log('Waiting for initial sync...')
    await new Promise(r => setTimeout(r, 10000))
    console.log('Done.')
    process.exit(0)
  }

  // --- Gap repair: cross-check CARDSET members against CARDIMG ledger ---
  // JungleBus occasionally misses txs. Any CARDIMG tx referenced by a CARDSET
  // but not in the CARDIMG ledger gets fetched from WoC and indexed.
  async function repairGaps() {
    const allSetTxids = new Set()
    for (const set of setLedger.sets) {
      for (const txid of set.txids) allSetTxids.add(txid)
    }
    for (const set of setMempool.sets) {
      for (const txid of set.txids) allSetTxids.add(txid)
    }

    const missing = [...allSetTxids].filter(t => !imgLedger.cards[t])
    if (missing.length === 0) return

    console.log(`[repair] Found ${missing.length} CARDIMG tx(s) referenced by CARDSETs but missing from ledger. Fetching from WoC...`)
    for (const txid of missing) {
      try {
        const found = await indexCardimg(txid, null, imgLedger, imgMempool)
        if (found) {
          // Try to get block height from WoC
          const info = await getTxInfo(txid)
          if (info && info.blockheight != null) {
            imgLedger.cards[txid].blockHeight = info.blockheight
          }
          imgLedger.totalImages = Object.keys(imgLedger.cards).length
          imgLedger.totalBytes = Object.values(imgLedger.cards).reduce((s, c) => s + (c.size || 0), 0)
          saveJSON(CARDIMG_LEDGER, imgLedger)
          saveJSON(CARDIMG_MEMPOOL, imgMempool)
        } else {
          console.log(`[repair] ${txid.substring(0, 16)}... — not a CARDIMG or WoC unavailable`)
        }
      } catch (e) {
        console.error(`[repair] Error fetching ${txid.substring(0, 16)}...:`, e.message)
      }
    }
    console.log(`[repair] Done. Ledger now has ${Object.keys(imgLedger.cards).length} cards.`)
  }

  // --- Also repair CARDSETs with null blockHeight ---
  async function repairCardsetBlocks() {
    const nullSets = setLedger.sets.filter(s => s.blockHeight == null)
    if (nullSets.length === 0) return
    console.log(`[repair] Found ${nullSets.length} CARDSET(s) with missing block height. Fetching from WoC...`)
    for (const set of nullSets) {
      try {
        const info = await getTxInfo(set.cardsetTxid)
        if (info && info.blockheight != null) {
          set.blockHeight = info.blockheight
          setLedger.lastBlock = Math.max(setLedger.lastBlock || 0, info.blockheight)
          console.log(`[repair]   ${set.cardsetTxid.substring(0, 16)}... → block ${info.blockheight}`)
        }
      } catch (e) {
        console.error(`[repair] Error fetching CARDSET block ${set.cardsetTxid.substring(0, 16)}...:`, e.message)
      }
    }
    saveJSON(CARDSET_LEDGER, setLedger)
    console.log(`[repair] CARDSET block repair done.`)
  }

  // --- Repair CARDIMGs with null blockHeight ---
  // JungleBus sometimes delivers mempool txs but then misses the
  // confirmed block callback (e.g. websocket drops between mempool
  // and confirmation). This catches those on startup + periodically.
  async function repairCardimgBlocks() {
    const nullTxids = Object.entries(imgLedger.cards)
      .filter(([_, v]) => v.blockHeight == null)
      .map(([k]) => k)
    if (nullTxids.length === 0) return
    console.log(`[repair] Found ${nullTxids.length} CARDIMG tx(s) with missing block height. Fetching from WoC...`)
    for (const txid of nullTxids) {
      try {
        const info = await getTxInfo(txid)
        if (info && info.blockheight != null) {
          imgLedger.cards[txid].blockHeight = info.blockheight
          imgLedger.lastBlock = Math.max(imgLedger.lastBlock || 0, info.blockheight)
          console.log(`[repair]   ${txid.substring(0, 16)}... → block ${info.blockheight}`)
        } else {
          // Also check mempool for stale entries that are actually confirmed
          if (imgMempool.cards[txid]) {
            delete imgMempool.cards[txid]
          }
        }
      } catch (e) {
        console.error(`[repair] Error fetching CARDIMG block ${txid.substring(0, 16)}...:`, e.message)
      }
    }
    // Also clean stale mempool entries (confirmed on chain but still in mempool)
    for (const txid of Object.keys(imgMempool.cards)) {
      try {
        const info = await getTxInfo(txid)
        if (info && info.blockheight != null) {
          if (imgLedger.cards[txid]) {
            imgLedger.cards[txid].blockHeight = info.blockheight
          }
          delete imgMempool.cards[txid]
          console.log(`[repair]   ${txid.substring(0, 16)}... cleaned from mempool (block ${info.blockheight})`)
        }
      } catch (e) {}
    }
    imgLedger.totalImages = Object.keys(imgLedger.cards).length
    imgLedger.totalBytes = Object.values(imgLedger.cards).reduce((s, c) => s + (c.size || 0), 0)
    saveJSON(CARDIMG_LEDGER, imgLedger)
    saveJSON(CARDIMG_MEMPOOL, imgMempool)
    console.log(`[repair] CARDIMG block repair done.`)
  }

  // Run gap repair on startup, then every 5 minutes
  await repairGaps()
  await repairCardsetGaps(setLedger, setMempool)
  await repairCardsetBlocks()
  await repairCardimgBlocks()

  console.log('')
  console.log('Listening for CARDIMG + CARDSET transactions...')
  console.log('(Press Ctrl+C to stop)')

  // Stats + mempool promotion every 60s
  setInterval(() => {
    console.log(`[stats] CARDIMG: ${Object.keys(imgLedger.cards).length} confirmed, ${Object.keys(imgMempool.cards).length} mempool, block ${imgLedger.lastBlock} | CARDSET: ${setLedger.sets.length} confirmed, ${setMempool.sets.length} mempool, block ${setLedger.lastBlock}`)
    if (setMempool.sets.length > 0) {
      promoteCardsetMempool(setLedger, setMempool).catch(e => console.error('Promote error:', e.message))
    }
  }, 60000)

  // Gap repair every 5 minutes
  setInterval(() => {
    repairGaps().catch(e => console.error('[repair] error:', e.message))
    repairCardsetGaps(setLedger, setMempool).catch(e => console.error('[repair] CARDSET gap error:', e.message))
    repairCardsetBlocks().catch(e => console.error('[repair] CARDSET error:', e.message))
    repairCardimgBlocks().catch(e => console.error('[repair] CARDIMG error:', e.message))
  }, 300000)
}

main().catch(e => {
  console.error('Fatal:', e.message)
  process.exit(1)
})
