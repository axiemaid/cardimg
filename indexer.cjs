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
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const WoC_API = 'https://api.whatsonchain.com/v1/bsv/main'
const LEDGER_PATH = path.join(__dirname, 'ledger.json')
const PROTOCOL_PREFIX = 'CARDIMG'
const SCAN_DELAY = 10000 // 10 seconds between scans

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

// Get current chain height
async function getHeight() {
  const res = await fetch(`${WoC_API}/block/headers?limit=1`)
  if (!res.ok) throw new Error(`WoC error: ${res.status}`)
  const data = await res.json()
  return data[0].height
}

// Get block transactions
async function getBlockTxs(height) {
  const res = await fetch(`${WoC_API}/block/${height}/txs`)
  if (!res.ok) throw new Error(`WoC block error: ${res.status}`)
  const data = await res.json()
  return data
}

// Get raw transaction hex
async function getTxHex(txid) {
  const res = await fetch(`${WoC_API}/tx/${txid}/hex`)
  if (!res.ok) throw new Error(`WoC tx error: ${res.status}`)
  return res.text()
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

// Main scan loop
async function main() {
  const args = process.argv.slice(2)
  const fromBlock = parseInt(args.find(a => a.startsWith('--from'))?.split('=')[1] || args[args.indexOf('--from') + 1]) || null
  const once = args.includes('--once')
  
  const ledger = loadLedger()
  let startBlock = fromBlock || ledger.lastBlock + 1
  
  console.log('CARDIMG Indexer')
  console.log('Ledger:', LEDGER_PATH)
  console.log('Starting from block:', startBlock)
  
  if (startBlock === 1) {
    console.log('Tip: Use --from N to start from a specific block (skip genesis scan)')
  }
  
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
  
  console.log('\nDone.')
  console.log('Total images:', ledger.totalImages)
  console.log('Total bytes:', ledger.totalBytes)
}

main().catch(e => {
  console.error('Error:', e.message)
  process.exit(1)
})