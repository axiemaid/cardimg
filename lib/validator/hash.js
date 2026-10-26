/**
 * Perceptual hashing — dHash and Hamming distance.
 * 
 * dHash: "difference hash" — compares adjacent pixel brightness.
 * 16×16 grid = 256 bits, stored as 8 Uint32 words (big-endian bit order).
 * 
 * Pure JS, works on grayscale Uint8Array input.
 */

/**
 * Compute a 256-bit dHash (16×16 grid) from a grayscale image.
 * Each bit: 1 if pixel[x] > pixel[x+1] (left brighter than right).
 * 
 * @param {Uint8Array} gray - grayscale pixel values
 * @param {number} w - width
 * @param {number} h - height
 * @returns {Uint32Array} 8 words, 256 bits total
 */
function dHash256(gray, w, h) {
  // Downsample to 17×16 (need width+1 for horizontal gradient)
  // We compare pixel[x] vs pixel[x+1], so we need 17 columns to get 16 bits per row
  const cols = 17
  const rows = 16
  const xRatio = w / cols
  const yRatio = h / rows
  
  // Downsample via area averaging
  const small = new Float32Array(cols * rows)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x0 = Math.floor(c * xRatio)
      const x1 = Math.min(Math.floor((c + 1) * xRatio), w)
      const y0 = Math.floor(r * yRatio)
      const y1 = Math.min(Math.floor((r + 1) * yRatio), h)
      let sum = 0, count = 0
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          sum += gray[y * w + x]
          count++
        }
      }
      small[r * cols + c] = count > 0 ? sum / count : 0
    }
  }
  
  // Compute gradient bits
  const hash = new Uint32Array(8) // 256 bits = 8 × 32 bits
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < 16; c++) { // 16 comparisons per row
      const left = small[r * cols + c]
      const right = small[r * cols + c + 1]
      const bit = left > right ? 1 : 0
      const bitIndex = r * 16 + c
      const word = bitIndex >> 5 // bitIndex / 32
      const bitPos = bitIndex & 31 // bitIndex % 32
      if (bit) hash[word] |= (1 << bitPos)
    }
  }
  
  return hash
}

/**
 * Compute a 64-bit dHash (8×8 grid) from a grayscale image.
 * For quadrant-level hashing.
 * 
 * @param {Uint8Array} gray
 * @param {number} w
 * @param {number} h
 * @returns {Uint32Array} 2 words, 64 bits
 */
function dHash64(gray, w, h) {
  const cols = 9
  const rows = 8
  const xRatio = w / cols
  const yRatio = h / rows
  
  const small = new Float32Array(cols * rows)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x0 = Math.floor(c * xRatio)
      const x1 = Math.min(Math.floor((c + 1) * xRatio), w)
      const y0 = Math.floor(r * yRatio)
      const y1 = Math.min(Math.floor((r + 1) * yRatio), h)
      let sum = 0, count = 0
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          sum += gray[y * w + x]
          count++
        }
      }
      small[r * cols + c] = count > 0 ? sum / count : 0
    }
  }
  
  const hash = new Uint32Array(2) // 64 bits
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < 8; c++) {
      const left = small[r * cols + c]
      const right = small[r * cols + c + 1]
      const bit = left > right ? 1 : 0
      const bitIndex = r * 8 + c
      const word = bitIndex >> 5
      const bitPos = bitIndex & 31
      if (bit) hash[word] |= (1 << bitPos)
    }
  }
  
  return hash
}

/**
 * Compute Hamming distance between two hash arrays.
 * @param {Uint32Array} a
 * @param {Uint32Array} b
 * @returns {number} number of differing bits
 */
function hammingDistance(a, b) {
  let dist = 0
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    // XOR → count bits
    let x = a[i] ^ b[i]
    // Brian Kernighan's bit count
    while (x) { dist++; x &= (x - 1) }
  }
  return dist
}

/**
 * Convert Uint32Array hash to hex string for storage.
 */
function hashToHex(hash) {
  let hex = ''
  for (let i = 0; i < hash.length; i++) {
    hex += hash[i].toString(16).padStart(8, '0')
  }
  return hex
}

/**
 * Parse hex string back to Uint32Array.
 */
function hexToHash(hex, words) {
  const arr = new Uint32Array(words || (hex.length / 8))
  for (let i = 0; i < arr.length; i++) {
    arr[i] = parseInt(hex.substr(i * 8, 8), 16)
  }
  return arr
}

module.exports = {
  dHash256,
  dHash64,
  hammingDistance,
  hashToHex,
  hexToHash,
}
