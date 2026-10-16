# CARDIMG

On-chain card image registry for the BSV blockchain. Permissionless, immutable, minimal.

## Protocol

```
OP_FALSE OP_RETURN "CARDIMG" <image_bytes>
```

- **No version byte, no chunking** — BSV accepts large OP_RETURN outputs (tested 6MB+)
- **Identity = SHA256 of image data** — exact byte match
- **All meaning is application layer** — card ID, condition, price, ownership are not in the protocol

### CARDSET (companion protocol)

```
OP_FALSE OP_RETURN "CARDSET" <cardimg_txid_1> <cardimg_txid_2> ...
```

- Links CARDIMG txids into sets (front + back + supplementary angles)
- Positional ordering: pos 0 = front, pos 1 = back, pos 2+ = supplementary
- Convention, not enforcement — apps prefer correctly ordered sets
- Permissionless — anyone can create associations

## Architecture

```
┌──────────────┐   JungleBus   ┌──────────────┐   WoC    ┌─────────────┐
│  Indexer     │ ◄───────────  │  BSV Chain   │ ───────► │  WhatsOn    │
│  (scanner)   │               │              │          │  Chain API  │
└──────┬───────┘               └──────────────┘          └─────────────┘
       │ writes
       ▼
┌──────────────┐    HTTP API   ┌──────────────┐   HTTP   ┌──────────────┐
│  Indexer     │ ◄──────────── │  CARDIMG API │ ◄──────► │  Viewer      │
│  Data Dir    │               │  (port 3014) │          │  (port 3015) │
│              │               │              │          │  (public)    │
│  ledger.json │               │  /list       │          │              │
│  mempool.json│               │  /img/:hash  │          │  Uploads tab │
│  cardset-*   │               │  /tx/:txid   │          │  Cards tab   │
│  images/     │               │  /sets/list  │          │              │
│  exclusions  │               │  /exclusions │          │              │
└──────────────┘               └──────────────┘          └──────────────┘
```

## Local Folders

| Folder | Purpose |
|--------|---------|
| `~/.openclaw/cardimg/` | **Main data dir** — indexer, viewer, API, exclusions, ledgers |
| `~/.openclaw/cardimg-upload/` | Composable upload library (CLI + JS API) |
| `~/.openclaw/cardimg-indexer/` | Composable JungleBus indexer library |
| `~/.openclaw/cardimg-api/` | Composable Express API server |
| `~/.openclaw/cardimg-scan/` | Application-layer scan validation (DPI, edges, background) |
| `~/.openclaw/cardimg-viewer/` | Public-facing gallery viewer |
| `~/.openclaw/cardimg-ecosystem/` | Design docs for grading, marketplace, reputation layers |

## Key Files (main data dir)

| File | Purpose |
|------|---------|
| `indexer.cjs` | JungleBus indexer — scans chain, caches images, updates ledger |
| `viewer.cjs` | Legacy viewer (use cardimg-viewer instead) |
| `cardset-indexer.cjs` | CARDSET JungleBus indexer — catches all CARDSETs from anyone |
| `cardset-viewer.cjs` | Legacy CARDSET viewer (use cardimg-viewer instead) |
| `upload.cjs` | Single-image CLI uploader |
| `batch-upload.cjs` | Batch uploader (multiple images, one UTXO each) |
| `split-utxos.cjs` | Pre-split wallet UTXOs for independent uploads |
| `ledger.json` | Confirmed CARDIMG images (txid-keyed) |
| `mempool.json` | Zero-conf CARDIMG images (txid-keyed) |
| `cardset-ledger.json` | Confirmed CARDSETs |
| `cardset-mempool.json` | Zero-conf CARDSETs |
| `exclusions.json` | Txids hidden from API responses (cardimg + cardset arrays) |
| `images/` | Local image cache (`<sha256>.bin` files) |
| `thumbs/` | Thumbnail cache (`<hash>_400.jpg` files) |

## Exclusions

Exclusions hide specific transactions from the API and viewer. Still on-chain, just not shown.

### File: `exclusions.json`

```json
{
  "cardimg": [
    "3a512c182e03f4d5cf1468e679740f7ca5c6bdcfb9953fcda95704997aacb3f6"
  ],
  "cardset": []
}
```

- Edit the file directly — API reads it on every request, changes take effect immediately
- Or use the API endpoints:

```bash
# Add
curl -X POST http://localhost:3014/exclusions \
  -H "Content-Type: application/json" \
  -d '{"type": "cardimg", "txid": "3a512c..."}'

# Remove
curl -X DELETE http://localhost:3014/exclusions \
  -H "Content-Type: application/json" \
  -d '{"type": "cardimg", "txid": "3a512c..."}'

# List
curl http://localhost:3014/exclusions
```

## Card Code Mapping (application layer)

Card codes (C01–C34, S01–S08) are not stored on-chain. They're a viewer-level mapping.

### File: `~/.openclaw/cardimg-viewer/public/card-codes.json`

```json
{
  "mappings": {
    "42484af615d840eb4252d88b955268553403c264d19b9c9e44dff8f7da3ae7b5": "C01",
    "6c0bdcf5fdb0d521e83c16d3c137b35de17a211bcd749e8133de02450e601984": "S03"
  }
}
```

- **Key** = CARDSET txid
- **Value** = card code
- Viewer reads on page load — changes take effect on refresh
- Future: pHash auto-matching to eliminate manual mapping

## Wallet

Uses BSV wallet at `~/.openclaw/bsv-wallet.json`.
Address: `15tMS13ewnZY7xti1xmxmhD6cRLnxMxVWQ`

## Related Repos

- [cardimg-upload](https://github.com/axiemaid/cardimg-upload) — composable upload library
- [cardimg-indexer](https://github.com/axiemaid/cardimg-indexer) — composable indexer library
- [cardimg-api](https://github.com/axiemaid/cardimg-api) — composable API server
- [cardimg-scan](https://github.com/axiemaid/cardimg-scan) — scan validation
- [cardimg-viewer](https://github.com/axiemaid/cardimg-viewer) — public gallery viewer

## JungleBus Subscriptions

- **CARDIMG:** indexer scans minting address (legacy)
- **CARDSET:** `94572334d5674b3da841c058b4b462c5d83c83350f92918aa175c80b804a50ac` (catches all CARDSETs from anyone)

## Cost

- 0.1 sats/byte (100 sat/KB), calculated from actual serialized tx size
- Both CARDIMG and CARDSET use the same fee calculation

## First Upload

- TXID: `3a512c182e03f4d5cf1468e679740f7ca5c6bdcfb9953fcda95704997aacb3f6`
- Block: 957054
- Size: 560KB
