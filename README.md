# CARDIMG

Minimal on-chain card image registry for BSV blockchain.

## Protocol

```
OP_FALSE OP_RETURN "CARDIMG" <image_data>
```

- **Permissionless** — anyone can upload, no gatekeeper
- **Immutable** — once on-chain, never changes
- **Minimal** — just prefix + image bytes, nothing else

Identity is SHA256 of image data. All meaning (card ID, condition, associations) is application layer.

## Components

| File | Purpose |
|------|---------|
| `upload.cjs` | CLI upload tool |
| `indexer.cjs` | Scan chain for CARDIMG transactions |
| `viewer.cjs` | Web viewer (port 3013) |
| `ledger.json` | Index state |

## Quick Start

```bash
npm install

# Upload image
node upload.cjs card.png

# Start indexer (continuous scan)
node indexer.cjs

# Start viewer
node viewer.cjs
open http://localhost:3013
```

## Wallet

Uses existing BSV wallet at `~/.openclaw/bsv-wallet.json`.

## Cost

At ~0.5 sats/byte:
- 500KB image ≈ 250,000 sats (~$0.10)
- 2MB image ≈ 1,000,000 sats (~$0.40)