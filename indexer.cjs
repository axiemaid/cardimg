#!/usr/bin/env node
/**
 * CARDIMG Indexer v3 — JungleBus
 * 
 * Real-time indexing via JungleBus subscription. Listens for CARDIMG
 * transactions across the entire BSV blockchain, not just our wallet.
 * 
 * This is the proper indexer — permissionless, real-time, catches all
 * CARDIMG uploads from anyone, not just our own wallet.
 * 
 * Usage:
 *   node indexer.cjs                    # Start/continue from last block
 *   node indexer.cjs --from <height>    # Start from specific block
 *   node indexer.cjs --status           # Show index status
 *   node indexer.cjs --once             # Single pass, no continuous loop
 * 
 * Env: JB_SUB_ID (JungleBus subscription ID)
 * 
 * Subscription ID: f25086265e0adc867a6a45f51a8f1be63bf79fc19355513543d1c704c461889a
 * (Created at junglebus.gorillapool.io, filters on CARDIMG output prefix)
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

const WoC_API = 'https://api.whatsonchain.com/v1/bsv/main'
const LEDGER_PATH = path.join(__dirname, 'ledger.json')
const MEMPOOL_PATH = path.join(__dirname, 'mempool.json')
const PENDING_PATH = path.join(__dirname, 'pending.json')
const IMAGES_DIR = path.join(__dirname, 'images')
const CARD_SCANS_DIR = '/Users/axiemaid/.openclaw/card-scans'
const LOG_PATH = path.join(__dirname, 'upload-log.json')

const PROTOCOL_PREFIX = 'CARDIMG'
const JB_SUB_ID = process.env.JB_SUB_ID || 'f25086265e0adc867a6a45f51a8f1be63bf79fc19355513543d1c704c461889a'
const START_BLOCK = 957054 // First CARDIMG tx

// --- State ---

function loadLedger() {
  if (fs.existsSync(LEDGER_PATH)) {
    return JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'))
  }
  return { cards: {}, lastBlock: START_BLOCK, totalImages: 0, totalBytes: 0 }
}

function saveLedger(ledger) {
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2))
}

function loadMempool() {
  if (fs.existsSync(MEMPOOL_PATH)) {
    return JSON.parse(fs.readFileSync(MEMPOOL_PATH, 'utf8'))
  }
  return { cards: {}, lastScan: 0 }
}

function saveMempool(mempool) {
  fs.writeFileSync(MEMPOOL_PATH, JSON.stringify(mempool, null, 2))
}

// --- Parsing ---

function parsePushData(buffer, offset) {
  const pushByte = buffer[offset]
  if (pushByte <= 0x4b) {
    return { data: buffer.slice(offset + 1, offset + 1 + pushByte), nextOffset: offset + 1 + pushByte }
  } else if (pushByte === 0x4c) {
    const len = buffer[offset + 1]
    return { data: buffer.slice(offset + 2, offset + 2 + len), nextOffset: offset + 2 + len }
  } else if (pushByte === 0x4d) {
    const len = buffer.readUInt16LE(offset + 1)
    return { data: buffer.slice(offset + 3, offset + 3 + len), nextOffset: offset + 3 + len }
  } else if (pushByte === 0x4e) {
    const len = buffer.readUInt32LE(offset + 1)
    return { data: buffer.slice(offset + 5, offset + 5 + len), nextOffset: offset + 5 + len }
  }
  return null
}

function parseCardImg(txHex) {
  const buf = Buffer.from(txHex, 'hex')
  let pos = 0
  
  while (pos < buf.length - 10) {
    // Look for OP_FALSE OP_RETURN
    if (buf[pos] === 0x00 && buf[pos + 1] === 0x6a) {
      pos += 2
      
      // Parse first pushdata (should be "CARDIMG")
      const prefixPush = parsePushData(buf, pos)
      if (!prefixPush) { pos = 0; break }
      
      if (prefixPush.data.toString('ascii') !== PROTOCOL_PREFIX) { pos++; continue }
      
      // New format: CARDIMG <image_data> (no version byte)
      // The rest of the output data after CARDIMG prefix is the image
      const imagePush = parsePushData(buf, prefixPush.nextOffset)
      if (!imagePush) { pos++; continue }
      
      const imageBuf = imagePush.data
      const hash = crypto.createHash('sha256').update(imageBuf).digest('hex')
      
      return {
        hash,
        image: imageBuf,
        size: imageBuf.length
      }
    }
    pos++
  }
  return null
}

function detectFormat(buffer) {
  if (buffer[0] === 0xFF && buffer[1] === 0xD8) return 'JPEG'
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'PNG'
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer.slice(8, 12).toString('ascii') === 'WEBP') return 'WebP'
  return 'unknown'
}

// --- WoC helpers ---

async function fetchTxHex(txid) {
  const res = await fetch(`${WoC_API}/tx/${txid}/hex`)
  if (!res.ok) throw new Error(`WoC hex error: ${res.status}`)
  return res.text()
}

async function getOpReturn(txid) {
  const res = await fetch(`${WoC_API}/tx/${txid}/opreturn`)
  if (!res.ok) return null
  const data = await res.json()
  return data
}

function parseCardImgFromOpReturn(outputs) {
  for (const out of outputs) {
    const buf = Buffer.from(out.hex, 'hex')
    let pos = 0
    if (buf[pos] !== 0x00) continue
    pos++
    if (buf[pos] !== 0x6a) continue
    pos++
    
    const prefixPush = parsePushData(buf, pos)
    if (!prefixPush) continue
    if (prefixPush.data.toString('ascii') !== PROTOCOL_PREFIX) continue
    
    const imagePush = parsePushData(buf, prefixPush.nextOffset)
    if (!imagePush) continue
    
    const hash = crypto.createHash('sha256').update(imagePush.data).digest('hex')
    return { hash, image: imagePush.data, size: imagePush.data.length }
  }
  return null
}

// --- Indexing ---

function cacheImage(hash, imageBuf) {
  fs.mkdirSync(IMAGES_DIR, { recursive: true })
  const imgPath = path.join(IMAGES_DIR, `${hash}.bin`)
  if (!fs.existsSync(imgPath)) {
    fs.writeFileSync(imgPath, imageBuf)
  }
}

function appendLog(entry) {
  let log = []
  if (fs.existsSync(LOG_PATH)) log = JSON.parse(fs.readFileSync(LOG_PATH, 'utf8'))
  // Check if this txid is already logged
  if (log.some(e => e.txid === entry.txid)) return null
  const n = log.length > 0 ? Math.max(...log.map(e => e.n || 0)) + 1 : 1
  log.push({ n, ...entry })
  fs.writeFileSync(LOG_PATH, JSON.stringify(log, null, 2))
  if (fs.existsSync(CARD_SCANS_DIR)) {
    fs.copyFileSync(LOG_PATH, path.join(CARD_SCANS_DIR, 'upload-log.json'))
  }
  return n
}

async function indexTx(txid, blockHeight, ledger, mempool) {
  const cleanTxid = txid.replace(/["]/g, '').trim()
  
  // Skip if already in ledger
  for (const card of Object.values(ledger.cards)) {
    if (card.txid === cleanTxid) return false
  }
  
  // Fetch OP_RETURN data (lighter than full tx hex)
  const opReturns = await getOpReturn(cleanTxid)
  if (!opReturns || opReturns.length === 0) return false
  
  const card = parseCardImgFromOpReturn(opReturns)
  if (!card) return false
  
  // Cache image
  cacheImage(card.hash, card.image)
  
  // Add to ledger
  ledger.cards[card.hash] = {
    txid: cleanTxid,
    blockHeight: blockHeight || null,
    size: card.size
  }
  ledger.totalImages++
  ledger.totalBytes += card.size
  
  // Remove from mempool if present
  delete mempool.cards[card.hash]
  
  // Append to log
  const logN = appendLog({
    file: `junglebus-${cleanTxid.substring(0, 8)}.bin`,
    format: detectFormat(card.image),
    sizeBytes: card.size,
    sha256: card.hash,
    txid: cleanTxid,
    blockHeight: blockHeight || null,
    confirmed: !!blockHeight,
    uploadedAt: new Date().toISOString().split('T')[0],
    sourceFile: 'JungleBus index',
    card: undefined,
    notes: 'Found via JungleBus subscription'
  })
  
  console.log(`  ✓ ${cleanTxid.substring(0, 16)}... | ${(card.size / 1024).toFixed(0)}KB | ${detectFormat(card.image)} | hash: ${card.hash.substring(0, 16)}...${logN ? ' (log #' + logN + ')' : ''}`)
  return true
}

// --- JungleBus ---

async function startJungleBus(ledger, mempool, fromBlock) {
  console.log('Connecting to JungleBus...')
  console.log('Subscription:', JB_SUB_ID)
  console.log('From block:', fromBlock)
  console.log('')
  
  const jungle = new JungleBusClient('junglebus.gorillapool.io', {
    onConnected() { console.log('[junglebus] connected') },
    onConnecting() { console.log('[junglebus] connecting...') },
    onDisconnected() { console.log('[junglebus] disconnected') },
    onError(ctx) { console.error('[junglebus] error:', ctx) }
  })
  
  const onPublish = (tx) => {
    // Fire async without blocking the callback
    indexTx(tx.id, tx.block_height, ledger, mempool)
      .then(found => {
        if (found) {
          ledger.lastBlock = Math.max(ledger.lastBlock || 0, tx.block_height)
          saveLedger(ledger)
          saveMempool(mempool)
        }
      })
      .catch(e => console.error(`Error indexing ${tx.id}:`, e.message))
  }
  
  const onMempool = async (tx) => {
    try {
      // For mempool txs, fetch and parse but don't add to ledger yet
      const opReturns = await getOpReturn(tx.id)
      if (!opReturns || opReturns.length === 0) return
      
      const card = parseCardImgFromOpReturn(opReturns)
      if (!card) return
      
      cacheImage(card.hash, card.image)
      mempool.cards[card.hash] = { txid: tx.id, size: card.size, blockHeight: null }
      mempool.lastScan = Date.now()
      saveMempool(mempool)
      
      console.log(`  [mempool] ${tx.id.substring(0, 16)}... | ${(card.size / 1024).toFixed(0)}KB | ${detectFormat(card.image)}`)
    } catch (e) {
      console.error(`Mempool error ${tx.id}:`, e.message)
    }
  }
  
  const onStatus = (ctx) => {
    if (ctx.statusCode === 200) {
      ledger.lastBlock = ctx.block || ledger.lastBlock
      saveLedger(ledger)
    }
  }
  
  const onError = (ctx) => {
    console.error('[junglebus] subscribe error:', ctx)
  }
  
  await jungle.Subscribe(JB_SUB_ID, fromBlock, onPublish, onStatus, onError, onMempool)
  
  return jungle
}

// --- Status ---

function showStatus(ledger, mempool) {
  console.log('')
  console.log('=== CARDIMG Index Status ===')
  console.log(`Confirmed images: ${ledger.totalImages}`)
  console.log(`Total bytes:       ${(ledger.totalBytes / 1024 / 1024).toFixed(1)}MB`)
  console.log(`Last block:        ${ledger.lastBlock}`)
  console.log(`Mempool pending:   ${Object.keys(mempool.cards).length}`)
  console.log('')
  console.log('Images:')
  for (const [hash, card] of Object.entries(ledger.cards)) {
    const cached = fs.existsSync(path.join(IMAGES_DIR, `${hash}.bin`)) ? '✓' : '✗'
    console.log(`  ${hash.substring(0, 16)}... | ${card.txid.substring(0, 16)}... | block ${card.blockHeight} | ${(card.size / 1024).toFixed(0)}KB | cached: ${cached}`)
  }
}

// --- Main ---

async function main() {
  const args = process.argv.slice(2)
  const statusOnly = args.includes('--status')
  const fromArg = args.indexOf('--from')
  const fromBlock = fromArg >= 0 ? parseInt(args[fromArg + 1]) : null
  const once = args.includes('--once')
  
  const ledger = loadLedger()
  const mempool = loadMempool()
  
  if (statusOnly) {
    showStatus(ledger, mempool)
    process.exit(0)
  }
  
  const start = fromBlock || ledger.lastBlock || START_BLOCK
  
  console.log('CARDIMG Indexer v3 — JungleBus')
  console.log(`Ledger: ${ledger.totalImages} images, ${(ledger.totalBytes / 1024 / 1024).toFixed(1)}MB`)
  console.log(`Mempool: ${Object.keys(mempool.cards).length} pending`)
  console.log('')
  
  const jungle = await startJungleBus(ledger, mempool, start)
  
  if (once) {
    // Wait a bit for initial catch-up then exit
    console.log('Waiting for initial sync...')
    await new Promise(r => setTimeout(r, 10000))
    console.log('Done.')
    process.exit(0)
  }
  
  // Keep running
  console.log('Listening for CARDIMG transactions...')
  console.log('(Press Ctrl+C to stop)')
  
  // Stats every minute
  setInterval(() => {
    console.log(`[stats] ${ledger.totalImages} images, ${(ledger.totalBytes / 1024 / 1024).toFixed(1)}MB, lastBlock=${ledger.lastBlock}, mempool=${Object.keys(mempool.cards).length}`)
  }, 60000)
}

main().catch(e => {
  console.error('Fatal:', e.message)
  process.exit(1)
})
