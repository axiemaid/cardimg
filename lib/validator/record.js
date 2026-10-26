/**
 * Result record — canonical JSON output.
 * Uses crypto.subtle in browser, crypto module in Node.
 */

const HASH_ALG = 'SHA-256'

/**
 * Compute SHA-256 of a byte buffer.
 * Works in both browser (SubtleCrypto) and Node (crypto).
 * 
 * @param {Uint8Array|Buffer} buf
 * @returns {Promise<string>} hex string
 */
async function sha256(buf) {
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const hashBuf = await crypto.subtle.digest(HASH_ALG, buf)
    return Array.from(new Uint8Array(hashBuf))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')
  }
  // Node fallback
  const nodeCrypto = require('crypto')
  return nodeCrypto.createHash('sha256').update(Buffer.from(buf)).digest('hex')
}

/**
 * Build a canonical result record.
 * 
 * @param {object} params
 * @param {string} params.cardId - matched card ID (e.g. "C01")
 * @param {string} params.frontSha256 - hash of front image bytes
 * @param {number} params.frontBytes - front file size
 * @param {number} params.frontW - front image width (original)
 * @param {number} params.frontH - front image height (original)
 * @param {number} params.frontRotation - rotation applied
 * @param {string} params.backSha256 - hash of back image bytes
 * @param {number} params.backBytes - back file size
 * @param {number} params.backW - back image width (original)
 * @param {number} params.backH - back image height (original)
 * @param {number} params.backRotation - rotation applied
 * @param {object} params.scores - front match scores + back validation scores
 * @param {string} params.refSetHash - hash of references.json
 * @returns {object} canonical result record
 */
function buildRecord(params) {
  return {
    schema: 'hb-upload/1',
    setId: 'hyper-battle',
    cardId: params.cardId,
    front: {
      sha256: params.frontSha256,
      bytes: params.frontBytes,
      w: params.frontW,
      h: params.frontH,
      rotation: params.frontRotation,
    },
    back: {
      sha256: params.backSha256,
      bytes: params.backBytes,
      w: params.backW,
      h: params.backH,
      rotation: params.backRotation,
    },
    scores: {
      frontBest: params.scores.frontBest,
      frontSecond: params.scores.frontSecond,
      backHash: params.scores.backHash,
      backHist: params.scores.backHist,
    },
    validator: {
      version: '1.0.0',
      refSetHash: params.refSetHash,
    },
  }
}

module.exports = {
  sha256,
  buildRecord,
}
