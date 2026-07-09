#!/usr/bin/env node
/**
 * CARDIMG Viewer
 * 
 * Simple web viewer for indexed card images.
 * 
 * Usage:
 *   node viewer.cjs
 *   open http://localhost:3013
 */

const fs = require('fs')
const path = require('path')
const express = require('express')

const app = express()
const PORT = 3013
const LEDGER_PATH = path.join(__dirname, 'ledger.json')
const MEMPOOL_PATH = path.join(__dirname, 'mempool.json')
const IMAGES_DIR = path.join(__dirname, 'images')

// Load ledger
function loadLedger() {
  if (!fs.existsSync(LEDGER_PATH)) {
    return { cards: {}, totalImages: 0, totalBytes: 0 }
  }
  return JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'))
}

// Load mempool (zero-conf cards)
function loadMempool() {
  if (!fs.existsSync(MEMPOOL_PATH)) {
    return { cards: {}, lastScan: 0 }
  }
  return JSON.parse(fs.readFileSync(MEMPOOL_PATH, 'utf8'))
}

// API: list all cards (confirmed + mempool)
app.get('/cards', (req, res) => {
  const ledger = loadLedger()
  const mempool = loadMempool()
  // Merge: mempool cards override if same hash (shouldn't happen normally)
  const allCards = { ...mempool.cards, ...ledger.cards }
  res.json(allCards)
})

// API: get card metadata
app.get('/cards/:hash', (req, res) => {
  const ledger = loadLedger()
  const card = ledger.cards[req.params.hash]
  if (!card) return res.status(404).json({ error: 'Not found' })
  res.json(card)
})

// API: get card image
app.get('/cards/:hash/image', (req, res) => {
  const imgPath = path.join(IMAGES_DIR, `${req.params.hash}.bin`)
  if (!fs.existsSync(imgPath)) {
    return res.status(404).json({ error: 'Image not found' })
  }
  
  // Serve raw bytes - let browser detect format
  const buf = fs.readFileSync(imgPath)
  res.setHeader('Content-Type', 'application/octet-stream')
  res.send(buf)
})

// API: stats
app.get('/stats', (req, res) => {
  const ledger = loadLedger()
  const mempool = loadMempool()
  res.json({
    confirmed: ledger.totalImages,
    mempool: Object.keys(mempool.cards).length,
    totalImages: ledger.totalImages + Object.keys(mempool.cards).length,
    totalBytes: ledger.totalBytes,
    lastBlock: ledger.lastBlock
  })
})

// HTML viewer
app.get('/', (req, res) => {
  const ledger = loadLedger()
  const mempool = loadMempool()
  const confirmedCards = Object.entries(ledger.cards)
  const mempoolCards = Object.entries(mempool.cards)
  
  const html = `
<!DOCTYPE html>
<html>
<head>
  <title>CARDIMG Viewer</title>
  <style>
    body { font-family: system-ui; max-width: 1200px; margin: 0 auto; padding: 20px; background: #1a1a1a; color: #eee; }
    h1 { color: #fff; }
    .stats { background: #2a2a2a; padding: 15px; border-radius: 8px; margin-bottom: 20px; }
    .stats .zero-conf { color: #ffa; font-size: 12px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 15px; }
    .card { background: #2a2a2a; padding: 10px; border-radius: 8px; }
    .card.zero-conf { border: 2px solid #ffa; }
    .card img { width: 100%; border-radius: 4px; background: #333; }
    .card .meta { margin-top: 8px; font-size: 12px; color: #888; }
    .card .hash { font-family: monospace; color: #6af; }
    .card .zero-badge { color: #ffa; font-weight: bold; }
    .empty { text-align: center; padding: 40px; color: #888; }
  </style>
</head>
<body>
  <h1>CARDIMG</h1>
  <div class="stats">
    <strong>${ledger.totalImages}</strong> confirmed | 
    <strong>${mempoolCards.length}</strong> in mempool (zero-conf) |
    <strong>${(ledger.totalBytes / 1024 / 1024).toFixed(2)}</strong> MB total | 
    Last block: <strong>${ledger.lastBlock || 'none'}</strong>
    ${mempoolCards.length > 0 ? '<span class="zero-conf"> (showing unconfirmed uploads)</span>' : ''}
  </div>
  
  ${(confirmedCards.length + mempoolCards.length) === 0 ? '<div class="empty">No images indexed yet. Upload an image: node upload.cjs <image></div>' : `
  <div class="grid">
    ${mempoolCards.map(([hash, meta]) => `
      <div class="card zero-conf">
        <img src="/cards/${hash}/image" alt="${hash}">
        <div class="meta">
          <div class="hash">${hash.slice(0, 16)}...</div>
          <div class="zero-badge">⚡ ZERO-CONF</div>
          <div>${(meta.size / 1024).toFixed(1)}KB | TXID: ${meta.txid.slice(0, 8)}...</div>
        </div>
      </div>
    `).join('')}
    ${confirmedCards.map(([hash, meta]) => `
      <div class="card">
        <img src="/cards/${hash}/image" alt="${hash}">
        <div class="meta">
          <div class="hash">${hash.slice(0, 16)}...</div>
          <div>${(meta.size / 1024).toFixed(1)}KB | Block ${meta.blockHeight}</div>
        </div>
      </div>
    `).join('')}
  </div>
  `}
</body>
</html>
`
  res.setHeader('Content-Type', 'text/html')
  res.send(html)
})

app.listen(PORT, () => {
  console.log('CARDIMG Viewer running at http://localhost:' + PORT)
  console.log('API endpoints:')
  console.log('  GET /cards          - list all cards')
  console.log('  GET /cards/:hash    - card metadata')
  console.log('  GET /cards/:hash/image - raw image')
  console.log('  GET /stats          - index stats')
})