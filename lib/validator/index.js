/**
 * Validator entry point — validatePair(frontFile, backFile, refs).
 * 
 * Runs the full pipeline: sanity → normalize → identify front → validate back → record.
 * 
 * Browser: pass File objects. Uses createImageBitmap + canvas for decode.
 * Node: pass Buffer objects. Uses sharp for decode.
 */

const { checkFile, checkDimensions } = require('./sanity')
const { normalize, autoCrop } = require('./normalize')
const { identifyFront, validateBack } = require('./identify')
const { sha256, buildRecord } = require('./record')

const CANONICAL_W = 256
const CANONICAL_H = 358

// Error codes matching the spec
const ERRORS = {
  E_FORMAT: 'File must be a JPEG, PNG, or WebP image.',
  E_SIZE: 'File must be between 50 KB and 8 MB.',
  E_DIMENSIONS: 'Image resolution is too low or too high.',
  E_ASPECT: "Image doesn't look like a single card. Crop to the card edges.",
  E_DECODE: 'Could not decode the image file.',
  E_BACK_MISMATCH: 'Back image doesn\'t match the Hyper Battle card back.',
  E_BACK_IS_FRONT: 'This looks like a card front. Did you swap the images?',
  E_NOT_CARD: 'Couldn\'t match this to any of the 42 Hyper Battle cards.',
  E_AMBIGUOUS: 'Match is unclear. Try a cleaner scan with no glare or sleeve.',
}

/**
 * Decode a File (browser) or Buffer (Node) to raw RGBA.
 * 
 * Browser path: createImageBitmap → canvas getImageData
 * Node path: sharp .raw()
 */
async function decodeToRGBA(file) {
  // Browser: File object has .arrayBuffer()
  if (typeof createImageBitmap !== 'undefined' && file instanceof Blob) {
    const bitmap = await createImageBitmap(file)
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(bitmap, 0, 0)
    const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height)
    return { data: new Uint8Array(imageData.data), w: bitmap.width, h: bitmap.height }
  }
  
  // Node: Buffer
  if (Buffer.isBuffer(file) || file instanceof Uint8Array) {
    const sharp = require('sharp')
    const buf = Buffer.isBuffer(file) ? file : Buffer.from(file)
    const { data, info } = await sharp(buf)
      .rotate() // auto-orient via EXIF
      .removeAlpha()
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    return { data: new Uint8Array(data), w: info.width, h: info.height }
  }
  
  throw new Error('Unsupported file type')
}

/**
 * Validate a pair of card images (front + back).
 * 
 * @param {File|Buffer} frontFile - front card image
 * @param {File|Buffer} backFile - back card image
 * @param {object} refs - loaded references.json
 * @param {object} [thresholds] - override defaults
 * @returns {Promise<object>} result record or Error
 */
