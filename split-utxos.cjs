#!/usr/bin/env node
/**
 * Split the wallet's large UTXO into card-upload-sized UTXOs
 * using the UtxoPool manager.
 * 
 * Each UTXO = 3,000,000 sats (~enough for one ~6MB CARDIMG upload fee)
 */

const fs = require('fs')
const path = require('path')
const { UtxoPool } = require('/Users/axiemaid/.openclaw/utxo-pool-manager/index.cjs')

// bsv is in cardimg's node_modules
require('bsv')

const WALLET_PATH = path.join(process.env.HOME, '.openclaw', 'bsv-wallet.json')
const WoC_API = 'https://api.whatsonchain.com/v1/bsv/main'

async function main() {
  const wallet = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf8'))
  console.log(`Wallet: ${wallet.address}`)
  
  // Check current UTXO state
  const res = await fetch(`${WoC_API}/address/${wallet.address}/unspent`)
  const utxos = await res.json()
  const totalSats = utxos.reduce((s, u) => s + u.value, 0)
  console.log(`Current UTXOs: ${utxos.length}`)
  console.log(`Total balance: ${totalSats.toLocaleString()} sats (~${(totalSats / 1e8).toFixed(4)} BSV)`)
  console.log('')
  
  for (const u of utxos) {
    console.log(`  ${u.tx_hash.substring(0,16)}...:${u.tx_pos} = ${u.value.toLocaleString()} sats`)
  }
  console.log('')
  
  // Split into 3M-sat UTXOs, 20 of them = 60M sats
  // Leaves 1.72B sats in remaining large UTXO
  const SPLIT_COUNT = 20
  const UTXO_SATS = 3_000_000
  
  console.log(`Splitting into ${SPLIT_COUNT} × ${UTXO_SATS.toLocaleString()}-sat UTXOs...`)
  console.log(`Cost: ${SPLIT_COUNT * UTXO_SATS} sats + fees`)
  console.log('')
  
  const pool = new UtxoPool({
    wif: wallet.wif,
    splitCount: SPLIT_COUNT,
    utxoSats: UTXO_SATS,
    refillThreshold: 5,
    feeRate: 50,
    network: 'mainnet',
  })
  
  const count = await pool.load()
  console.log(`Pool loaded: ${count} UTXOs of ${UTXO_SATS} sats each`)
  
  if (count === 0) {
    console.log('No pre-sized UTXOs found. Splitting largest UTXO...')
    // UtxoPool.load() should auto-split, but let's check
  }
  
  // Verify
  const res2 = await fetch(`${WoC_API}/address/${wallet.address}/unspent`)
  const utxos2 = await res2.json()
  console.log('')
  console.log(`After split: ${utxos2.length} UTXOs`)
  const sized = utxos2.filter(u => u.value === UTXO_SATS)
  console.log(`Card-sized (${UTXO_SATS} sat) UTXOs: ${sized.length}`)
  
  const newTotal = utxos2.reduce((s, u) => s + u.value, 0)
  console.log(`Balance: ${newTotal.toLocaleString()} sats`)
}

main().catch(e => {
  console.error('Error:', e.message)
  process.exit(1)
})
