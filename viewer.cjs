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
const PENDING_PATH = path.join(__dirname, 'pending.json')
const IMAGES_DIR = path.join(__dirname, 'images')
const PROTOCOL_PREFIX = Buffer.from('CARDIMG')
const SATS_PER_BYTE = 0.5
const WALLET_PATH = path.join(process.env.HOME || '/root', '.openclaw', 'bsv-wallet.json')
const WoC_API = 'https://api.whatsonchain.com/v1/bsv/main'

const bsv = require('bsv')
const crypto = require('crypto')

// Multer for file uploads
const multer = require('multer')
const upload = multer({ storage: multer.memoryStorage() })

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

// Load pending transactions
function loadPending() {
  if (!fs.existsSync(PENDING_PATH)) return []
  return JSON.parse(fs.readFileSync(PENDING_PATH, 'utf8'))
}

function savePending(pending) {
  fs.writeFileSync(PENDING_PATH, JSON.stringify(pending, null, 2))
}

// Wallet functions
function loadWallet() {
  if (!fs.existsSync(WALLET_PATH)) {
    return null
  }
  const data = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf8'))
  return {
    priv: bsv.PrivateKey.fromWIF(data.wif),
    addr: bsv.Address.fromString(data.address)
  }
}

async function getUtxos(addr) {
  const res = await fetch(`${WoC_API}/address/${addr}/unspent`)
  if (!res.ok) throw new Error(`WoC error: ${res.status}`)
  const data = await res.json()
  return data
    .filter(u => u.value > 1000)
    .sort((a, b) => a.value - b.value)
    .map(u => ({ txid: u.tx_hash, vout: u.tx_pos, satoshis: u.value }))
}

function buildTx(imageBuf, wallet, utxos) {
  const tx = new bsv.Transaction()
  
  let inputSats = 0
  for (const u of utxos) {
    tx.from({
      txId: u.txid,
      outputIndex: u.vout,
      script: bsv.Script.buildPublicKeyHashOut(wallet.addr).toHex(),
      satoshis: u.satoshis
    })
    inputSats += u.satoshis
  }
  
  const script = bsv.Script.buildSafeDataOut([PROTOCOL_PREFIX, imageBuf])
  const fee = Math.ceil((20 + imageBuf.length) * SATS_PER_BYTE)
  
  tx.addOutput(new bsv.Transaction.Output({ script, satoshis: 0 }))
  
  const change = inputSats - fee
  if (change < 0) throw new Error(`Insufficient funds: need ${fee} sats, have ${inputSats}`)
  if (change > 546) tx.change(wallet.addr)
  
  tx.sign(wallet.priv)
  return { tx, fee }
}

async function broadcast(txHex) {
  const res = await fetch(`${WoC_API}/tx/raw`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txhex: txHex })
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Broadcast failed: ${res.status} - ${text}`)
  }
  return res.text()
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

// Upload endpoint
app.post('/upload', upload.single('image'), async (req, res) => {
  try {
    const wallet = loadWallet()
    if (!wallet) {
      return res.status(500).json({ error: 'Wallet not found at ~/.openclaw/bsv-wallet.json' })
    }
    
    if (!req.file) {
      return res.status(400).json({ error: 'No image uploaded' })
    }
    
    const imageBuf = req.file.buffer
    const hash = crypto.createHash('sha256').update(imageBuf).digest('hex')
    
    // Check if already uploaded
    const ledger = loadLedger()
    const mempool = loadMempool()
    if (ledger.cards[hash] || mempool.cards[hash]) {
      return res.status(400).json({ error: 'Image already uploaded', hash })
    }
    
    // Get UTXOs and build TX
    const utxos = await getUtxos(wallet.addr.toString())
    const { tx, fee } = buildTx(imageBuf, wallet, utxos)
    
    // Broadcast
    const txid = await broadcast(tx.serialize())
    
    // Save image cache
    fs.mkdirSync(IMAGES_DIR, { recursive: true })
    fs.writeFileSync(path.join(IMAGES_DIR, `${hash}.bin`), imageBuf)
    
    // Track pending
    const pending = loadPending()
    pending.push({ txid, hash, size: imageBuf.length, uploadedAt: Date.now() })
    savePending(pending)
    
    // Update mempool
    mempool.cards[hash] = { txid, size: imageBuf.length, blockHeight: null }
    mempool.lastScan = Date.now()
    fs.writeFileSync(MEMPOOL_PATH, JSON.stringify(mempool, null, 2))
    
    res.json({ success: true, txid, hash, size: imageBuf.length, fee })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// HTML viewer
app.get('/', (req, res) => {
  const ledger = loadLedger()
  const mempool = loadMempool()
  const wallet = loadWallet()
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
    .upload-box { background: #2a2a2a; padding: 15px; border-radius: 8px; margin-bottom: 20px; }
    .upload-box input[type=file] { margin-right: 10px; }
    .upload-box button { background: #4a4; color: #fff; padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer; }
    .upload-box button:hover { background: #5b5; }
    .upload-box button:disabled { background: #666; cursor: not-allowed; }
    .upload-box .status { margin-top: 10px; font-size: 12px; }
    .upload-box .success { color: #4a4; }
    .upload-box .error { color: #f66; }
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
  
  ${wallet ? `
  <div class="upload-box">
    <form id="uploadForm" enctype="multipart/form-data">
      <input type="file" name="image" accept="image/*" required>
      <button type="submit">Upload to BSV</button>
    </form>
    <div id="uploadStatus" class="status"></div>
    <div class="status" style="color: #888;">Wallet: ${wallet.addr.toString()}</div>
  </div>
  ` : '<div class="upload-box error">Wallet not found at ~/.openclaw/bsv-wallet.json</div>'}
  
  ${(confirmedCards.length + mempoolCards.length) === 0 ? '<div class="empty">No images indexed yet. Upload an image above.</div>' : `
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
  
  <script>
    document.getElementById('uploadForm')?.addEventListener('submit', async (e) => {
      e.preventDefault()
      const form = e.target
      const status = document.getElementById('uploadStatus')
      const button = form.querySelector('button')
      
      button.disabled = true
      status.className = 'status'
      status.textContent = 'Uploading...'
      
      try {
        const formData = new FormData(form)
        const res = await fetch('/upload', { method: 'POST', body: formData })
        const data = await res.json()
        
        if (data.success) {
          status.className = 'status success'
          status.textContent = '✓ Uploaded! TXID: ' + data.txid + ' (' + (data.size/1024).toFixed(1) + 'KB, ' + data.fee + ' sats)'
          form.reset()
          // Reload page after 1s to show new card
          setTimeout(() => location.reload(), 1000)
        } else {
          status.className = 'status error'
          status.textContent = '✗ ' + data.error
        }
      } catch (err) {
        status.className = 'status error'
        status.textContent = '✗ ' + err.message
      }
      
      button.disabled = false
    })
  </script>
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