#!/usr/bin/env node
/**
 * CARDIMG Upload Tool
 * 
 * Minimal uploader: prefix + image bytes, nothing else.
 * 
 * Usage:
 *   node upload.cjs <image_path>
 *   node upload.cjs card.png --tx    (show TX hex without broadcasting)
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const bsv = require('bsv')

const PROTOCOL_PREFIX = Buffer.from('CARDIMG')
const SATS_PER_BYTE = 0.5
const WALLET_PATH = path.join(process.env.HOME || '/root', '.openclaw', 'bsv-wallet.json')
const WoC_API = 'https://api.whatsonchain.com/v1/bsv/main'

function loadWallet() {
  if (!fs.existsSync(WALLET_PATH)) {
    console.error('Wallet not found:', WALLET_PATH)
    console.error('Run: bsv wallet create')
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
  
  // Add inputs
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
  
  // Build OP_RETURN: CARDIMG + image
  const script = bsv.Script.buildSafeDataOut([PROTOCOL_PREFIX, imageBuf])
  
  // Calculate fee (approx: overhead ~20 bytes + image size)
  const fee = Math.ceil((20 + imageBuf.length) * SATS_PER_BYTE)
  
  // Add outputs
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
  if (!res.ok) throw new Error(`WoC error: ${res.status}`)
  const data = await res.json()
  return data
    .filter(u => u.value > 1000)
    .sort((a, b) => a.value - b.value)
    .map(u => ({ txid: u.tx_hash, vout: u.tx_pos, satoshis: u.value }))
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

async function main() {
  const args = process.argv.slice(2)
  const imgPath = args.find(a => !a.startsWith('--'))
  const dryRun = args.includes('--tx')
  
  if (!imgPath) {
    console.log('Usage: node upload.cjs <image_path> [--tx]')
    process.exit(1)
  }
  
  if (!fs.existsSync(imgPath)) {
    console.error('File not found:', imgPath)
    process.exit(1)
  }
  
  // Load wallet
  const wallet = loadWallet()
  console.log('Wallet:', wallet.addr.toString())
  
  // Load image
  const imageBuf = fs.readFileSync(imgPath)
  const hash = crypto.createHash('sha256').update(imageBuf).digest('hex')
  console.log('Image:', `${(imageBuf.length / 1024).toFixed(1)}KB`)
  console.log('Hash:', hash)
  
  // Get UTXOs
  console.log('\nFetching UTXOs...')
  const utxos = await getUtxos(wallet.addr.toString())
  console.log('Found', utxos.length, 'UTXOs')
  
  if (utxos.length === 0) {
    console.error('No UTXOs. Fund wallet first.')
    process.exit(1)
  }
  
  // Build TX
  const { tx, fee, change } = buildTx(imageBuf, wallet, utxos)
  console.log('Fee:', fee, 'sats', `(~$${(fee / 1e8 * 40).toFixed(4)})`)
  
  if (dryRun) {
    console.log('\n--- TX HEX ---')
    console.log(tx.serialize())
    process.exit(0)
  }
  
  // Broadcast
  console.log('\nBroadcasting...')
  const txid = await broadcast(tx.serialize())
  
  // Track pending transaction
  const pendingPath = path.join(__dirname, 'pending.json')
  let pending = []
  if (fs.existsSync(pendingPath)) {
    pending = JSON.parse(fs.readFileSync(pendingPath, 'utf8'))
  }
  pending.push({ txid, hash, size: imageBuf.length, uploadedAt: Date.now() })
  fs.writeFileSync(pendingPath, JSON.stringify(pending, null, 2))
  
  // Also save image to cache immediately for zero-conf display
  const imgCachePath = path.join(__dirname, 'images', `${hash}.bin`)
  fs.mkdirSync(path.dirname(imgCachePath), { recursive: true })
  fs.writeFileSync(imgCachePath, imageBuf)
  
  // Update mempool cache
  const mempoolPath = path.join(__dirname, 'mempool.json')
  let mempool = { cards: {}, lastScan: 0 }
  if (fs.existsSync(mempoolPath)) {
    mempool = JSON.parse(fs.readFileSync(mempoolPath, 'utf8'))
  }
  mempool.cards[hash] = { txid, size: imageBuf.length, blockHeight: null }
  mempool.lastScan = Date.now()
  fs.writeFileSync(mempoolPath, JSON.stringify(mempool, null, 2))
  
  console.log('\n✓ Uploaded!')
  console.log('TXID:', txid)
  console.log('Hash:', hash)
  console.log('View:', `https://whatsonchain.com/tx/${txid}`)
  console.log('(Zero-conf: will appear in viewer immediately)')
}

main().catch(e => {
  console.error('Error:', e.message)
  process.exit(1)
})