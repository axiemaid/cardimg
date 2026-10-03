#!/usr/bin/env node
/**
 * CARDIMG Batch Uploader
 * 
 * Uploads multiple images sequentially, handling UTXO chaining.
 * Fetches fresh UTXOs after each upload (zero-conf chaining).
 * 
 * Usage:
 *   node batch-upload.cjs <dir> [file1.png file2.png ...]
 *   node batch-upload.cjs /path/to/scans
 *   node batch-upload.cjs /path/to/scans Scan.png Scan\ 0.png
 *   node batch-upload.cjs /path/to/scans --dry-run  (show costs, don't broadcast)
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const bsv = require('bsv')

const PROTOCOL_PREFIX = Buffer.from('CARDIMG')
const SATS_PER_BYTE = 0.5
const WALLET_PATH = path.join(process.env.HOME || '/root', '.openclaw', 'bsv-wallet.json')
const WoC_API = 'https://api.whatsonchain.com/v1/bsv/main'
const LEDGER_PATH = path.join(__dirname, 'ledger.json')
const MEMPOOL_PATH = path.join(__dirname, 'mempool.json')
const PENDING_PATH = path.join(__dirname, 'pending.json')
const IMAGES_DIR = path.join(__dirname, 'images')
const LOG_PATH = path.join(__dirname, 'upload-log.json')
const CARD_SCANS_DIR = '/Users/axiemaid/.openclaw/card-scans'
const LOG_COPY_PATH = path.join(CARD_SCANS_DIR, 'upload-log.json')

function appendLog(entry) {
  let log = []
  if (fs.existsSync(LOG_PATH)) log = JSON.parse(fs.readFileSync(LOG_PATH, 'utf8'))
  const n = log.length > 0 ? Math.max(...log.map(e => e.n || 0)) + 1 : 1
  log.push({ n, ...entry })
  fs.writeFileSync(LOG_PATH, JSON.stringify(log, null, 2))
  // Copy to card-scans folder
  if (fs.existsSync(CARD_SCANS_DIR)) {
    fs.mkdirSync(CARD_SCANS_DIR, { recursive: true })
    fs.copyFileSync(LOG_PATH, LOG_COPY_PATH)
  }
  return n
}

function loadWallet() {
  if (!fs.existsSync(WALLET_PATH)) {
    console.error('Wallet not found:', WALLET_PATH)
    process.exit(1)
  }
  const data = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf8'))
  return {
    priv: bsv.PrivateKey.fromWIF(data.wif),
    addr: bsv.Address.fromString(data.address)
  }
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
  if (change < 0) {
    console.error(`Insufficient funds: need ${fee} sats, have ${inputSats} sats`)
    process.exit(1)
  }
  if (change > 546) tx.change(wallet.addr)
  tx.sign(wallet.priv)
  return { tx, fee, change }
}

async function getUtxos(addr) {
  const res = await fetch(`${WoC_API}/address/${addr}/unspent`)
  if (!res.ok) throw new Error(`WoC UTXO error: ${res.status}`)
  const data = await res.json()
  return data
    .filter(u => u.value > 1000)
    .sort((a, b) => a.value - b.value)
    .map(u => ({ txid: u.tx_hash, vout: u.tx_pos, satoshis: u.value }))
}

// Pick one appropriately-sized UTXO for a card upload (~3M+ sats)
async function getSingleUtxo(addr, minSats) {
  const res = await fetch(`${WoC_API}/address/${addr}/unspent`)
  if (!res.ok) throw new Error(`WoC UTXO error: ${res.status}`)
  const data = await res.json()
  // Prefer smallest UTXO that covers the fee, so we don't consume large UTXOs
  const suitable = data
    .filter(u => u.value >= minSats)
    .sort((a, b) => a.value - b.value)
  if (suitable.length === 0) return null
  return { txid: suitable[0].tx_hash, vout: suitable[0].tx_pos, satoshis: suitable[0].value }
}

async function getMempoolUtxos(addr) {
  // WoC unspent endpoint includes mempool outputs
  return getUtxos(addr)
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

function trackPending(txid, hash, size) {
  let pending = []
  if (fs.existsSync(PENDING_PATH)) pending = JSON.parse(fs.readFileSync(PENDING_PATH, 'utf8'))
  pending.push({ txid, hash, size, uploadedAt: Date.now() })
  fs.writeFileSync(PENDING_PATH, JSON.stringify(pending, null, 2))
}

function cacheImage(hash, imageBuf) {
  fs.mkdirSync(IMAGES_DIR, { recursive: true })
  fs.writeFileSync(path.join(IMAGES_DIR, `${hash}.bin`), imageBuf)
}

function updateMempool(hash, txid, size) {
  let mempool = { cards: {}, lastScan: 0 }
  if (fs.existsSync(MEMPOOL_PATH)) mempool = JSON.parse(fs.readFileSync(MEMPOOL_PATH, 'utf8'))
  mempool.cards[hash] = { txid, size, blockHeight: null }
  mempool.lastScan = Date.now()
  fs.writeFileSync(MEMPOOL_PATH, JSON.stringify(mempool, null, 2))
}

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const dir = args.find(a => !a.startsWith('--'))
  
  if (!dir) {
    console.log('Usage: node batch-upload.cjs <dir> [files...] [--dry-run]')
    process.exit(1)
  }
  
  // Collect files
  let files = args.filter(a => !a.startsWith('--') && a !== dir)
  if (files.length === 0) {
    files = fs.readdirSync(dir)
      .filter(f => /\.(png|jpg|jpeg|webp|gif)$/i.test(f))
      .sort()
  }
  
  // Resolve full paths
  const fullPaths = files.map(f => {
    const fp = path.isAbsolute(f) ? f : path.join(dir, f)
    if (!fs.existsSync(fp)) {
      console.error(`File not found: ${fp}`)
      process.exit(1)
    }
    return fp
  })
  
  const wallet = loadWallet()
  console.log(`Wallet: ${wallet.addr.toString()}`)
  console.log(`Files: ${fullPaths.length}`)
  console.log('')
  
  // Dry run: show costs only
  if (dryRun) {
    let totalFee = 0
    for (const fp of fullPaths) {
      const buf = fs.readFileSync(fp)
      const hash = crypto.createHash('sha256').update(buf).digest('hex')
      const fee = Math.ceil((20 + buf.length) * SATS_PER_BYTE)
      totalFee += fee
      console.log(`  ${path.basename(fp)}: ${(buf.length/1024).toFixed(0)}KB | fee: ${fee.toLocaleString()} sats | hash: ${hash.substring(0,16)}...`)
    }
    console.log(`\nTotal fees: ${totalFee.toLocaleString()} sats (~$${(totalFee / 1e8 * 40).toFixed(2)})`)
    process.exit(0)
  }
  
  // Sequential upload
  let uploaded = 0
  for (const fp of fullPaths) {
    const name = path.basename(fp)
    const imageBuf = fs.readFileSync(fp)
    const hash = crypto.createHash('sha256').update(imageBuf).digest('hex')
    
    console.log(`[${uploaded + 1}/${fullPaths.length}] ${name} (${(imageBuf.length/1024).toFixed(0)}KB)`)
    
    // Pick one UTXO that covers the fee (~3M sats for a 6MB image)
    const estFee = Math.ceil((20 + imageBuf.length) * SATS_PER_BYTE)
    console.log('  Fetching UTXO...')
    let utxo = await getSingleUtxo(wallet.addr.toString(), estFee)
    
    if (!utxo) {
      console.error('  ✗ No suitable UTXO — waiting for propagation...')
      await new Promise(r => setTimeout(r, 5000))
      utxo = await getSingleUtxo(wallet.addr.toString(), estFee)
      if (!utxo) {
        console.error('  ✗ Still no suitable UTXO. Stopping.')
        break
      }
    }
    console.log(`  Using UTXO: ${utxo.txid.substring(0,16)}...:${utxo.vout} (${utxo.satoshis.toLocaleString()} sats)`)
    
    const { tx, fee } = buildTx(imageBuf, wallet, [utxo])
    console.log(`  Fee: ${fee.toLocaleString()} sats`)
    
    console.log('  Broadcasting...')
    const rawTxid = await broadcast(tx.serialize())
  const txid = rawTxid.replace(/["]/g,'').trim()
    
    // Track
    trackPending(txid, hash, imageBuf.length)
    cacheImage(hash, imageBuf)
    updateMempool(hash, txid, imageBuf.length)
    const logN = appendLog({
      file: name,
      format: name.match(/\.(png|jpg|jpeg|webp|gif)$/i)?.[1]?.toUpperCase() || 'UNK',
      sizeBytes: imageBuf.length,
      sha256: hash,
      txid,
      blockHeight: null,
      confirmed: false,
      uploadedAt: new Date().toISOString().split('T')[0],
      sourceFile: undefined,
      card: undefined,
      notes: undefined
    })
    
    console.log(`  ✓ #${logN} TXID: ${txid}`)
    console.log(`  Hash: ${hash}`)
    console.log(`  WoC: https://whatsonchain.com/tx/${txid}`)
    console.log('')
    
    uploaded++
  }
  
  console.log(`Done! ${uploaded}/${fullPaths.length} images uploaded.`)
  console.log(`Viewer: http://localhost:3013 (run: node viewer.cjs)`)
}

main().catch(e => {
  console.error('Error:', e.message)
  process.exit(1)
})