async function validatePair(frontFile, backFile, refs, thresholds = {}) {
  const errors = []
  
  // --- File sanity ---
  const frontBuf = frontFile instanceof Blob ? new Uint8Array(await frontFile.arrayBuffer()) : frontFile
  const backBuf = backFile instanceof Blob ? new Uint8Array(await backFile.arrayBuffer()) : backFile
  
  const frontSanity = checkFile(frontBuf)
  if (!frontSanity.valid) {
    for (const e of frontSanity.errors) {
      if (e.includes('small') || e.includes('large')) errors.push({ code: 'E_SIZE', message: ERRORS.E_SIZE })
      else errors.push({ code: 'E_FORMAT', message: ERRORS.E_FORMAT })
    }
  }
  
  const backSanity = checkFile(backBuf)
  if (!backSanity.valid) {
    for (const e of backSanity.errors) {
      if (e.includes('small') || e.includes('large')) errors.push({ code: 'E_SIZE', message: ERRORS.E_SIZE })
      else errors.push({ code: 'E_FORMAT', message: ERRORS.E_FORMAT })
    }
  }
  
  if (errors.length > 0) {
    return { valid: false, errors }
  }
  
  // --- Decode ---
  let frontRGBA, backRGBA
  try {
    frontRGBA = await decodeToRGBA(frontFile)
  } catch (e) {
    return { valid: false, errors: [{ code: 'E_DECODE', message: ERRORS.E_DECODE }] }
  }
  try {
    backRGBA = await decodeToRGBA(backFile)
  } catch (e) {
    return { valid: false, errors: [{ code: 'E_DECODE', message: ERRORS.E_DECODE }] }
  }
  
  // --- Resolution checks (min/max dimensions only) ---
  // Aspect ratio is checked AFTER auto-crop, per spec §5.1
  const frontShort = Math.min(frontRGBA.w, frontRGBA.h)
  const frontLong = Math.max(frontRGBA.w, frontRGBA.h)
  if (frontShort < 600 || frontLong > 6000) {
    errors.push({ code: 'E_DIMENSIONS', message: ERRORS.E_DIMENSIONS })
  }
  
  const backShort = Math.min(backRGBA.w, backRGBA.h)
  const backLong = Math.max(backRGBA.w, backRGBA.h)
  if (backShort < 600 || backLong > 6000) {
    errors.push({ code: 'E_DIMENSIONS', message: ERRORS.E_DIMENSIONS })
  }
  
  if (errors.length > 0) {
    return { valid: false, errors }
  }
  
  // --- Normalize (auto-crop + resize to 256×358) ---
  const frontNorm = normalize(frontRGBA.data, frontRGBA.w, frontRGBA.h)
  const backNorm = normalize(backRGBA.data, backRGBA.w, backRGBA.h)
  
  // --- Aspect ratio check on cropped dimensions ---
  // If auto-crop worked, check the crop's aspect ratio
  // If no crop, check the raw image aspect
  const frontCropW = frontNorm.croppedW || frontRGBA.w
  const frontCropH = frontNorm.croppedH || frontRGBA.h
  const frontAspect = Math.min(frontCropW, frontCropH) / Math.max(frontCropW, frontCropH)
  if (Math.abs(frontAspect - 0.716) > 0.06) {
    errors.push({ code: 'E_ASPECT', message: ERRORS.E_ASPECT })
  }
  
  const backCropW = backNorm.croppedW || backRGBA.w
  const backCropH = backNorm.croppedH || backRGBA.h
  const backAspect = Math.min(backCropW, backCropH) / Math.max(backCropW, backCropH)
  if (Math.abs(backAspect - 0.716) > 0.06) {
    errors.push({ code: 'E_ASPECT', message: ERRORS.E_ASPECT })
  }
  
  if (errors.length > 0) {
    return { valid: false, errors }
  }
  
  // --- Back validation ---
  const backResult = validateBack(
    backNorm.rgb, CANONICAL_W, CANONICAL_H,
    refs.back, refs.cards, thresholds
  )
  
  if (!backResult.matched) {
    if (backResult.reason === 'is_front') {
      return { valid: false, errors: [{ code: 'E_BACK_IS_FRONT', message: ERRORS.E_BACK_IS_FRONT }] }
    } else {
      return { valid: false, errors: [{ code: 'E_BACK_MISMATCH', message: ERRORS.E_BACK_MISMATCH }] }
    }
  }
  
  // --- Front identification ---
  const frontResult = identifyFront(
    frontNorm.rgb, CANONICAL_W, CANONICAL_H,
    refs.cards, thresholds
  )
  
  if (!frontResult.matched) {
    if (frontResult.reason === 'ambiguous') {
      return { valid: false, errors: [{ code: 'E_AMBIGUOUS', message: ERRORS.E_AMBIGUOUS }] }
    } else {
      return { valid: false, errors: [{ code: 'E_NOT_CARD', message: ERRORS.E_NOT_CARD }] }
    }
  }
  
  // --- Cross-check: front image shouldn't look like a back ---
  const frontAsBack = validateBack(
    frontNorm.rgb, CANONICAL_W, CANONICAL_H,
    refs.back, refs.cards, thresholds
  )
  if (frontAsBack.matched) {
    return { valid: false, errors: [{ code: 'E_BACK_IS_FRONT', message: 'Front image looks like a card back. Did you swap the images?' }] }
  }
  
  // --- Build result record ---
  const frontSha256 = await sha256(frontBuf)
  const backSha256 = await sha256(backBuf)
  
  const record = buildRecord({
    cardId: frontResult.cardId,
    frontSha256,
    frontBytes: frontBuf.length,
    frontW: frontRGBA.w,
    frontH: frontRGBA.h,
    frontRotation: frontNorm.rotation,
    backSha256,
    backBytes: backBuf.length,
    backW: backRGBA.w,
    backH: backRGBA.h,
    backRotation: backNorm.rotation,
    scores: {
      frontBest: frontResult.score,
      frontSecond: frontResult.secondBest ? frontResult.secondBest.score : null,
      backHash: backResult.hashDist,
      backHist: backResult.histSim,
    },
    refSetHash: refs.refSetHash || 'unknown',
  })
  
  return { valid: true, record, frontResult, backResult }
}

module.exports = {
  validatePair,
  decodeToRGBA,
  sha256,
  ERRORS,
}
