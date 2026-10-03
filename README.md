# CARDIMG API

Universal image API for on-chain BSV card scans. Serves cached images from the CARDIMG indexer with chain fallback for any txid.

## Quick Start

```bash
node viewer.cjs
# → http://localhost:3014
```

Also public at `https://cardimg.axiemaid.com` (Cloudflare tunnel).

## API Endpoints

### Universal Image API (for apps)

These are the primary endpoints. Any app, any language, any framework.

| Endpoint | Method | Returns | Content-Type |
|----------|--------|---------|--------------|
| `/img/<sha256>` | GET | Raw image bytes | image/jpeg, image/png, etc. |
| `/tx/<txid>` | GET | Raw image bytes by txid | image/jpeg, image/png, etc. |
| `/card/<sha256>` | GET | JSON metadata + links | application/json |
| `/list` | GET | JSON array of all cards | application/json |

#### `GET /img/<hash>`

Returns raw image bytes with proper content-type header. Cached locally — first hit serves from disk, near-instant.

If the image isn't in local cache, the server fetches it from chain via WoC OP_RETURN endpoint and caches it for future requests.

```bash
curl http://localhost:3014/img/043774e943a057d2... > card.jpg
```

```javascript
const res = await fetch('http://localhost:3014/img/' + hash)
const blob = await res.blob()
```

```python
import requests
img = requests.get(f'http://localhost:3014/img/{hash}').content
```

```html
<img src="http://localhost:3014/img/043774e943a057d2...">
```

#### `GET /tx/<txid>>

Same as `/img/<hash>` but looked up by transaction ID. Works for **any** CARDIMG tx on the BSV blockchain, even if our indexer hasn't seen it yet — fetches directly from chain and caches.

```bash
curl http://localhost:3014/tx/a7322980a27f57e6... > card.jpg
```

#### `GET /card/<hash>`

JSON metadata for a single card:

```json
{
  "hash": "043774e943a057d2...",
  "txid": "a7322980a27f57e6...",
  "blockHeight": 969407,
  "size": 998183,
  "woCLink": "https://whatsonchain.com/tx/a7322980a27f57e6...",
  "imageUrl": "/img/043774e943a057d2...",
  "txUrl": "/tx/a7322980a27f57e6..."
}
```

#### `GET /list`

JSON array of all indexed cards with URLs:

```json
[
  {
    "hash": "043774e9...",
    "txid": "a7322980...",
    "blockHeight": 969407,
    "size": 998183,
    "imageUrl": "/img/043774e9...",
    "txUrl": "/tx/a7322980...",
    "woCLink": "https://whatsonchain.com/tx/a7322980..."
  }
]
```

### Indexer API (internal)

| Endpoint | Method | Returns |
|----------|--------|---------|
| `/cards` | GET | All cards as object map `{ hash: { txid, blockHeight, size } }` |
| `/cards/:hash` | GET | Card metadata (same as /card/:hash but without URLs) |
| `/cards/:hash/image` | GET | Raw image (alias for /img/:hash) |
| `/stats` | GET | `{ confirmed, mempool, totalImages, totalBytes, lastBlock }` |
| `/upload` | POST | Upload new image (multipart form, field name: "image") |

### Web Dashboard

`GET /` returns an HTML page showing all indexed images in a grid with upload form.

## Response Headers

- `Content-Type`: auto-detected from image magic bytes (JPEG, PNG, WebP, GIF)
- `Cache-Control: public, max-age=31536000` — images are immutable (same hash = same bytes)

## Chain Fallback (no server needed)

If this server is down, any app can fetch directly from WhatsOnChain:

```bash
# 1. Get OP_RETURN outputs
curl https://api.whatsonchain.com/v1/bsv/main/tx/<txid>/opreturn

# 2. Parse hex:
#    - Skip OP_FALSE (0x00) OP_RETURN (0x6a)
#    - Parse pushdata for "CARDIMG" prefix (7 bytes)
#    - Parse next pushdata for image bytes
#    - Write to file
```

Python example:
```python
import requests

def fetch_cardimg(txid):
    res = requests.get(f'https://api.whatsonchain.com/v1/bsv/main/tx/{txid}/opreturn')
    outputs = res.json()
    for out in outputs:
        buf = bytes.fromhex(out['hex'])
        # Skip OP_FALSE(00) OP_RETURN(6a)
        # Parse pushdata for "CARDIMG"
        # Parse next pushdata for image
        # ... (see viewer.cjs parsePushData for reference)
    return None
```

## Files

| File | Purpose |
|------|---------|
| `viewer.cjs` | Express server — serves API + web dashboard |
| `indexer.cjs` | JungleBus indexer — scans chain, caches images, updates ledger |
| `upload.cjs` | Single-image CLI uploader |
| `batch-upload.cjs` | Batch uploader (multiple images, one UTXO each) |
| `split-utxos.cjs` | Pre-split wallet UTXOs for independent uploads |
| `ledger.json` | Confirmed on-chain images |
| `mempool.json` | Zero-conf (unconfirmed) images |
| `pending.json` | Pending uploads awaiting confirmation |
| `upload-log.json` | Human-readable upload log (synced to card-scans/) |
| `images/` | Local image cache (`<sha256>.bin` files) |

## Wallet

Uses BSV wallet at `~/.openclaw/bsv-wallet.json`.
Address: `15tMS13ewnZY7xti1xmxmhD6cRLnxMxVWQ`

## Related

- **Card scans folder:** `~/.openclaw/card-scans/` (source images + upload log + main README)
- **UTXO pool manager:** `~/.openclaw/utxo-pool-manager/` (pre-split utility)
- **Card centering tools:** `~/.openclaw/card-centering/` (standalone Python analysis — uses this API to fetch images)
- **Pipeline (optional):** `~/.openclaw/cardimg-pipeline/` (auto-analysis bridge, not needed for basic image fetch)

## Protocol

```
OP_FALSE OP_RETURN "CARDIMG" <image_bytes>
```

- Permissionless, immutable, minimal
- Identity = SHA256 of image data
- All meaning (card ID, set, condition) is application layer
- See `~/.openclaw/card-scans/README.md` for full protocol docs
