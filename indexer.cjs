#!/usr/bin/env node
/**
 * CARDIMG Indexer
 * 
 * Scans BSV blockchain for CARDIMG transactions, builds local ledger.
 * Uses WhatsOnChain API.
 * 
 * Usage:
 *   node indexer.cjs            (continuous scan from last known block)
 *   node indexer.cjs --from N   (start from block N)
 *   node indexer.cjs --once     (single scan, then exit)
 *   node indexer.cjs --mempool  (scan mempool only, then exit)
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const WoC_API = 'https://api.whatsonchain.com/v1/bsv/main'
const LEDGER_PATH = path.join(__dirname, 'ledger.json')
const MEMPOOL_PATH = path.join(__dirname, 'mempool.json')
const PROTOCOL_PREFIX = 'CARDIMG'
const SCAN_DELAY = 10000 // 10 seconds between scans
const MEMPOOL_SCAN_DELAY = 30000 // 30 seconds for mempool rescans

// Initialize ledger
function loadLedger() {
  if (fs.existsSync(LEDGER_PATH)) {
    return JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'))
  }
  return {
    cards: {},
    lastBlock: 0,
    totalImages: 0,
    totalBytes: 0
  }
}

function saveLedger(ledger) {
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2))
}

// Mempool cache (zero-conf cards)
function loadMempool() {
  if (fs.existsSync(MEMPOOL_PATH)) {
    return JSON.parse(fs.readFileSync(MEMPOOL_PATH, 'utf8'))
  }
  return { cards: {}, lastScan: 0 }
}

function saveMempool(mempool) {
  fs.writeFileSync(MEMPOOL_PATH, JSON.stringify(mempool, null, 2))
}

// Get current chain height
async function getHeight() {
  const res = await fetch(`${WoC_API}/block/headers?limit=1`)
  if (!res.ok) throw new Error(`WoC error: ${res.status}`)
  const data = await res.json()
  return data[0].height
}

// Get block transactions (using correct WoC API)
async function getBlockTxs(height) {
  const res = await fetch(`${WoC_API}/block/height/${height}`)
  if (!res.ok) throw new Error(`WoC block error: ${res.status}`)
  const data = await res.json()
  // Returns { tx: [...], ... } - extract txids
  return (data.tx || []).map(txid => ({ txid }))
}

// Get mempool transactions for an address
async function getMempoolTxs(address) {
  const res = await fetch(`${WoC_API}/address/${address}/unspent`)
  if (!res.ok) return []
  const data = await res.json()
  // This gives UTXOs, but we need to scan differently
  // Instead, we'll scan recent broadcast txs or use a different approach
  return []
}

// Get raw transaction hex
async function getTxHex(txid) {
  const res = await fetch(`${WoC_API}/tx/${txid}/hex`)
  if (!res.ok) throw new Error(`WoC tx error: ${res.status}`)
  return res.text()
}

// Get tx status (to check if confirmed)
async function getTxStatus(txid) {
  const res = await fetch(`${WoC_API}/tx/${txid}`)
  if (!res.ok) return null
  return res.json()
}

// Parse OP_RETURN from raw tx hex
function parseCardImg(txHex) {
  // Parse transaction outputs
  // Looking for: OP_FALSE OP_RETURN "CARDIMG" <image_data>
  try {
    const buf = Buffer.from(txHex, 'hex')
    
    // Skip to outputs section (simplified parsing)
    // Find OP_RETURN pattern: 0x00 0x6a (OP_FALSE OP_RETURN)
    let pos = 0
    while (pos < buf.length - 10) {
      // Look for OP_FALSE (0x00) followed by OP_RETURN (0x6a)
      if (buf[pos] === 0x00 && buf[pos + 1] === 0x6a) {
        // Next byte(s) are pushdata for CARDIMG prefix
        pos += 2
        
        // Parse pushdata (could be OP_PUSHDATA1, OP_PUSHDATA2, or direct push)
        let dataStart = pos
        let dataLen = 0
        
        if (buf[pos] <= 0x4b) {
          // Direct push (1-75 bytes)
          dataLen = buf[pos]
          dataStart = pos + 1
        } else if (buf[pos] === 0x4c) {
          // OP_PUSHDATA1
          dataLen = buf[pos + 1]
          dataStart = pos + 2
        } else if (buf[pos] === 0x4d) {
          // OP_PUSHDATA2
          dataLen = buf[pos + 1] + (buf[pos + 2] << 8)
          dataStart = pos + 3
        } else if (buf[pos] === 0x4e) {
          // OP_PUSHDATA4
          dataLen = buf[pos + 1] + (buf[pos + 2] << 8) + (buf[pos + 3] << 16) + (buf[pos + 4] << 24)
          dataStart = pos + 5
        }
        
        if (dataLen >= 7) {
          const chunk = buf.slice(dataStart, dataStart + dataLen)
          
          // Check if first 7 bytes are "CARDIMG"
          if (chunk.slice(0, 7).toString() === PROTOCOL_PREFIX) {
            // Extract image data (everything after CARDIMG)
            const imageBuf = chunk.slice(7)
            const hash = crypto.createHash('sha256').update(imageBuf).digest('hex')
            
            return {
              hash,
              image: imageBuf,
              size: imageBuf.length
            }
          }
        }
      }
      pos++
    }
    return null
  } catch (e) {
    return null
  }
}

// Scan a block for CARDIMG transactions
async function scanBlock(height, ledger) {
  console.log(`Scanning block ${height}...`)
  
  const txs = await getBlockTxs(height)
  let found = 0
  
  for (const tx of txs) {
    const txHex = await getTxHex(tx.txid)
    const card = parseCardImg(txHex)
    
    if (card) {
      // Store in ledger
      ledger.cards[card.hash] = {
        txid: tx.txid,
        blockHeight: height,
        size: card.size
      }
      ledger.totalImages++
      ledger.totalBytes += card.size
      
      found++
      console.log(`  Found: ${tx.txid} (${(card.size / 1024).toFixed(1)}KB)`)
      
      // Save image to cache
      const imgPath = path.join(__dirname, 'images', `${card.hash}.bin`)
      fs.mkdirSync(path.dirname(imgPath), { recursive: true })
      fs.writeFileSync(imgPath, card.image)
    }
  }
  
  return found
}

// Scan pending mempool transactions (zero-conf uploads)
// These are tracked in a pending.json file when uploaded
async function scanMempool(ledger, mempool) {
  const pendingPath = path.join(__dirname, 'pending.json')
  if (!fs.existsSync(pendingPath)) {
    return { found: 0, confirmed: 0 }
  }
  
  const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf8'))
  let found = 0
  let confirmed = 0
  const stillPending = []
  
  for (const entry of pending) {
    try {
      const status = await getTxStatus(entry.txid)
      
      if (status && status.blockheight) {
        // Confirmed! Move to ledger
        console.log(`  Confirmed: ${entry.txid} in block ${status.blockheight}`)
        
        // Get the image data from cache or re-fetch
        const imgPath = path.join(__dirname, 'images', `${entry.hash}.bin`)
        let imageBuf
        if (fs.existsSync(imgPath)) {
          imageBuf = fs.readFileSync(imgPath)
        } else {
          const txHex = await getTxHex(entry.txid)
          const card = parseCardImg(txHex)
          if (card) {
            imageBuf = card.image
            fs.mkdirSync(path.dirname(imgPath), { recursive: true })
            fs.writeFileSync(imgPath, imageBuf)
          }
        }
        
        ledger.cards[entry.hash] = {
          txid: entry.txid,
          blockHeight: status.blockheight,
          size: entry.size
        }
        ledger.totalImages++
        ledger.totalBytes += entry.size
        
        // Remove from mempool cache
        delete mempool.cards[entry.hash]
        confirmed++
      } else {
        // Still in mempool
        if (!ledger.cards[entry.hash]) {
          // Add to mempool cache if not already in ledger
          mempool.cards[entry.hash] = {
            txid: entry.txid,
            size: entry.size,
            blockHeight: null // zero-conf
          }
          found++
        }
        stillPending.push(entry)
      }
    } catch (e) {
      console.log(`  Error checking ${entry.txid}: ${e.message}`)
      stillPending.push(entry) // Keep for retry
    }
    
    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 100))
  }
  
  // Update pending list (remove confirmed)
  fs.writeFileSync(pendingPath, JSON.stringify(stillPending, null, 2))
  
  mempool.lastScan = Date.now()
  saveMempool(mempool)
  
  return { found, confirmed }
}

// Main scan loop
async function main() {
  const args = process.argv.slice(2)
  const fromBlock = parseInt(args.find(a => a.startsWith('--from'))?.split('=')[1] || args[args.indexOf('--from') + 1]) || null
  const once = args.includes('--once')
  const mempoolOnly = args.includes('--mempool')
  
  const ledger = loadLedger()
  const mempool = loadMempool()
  let startBlock = fromBlock || ledger.lastBlock + 1
  
  console.log('CARDIMG Indexer')
  console.log('Ledger:', LEDGER_PATH)
  console.log('Mempool cache:', MEMPOOL_PATH)
  
  // Mempool-only mode
  if (mempoolOnly) {
    console.log('Scanning mempool for pending transactions...')
    const { found, confirmed } = await scanMempool(ledger, mempool)
    saveLedger(ledger)
    console.log(`\nDone. ${found} in mempool, ${confirmed} newly confirmed.`)
    return
  }
  
  console.log('Starting from block:', startBlock)
  
  if (startBlock === 1) {
    console.log('Tip: Use --from N to start from a specific block (skip genesis scan)')
  }
  
  // First, scan mempool for any pending transactions
  console.log('Checking mempool...')
  await scanMempool(ledger, mempool)
  
  while (true) {
    const tip = await getHeight()
    
    if (startBlock > tip) {
      console.log(`At tip (${tip}). Waiting...`)
      if (once) break
      await new Promise(r => setTimeout(r, SCAN_DELAY))
      continue
    }
    
    const found = await scanBlock(startBlock, ledger)
    ledger.lastBlock = startBlock
    saveLedger(ledger)
    
    console.log(`  Block ${startBlock}: ${found} CARDIMG found. Total: ${ledger.totalImages}`)
    
    startBlock++
    
    if (once) break
    await new Promise(r => setTimeout(r, 1000)) // Small delay between blocks
  }
  
  // Final mempool check
  await scanMempool(ledger, mempool)
  saveLedger(ledger)
  
  console.log('\nDone.')
  console.log('Total confirmed:', ledger.totalImages)
  console.log('Total bytes:', ledger.totalBytes)
  console.log('In mempool:', Object.keys(mempool.cards).length)
}

main().catch(e => {
  console.error('Error:', e.message)
  process.exit(1)
})