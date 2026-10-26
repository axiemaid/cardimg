/* CARDIMG Viewer — Client logic with routing + card code directory + unified immersive viewer */

const API = window.CARDIMG_API != null ? window.CARDIMG_API : 'http://localhost:3014'
let allCards = []
let allSets = []
let cardReference = []      // 42 card codes from card-reference.json
let cardCodeMappings = {}   // { cardsetTxid → cardCode } from card-codes.json
let activeCardFilter = null // null = show all, or 'C01' etc.
let activeTab = 'cards'

// Viewer state
let viewerContext = null  // 'cardset' | 'cardimg'
let viewerMembers = []    // For cardset: array of { txid, hash, role }
let viewerMemberIndex = 0  // Currently selected member
let viewerCardCode = null
let viewerCardRef = null
let viewerLoadId = 0   // race condition guard for image swaps


// --- Init ---

document.addEventListener('DOMContentLoaded', () => {
  // Brand click → home
  document.getElementById('brand-link').addEventListener('click', e => {
    e.preventDefault()
    navigate('/')
  })

  // Tab switching — clears filter (explicit user action)
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab
      tabClickClearsFilter = true
      navigate(tab === 'cards' ? '/' : '/upload')
    })
  })

  // Global click delegation
  document.addEventListener('click', e => {
    const backLink = e.target.closest('.back-link')
    const viewLink = e.target.closest('.cardset-view-link')
    const codeChip = e.target.closest('.card-code-item')

    if (codeChip) {
      e.preventDefault()
      const code = codeChip.dataset.code
      if (code === 'ALL') {
        activeCardFilter = null
      } else if (activeCardFilter === code) {
        activeCardFilter = null
      } else {
        activeCardFilter = code
      }
      updateCardsetsFeedTitle()
      renderCardCodeGrid()
      renderSetsGrid()
    } else if (backLink) {
      e.preventDefault()
      window.history.back()
    } else if (viewLink) {
      e.preventDefault()
      navigate(viewLink.getAttribute('href'))
    }
  })

  // Viewer: image click → toggle zoom
  document.getElementById('viewer-image').addEventListener('click', e => {
    if (vzDidDrag) { vzDidDrag = false; return }
    toggleZoom()
  })
  initViewerPanZoom()

  // Viewer: keyboard navigation
  document.addEventListener('keydown', e => {
    if (document.getElementById('viewer-page').style.display === 'none') return
    if (e.key === 'Escape') {
      window.history.back()
    } else if (e.key === 'ArrowLeft') {
      cycleMember(-1)
    } else if (e.key === 'ArrowRight') {
      cycleMember(1)
    }
  })

  // Initial route
  loadCardReference()
  loadStats()
  loadWalletStatus()
  initUploadZone()
  const btnUploadAll = document.getElementById('btn-upload-all')
  if (btnUploadAll) btnUploadAll.addEventListener('click', uploadAll)
  handleRoute()
})

// --- Load reference data ---

async function loadCardReference() {
  try {
    const res = await fetch(`${API}/card-reference`)
    cardReference = await res.json()
  } catch (e) {
    console.error('Failed to load card reference:', e)
  }
  try {
    const res = await fetch(`${API}/card-codes`)
    const data = await res.json()
    cardCodeMappings = data.mappings || {}
  } catch (e) {
    console.error('Failed to load card codes:', e)
  }
  if (activeTab === 'cards') {
    renderCardCodeGrid()
  }
}

// --- Routing ---

window.addEventListener('popstate', handleRoute)

function handleRoute() {
  const path = window.location.pathname

  if (path.startsWith('/cardimg/')) {
    const txid = path.replace('/cardimg/', '')
    showViewer(txid, 'cardimg')
    return
  }

  if (path.startsWith('/card/')) {
    const txid = path.replace('/card/', '')
    showViewer(txid, 'cardset')
    return
  }

  if (path === '/upload') {
    showGallery('uploads')
    return
  }

  showGallery('cards')
}

function navigate(path) {
  window.history.pushState({}, '', path)
  handleRoute()
  window.scrollTo(0, 0)
}

let tabClickClearsFilter = false

function showGallery(tab) {
  activeTab = tab
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === (tab === 'cards' ? 'cards' : 'uploads'))
  })

  document.getElementById('gallery-view').style.display = ''
  document.getElementById('viewer-page').style.display = 'none'
  document.getElementById('topbar').style.display = ''
  document.querySelector('footer').style.display = ''

  const gallery = document.getElementById('gallery')
  const setsView = document.getElementById('sets-view')

  if (tab === 'uploads') {
    gallery.style.display = ''
    gallery.classList.add('active')
    setsView.style.display = 'none'
    setsView.classList.remove('active')
    if (allCards.length === 0) loadCards()
  } else {
    gallery.style.display = 'none'
    gallery.classList.remove('active')
    setsView.style.display = ''
    setsView.classList.add('active')
    if (allSets.length === 0) loadSets()
    // Only clear filter when user explicitly clicks the Cards tab,
    // not when navigating back from the viewer
    if (tabClickClearsFilter) {
      activeCardFilter = null
      renderCardCodeGrid()
      renderSetsGrid()
    }
    tabClickClearsFilter = false
  }
}

// --- Stats ---

async function loadStats() {
  try {
    const res = await fetch(`${API}/stats`)
    const data = await res.json()
    document.getElementById('stat-count').textContent = data.totalImages.toLocaleString()
  } catch (e) {}
}

// --- Card Upload Zones (validator-based) ---
// Uses HBValidator (validator.js) for all image validation:
//   - Format/size/dimension sanity checks
//   - Auto-crop + normalize to 256×358
//   - dHash + histogram scoring against references.json
//   - Front: identify which of 42 cards
//   - Back: validate against reference back image
//   - Cross-check: front≠back, back≠front

const cardState = { front: null, back: null }
let validatorRefs = null

async function loadWalletStatus() {
  const el = document.getElementById('upload-wallet-status')
  if (!el) return
  try {
    const res = await fetch(`${API}/wallet/status`)
    const info = await res.json()
    if (!info.configured) {
      el.textContent = 'Explorer wallet not configured'
      el.className = 'upload-wallet-status none'
      return
    }
    const bal = info.balance
    if (!bal || bal.total < 5000) {
      el.textContent = `Wallet low: ${bal ? bal.total.toLocaleString() : 0} sats — ${info.address}`
      el.className = 'upload-wallet-status low'
    } else {
      el.textContent = `Wallet: ${bal.total.toLocaleString()} sats · ${info.utxos} UTXOs`
      el.className = 'upload-wallet-status'
    }
  } catch (e) {
    el.textContent = 'Wallet status unavailable'
    el.className = 'upload-wallet-status'
  }
}

function initUploadZone() {
  document.querySelectorAll('.card-zone-drop').forEach(zone => {
    const zoneContainer = zone.closest('.card-zone')
    const zoneName = zoneContainer.dataset.zone

    zone.addEventListener('click', e => {
      if (e.target.closest('button')) return
      const input = zone.querySelector('input[type=file]')
      if (input) input.click()
    })

    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('dragover') })
    zone.addEventListener('dragleave', () => zone.classList.remove('dragover'))
    zone.addEventListener('drop', e => {
      e.preventDefault()
      zone.classList.remove('dragover')
      const files = Array.from(e.dataTransfer.files)
      for (const f of files) handleFileDrop(zoneName, f)
    })
  })

  document.addEventListener('change', e => {
    if (e.target.matches('.card-zone-drop input[type=file]')) {
      const zone = e.target.closest('.card-zone-drop')
      const zoneContainer = zone.closest('.card-zone')
      const zoneName = zoneContainer.dataset.zone
      const files = Array.from(e.target.files)
      for (const f of files) handleFileDrop(zoneName, f)
      e.target.value = ''
    }
  })
}

// --- Validator-based scan pipeline ---

async function ensureRefs() {
  if (validatorRefs) return validatorRefs
  validatorRefs = await window.HBValidator.loadReferences(API)
  console.log(`[validator] Loaded references: ${validatorRefs.cards.length} cards + back, hash=${validatorRefs.refSetHash}`)
  return validatorRefs
}

async function scanImage(file, zoneName) {
  const refs = await ensureRefs()
  const result = await window.HBValidator.validateCardImage(file, zoneName, refs)

  // Run card identification for front scans only
  if (zoneName === 'front' && result.passed && result.uploadBuffer) {
    result.idResult = await verifyFront(result.uploadBuffer)
    if (!result.idResult.ok) {
      // Override passed — identification failure blocks upload
      result.passed = false
      result.failures = result.failures || []
      result.failures.unshift(`Card ID: ${result.idResult.reason}`)
    }
  }

  return result
}

// Verify a front card JPEG via /verify endpoint
async function verifyFront(uploadBuffer) {
  try {
    const blob = new Blob([uploadBuffer], { type: 'image/jpeg' })
    const formData = new FormData()
    formData.append('image', blob, 'front.jpg')
    const resp = await fetch(`${API}/verify`, {
      method: 'POST',
      body: formData,
    })
    if (!resp.ok) return { ok: false, reason: `HTTP ${resp.status}` }
    return await resp.json()
  } catch (e) {
    return { ok: false, reason: e.message }
  }
}

function handleFileDrop(zoneName, file) {
  if (zoneName === 'front') {
    cardState.front = createScanEntry(zoneName, file, 0)
  } else if (zoneName === 'back') {
    cardState.back = createScanEntry(zoneName, file, 1)
  }
  analyzeCard()
}

function createScanEntry(zoneName, file, position) {
  const zoneDiv = document.getElementById(`zone-${zoneName}`)
  const summaryDiv = document.getElementById(`summary-${zoneName}`)
  const detailsDiv = document.getElementById(`details-${zoneName}`)
  const barLeft = document.getElementById(`bar-left-${zoneName}`)
  const zoneLabel = zoneName === 'front' ? 'Front' : 'Back'
  const imgUrl = URL.createObjectURL(file)

  zoneDiv.innerHTML = `<img src="${imgUrl}" alt="${zoneLabel}" class="zone-result-img" style="opacity:0.5"><div class="card-zone-label-overlay">${zoneLabel}</div><input type="file" accept="image/*" style="display:none" />`

  if (barLeft) {
    barLeft.innerHTML = `<button class="scan-btn-remove" onclick="removeScan('${zoneName}', ${position})">Remove</button>`
  }
  if (detailsDiv) {
    detailsDiv.innerHTML = `<div class="scan-status analyzing">Validating<span class="pulse-dots">...</span></div>`
  }

  return { file, zoneDiv, summaryDiv, detailsDiv, barLeft, position, zone: zoneName, result: null, uploadBuffer: null }
}

async function analyzeCard() {
  const all = getAllScans()
  const needsAnalysis = all.filter(s => s && !s.result)
  for (const scan of needsAnalysis) {
    try {
      const r = await scanImage(scan.file, scan.zone)
      scan.result = r
      scan.uploadBuffer = r.uploadBuffer
      renderScanResult(scan)
    } catch (err) {
      scan.result = { passed: false, failures: [err.message], warnings: [], errors: [] }
      renderScanResult(scan)
    }
  }
  updateBatchBar()
}

function renderScanResult(scan) {
  const { zone, position, zoneDiv, summaryDiv, detailsDiv, barLeft, result: r } = scan
  const zoneLabel = zone === 'front' ? 'Front' : 'Back'
  if (!summaryDiv) return

  if (r.passed) {
    if (scan.uploadBuffer) {
      const blob = new Blob([scan.uploadBuffer], { type: 'image/jpeg' })
      const img = zoneDiv.querySelector('.zone-result-img')
      if (img) {
        img.src = URL.createObjectURL(blob)
        img.style.opacity = '1'
        img.alt = `${zoneLabel} processed`
      }
    }
    zoneDiv.classList.add('passed')
    if (barLeft) {
      barLeft.innerHTML = `<button class="scan-btn-remove" onclick="removeScan('${zone}', ${position})">Remove</button>`
    }
    let html = `<div class="scan-status ready">Ready</div>`

    // Scanner-style details
    if (r.imageDpi) {
      html += `<div class="scan-detail" style="margin-top:0.3rem">${r.imageDpi} DPI</div>`
    }
    if (r.cardWidth && r.cardHeight) {
      html += `<div class="scan-detail">Card: ${r.cardWidth}×${r.cardHeight}px</div>`
    }
    html += `<div class="scan-detail">Upload: ${(r.size / 1024).toFixed(1)}KB</div>`
    // Card identification result (front scans only)
    if (r.idResult) {
      const d = r.idResult
      if (d.ok) {
        html += `<div class="scan-detail" style="color:var(--text-dim)">ID: ${d.code} (d=${d.distance} m=${d.margin})</div>`
      } else {
        html += `<div class="scan-detail" style="color:#ef4444">ID: ${d.reason || 'fail'}</div>`
      }
    }
    if (r.backResult) {
      const br = r.backResult

    }
    for (const w of r.warnings || []) {
      html += `<div class="scan-detail" style="color:var(--text-dim)">⚠ ${w}</div>`
    }
    if (detailsDiv) {
      detailsDiv.innerHTML = html
    } else {
      summaryDiv.innerHTML = html
    }
  } else {
    if (barLeft) {
      barLeft.innerHTML = `<button class="scan-btn-remove" onclick="removeScan('${zone}', ${position})">Remove</button>`
    }
    let html = `<div class="scan-status fail">✗ Failed</div>`
    const errs = r.errors || []
    if (errs.length > 0) {
      for (const e of errs) html += `<div class="scan-fail-text">• ${e.message}</div>`
    } else {
      for (const f of r.failures || []) html += `<div class="scan-fail-text">• ${f}</div>`
    }
    if (r.backResult && !r.backResult.matched) {
      const br = r.backResult
      html += `<div class="scan-detail" style="color:var(--text-dim)">Back: hash=${br.hashDist}/256 · hist=${br.histSim}</div>`
    }
    if (detailsDiv) {
      detailsDiv.innerHTML = html
    } else {
      summaryDiv.innerHTML = html
    }
  }
}

function removeScan(zone, position) {
  if (zone === 'front') {
    if (cardState.front) {
      cardState.front.zoneDiv.classList.remove('passed')
      cardState.front.zoneDiv.innerHTML = '<div class="card-zone-placeholder">+</div><div class="card-zone-label-overlay">Front</div><input type="file" accept="image/*" style="display:none" />'
      const barLeft = document.getElementById('bar-left-front')
      const details = document.getElementById('details-front')
      if (barLeft) barLeft.innerHTML = ''
      if (details) details.innerHTML = ''
      cardState.front = null
    }
  } else if (zone === 'back') {
    if (cardState.back) {
      cardState.back.zoneDiv.classList.remove('passed')
      cardState.back.zoneDiv.innerHTML = '<div class="card-zone-placeholder">+</div><div class="card-zone-label-overlay">Back</div><input type="file" accept="image/*" style="display:none" />'
      const barLeft = document.getElementById('bar-left-back')
      const details = document.getElementById('details-back')
      if (barLeft) barLeft.innerHTML = ''
      if (details) details.innerHTML = ''
      cardState.back = null
    }
  }
  updateBatchBar()
}

function getAllScans() {
  return [cardState.front, cardState.back].filter(s => s !== null)
}

function updateBatchBar() {
  const btnUploadAll = document.getElementById('btn-upload-all')
  if (!btnUploadAll) return

  const all = getAllScans()
  const passed = all.filter(s => s.result && s.result.passed)
  const failed = all.filter(s => s.result && !s.result.passed)
  const analyzing = all.filter(s => !s.result)

  if (passed.length === 2 && failed.length === 0 && analyzing.length === 0) {
    btnUploadAll.disabled = false
  } else {
    btnUploadAll.disabled = true
  }
}

async function uploadAll() {
  const btnUploadAll = document.getElementById('btn-upload-all')
  const all = getAllScans()
  const passed = all.filter(s => s.result && s.result.passed && s.uploadBuffer)
  if (passed.length === 0) return

  btnUploadAll.disabled = true
  btnUploadAll.textContent = 'Uploading...'

  for (const scan of passed) {
    if (scan.summaryDiv) {
      const status = scan.summaryDiv.querySelector('.scan-status')
      if (status) {
        status.className = 'scan-status uploading'
        status.innerHTML = 'Uploading<span class="pulse-dots">...</span>'
      }
      if (scan.barLeft) scan.barLeft.querySelectorAll('.scan-btn-remove').forEach(b => b.disabled = true)
    }
  }

  try {
    const formData = new FormData()
    for (const scan of passed) {
      const blob = new Blob([scan.uploadBuffer], { type: 'image/jpeg' })
      const filename = scan.file.name.replace(/\.[^.]+$/, '.jpg')
      formData.append('files', blob, filename)
    }

    const postRes = await fetch(`${API}/upload-all`, { method: 'POST', body: formData })
    if (!postRes.ok) throw new Error(`Upload failed: ${postRes.status}`)
    const { jobId } = await postRes.json()
    if (!jobId) throw new Error('No jobId returned')

    const pollInterval = setInterval(() => pollUploadStatus(jobId), 2000)
    pollUploadStatus(jobId)

    async function pollUploadStatus(jobId) {
      try {
        const res = await fetch(`${API}/upload-status/${jobId}`)
        if (!res.ok) return
        const data = await res.json()

        for (const scan of passed) {
          const filename = scan.file.name.replace(/\.[^.]+$/, '.jpg')
          const upload = data.uploaded && data.uploaded.find(u => u.filename === filename)
          if (!scan.detailsDiv) continue

          if (upload) {
            let html = `<div class="scan-status pass">✓ Uploaded</div>`
            html += `<div class="scan-detail"><a href="https://whatsonchain.com/tx/${upload.txid}" target="_blank" rel="noopener">View on chain →</a></div>`
            scan.detailsDiv.innerHTML = html
          } else {
            const err = data.errors && data.errors.find(e => e.filename === filename)
            if (err) {
              scan.detailsDiv.innerHTML = `<div class="scan-status fail">✗ ${err.error}</div>`
            } else {
              const status = scan.detailsDiv.querySelector('.scan-status')
              if (status) {
                status.className = 'scan-status uploading'
                status.innerHTML = `${data.progress.message}`
              }
            }
          }
        }

        if (data.status === 'complete' || data.status === 'failed') {
          clearInterval(pollInterval)

          const summaryDiv = document.getElementById('upload-summary')
          if (data.uploaded && data.uploaded.length > 0) {
            let html = '<div class="upload-summary-title">✓ Card uploaded</div>'
            html += `<div class="scan-detail">`
            html += `<strong>${data.uploaded.length}</strong> image(s) uploaded`
            if (data.cardset) {
              html += ` + <strong>CARDSET</strong> created linking ${data.cardset.txidCount} images`
              html += `<br><span class="scan-label">CARDSET TXID:</span> <span class="scan-txid">${data.cardset.txid}</span>`
              html += `<br><span class="scan-label">Bind fee:</span> ${data.cardset.fee} sats`
              html += `<br><a href="https://whatsonchain.com/tx/${data.cardset.txid}" target="_blank" rel="noopener">View CARDSET on WhatsOnChain →</a>`
            }
            let totalFee = data.uploaded.reduce((sum, u) => sum + u.fee, 0)
            if (data.cardset) totalFee += data.cardset.fee
            html += `<br><span class="scan-label">Total fees:</span> ${totalFee} sats`
            html += `</div>`
            summaryDiv.innerHTML = html
            summaryDiv.classList.remove('hidden')
          }

          btnUploadAll.disabled = false
          btnUploadAll.textContent = 'Upload Images'

          loadStats().catch(() => {})
          loadCards(true).catch(() => {})
          loadWalletStatus().catch(() => {})
        }
      } catch (e) {
        // Network hiccup — keep polling
      }
    }
  } catch (err) {
    const errMsg = err.message || 'Upload failed'
    for (const scan of passed) {
      if (scan.detailsDiv) {
        scan.detailsDiv.innerHTML = `<div class="scan-status fail">✗ Error: ${errMsg}</div>`
      }
    }
    btnUploadAll.disabled = false
    btnUploadAll.textContent = 'Upload Images'
  }
}

async function loadCards(isRefresh) {
  const grid = document.getElementById('grid')
  const loading = document.getElementById('loading')
  const empty = document.getElementById('empty')

  try {
    const res = await fetch(`${API}/list`)
    const cards = await res.json()

    cards.sort((a, b) => {
      const aUnc = !a.blockHeight
      const bUnc = !b.blockHeight
      if (aUnc && !bUnc) return -1
      if (!aUnc && bUnc) return 1
      if (aUnc && bUnc) return 0
      return (b.blockHeight || 0) - (a.blockHeight || 0)
    })

    const seen = new Set()
    const deduped = cards.filter(c => {
      if (seen.has(c.hash)) return false
      seen.add(c.hash)
      return true
    })

    allCards = deduped
    loading.style.display = 'none'

    if (cards.length === 0) {
      empty.style.display = 'flex'
      grid.style.display = 'none'
      return
    }

    empty.style.display = 'none'
    grid.style.display = 'grid'
    grid.innerHTML = ''
    cards.forEach((card, i) => grid.appendChild(createCardElement(card, i)))
    loadStats()
  } catch (e) {
    loading.innerHTML = `<p style="color:#ef4444">Failed to load: ${e.message}</p>`
  }
}

function createCardElement(card, index) {
  const el = document.createElement('div')
  el.className = 'card'
  el.dataset.hash = card.hash
  const isUnconfirmed = !card.blockHeight

  el.innerHTML = `
    <div class="card-image-wrap loading" style="position:relative">
      <img class="card-image" alt="Upload ${shortHash(card.txid)}" />
      ${isUnconfirmed ? '<span class="card-badge unconfirmed">unconfirmed</span>' : ''}
    </div>
    <div class="card-info">
      <div class="card-txid" title="${card.txid}">${shortHash(card.txid)}</div>
    </div>
  `

  const img = el.querySelector('img')
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        img.src = `${API}/thumb/${card.hash}`
        img.onload = () => {
          const wrap = el.querySelector('.card-image-wrap')
          if (wrap) wrap.classList.remove('loading')
          img.classList.add('loaded')
        }
        img.onerror = () => {
          const wrap = el.querySelector('.card-image-wrap')
          if (wrap) wrap.classList.remove('loading')
          img.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="200" height="280"><rect width="200" height="280" fill="%231c1c22"/><text x="100" y="140" text-anchor="middle" fill="%235a5a66" font-size="14">Failed to load</text></svg>'
          img.classList.add('loaded')
        }
        observer.unobserve(el)
      }
    })
  }, { rootMargin: '200px' })

  observer.observe(el)
  el.addEventListener('click', () => navigate(`/cardimg/${card.txid}`))
  return el
}

// --- Cards Gallery: Card Code Directory ---

function getCardCodeForSet(set) {
  return cardCodeMappings[set.cardsetTxid] || null
}

function buildCodeCounts() {
  const counts = {}
  let uncategorized = 0
  allSets.forEach(set => {
    const code = getCardCodeForSet(set)
    if (code) {
      counts[code] = (counts[code] || 0) + 1
    } else {
      uncategorized++
    }
  })
  return { counts, uncategorized }
}

function renderCardCodeGrid() {
  const grid = document.getElementById('card-code-grid')
  if (!grid) return

  const { counts, uncategorized } = buildCodeCounts()
  const totalSets = allSets.length

  grid.innerHTML = ''

  const allItem = document.createElement('div')
  allItem.className = `card-code-item ${activeCardFilter === null ? 'active' : ''}`
  allItem.dataset.code = 'ALL'
  allItem.textContent = `All (${totalSets})`
  grid.appendChild(allItem)

  cardReference.forEach(card => {
    const count = counts[card.code] || 0
    const isActive = activeCardFilter === card.code
    const hasSets = count > 0
    const item = document.createElement('div')
    item.className = `card-code-item ${isActive ? 'active' : ''} ${hasSets ? '' : 'empty'}`
    item.dataset.code = card.code
    item.textContent = `${card.code} (${count})`
    grid.appendChild(item)
  })

  if (uncategorized > 0 || activeCardFilter === 'UNCATEGORIZED') {
    const isActive = activeCardFilter === 'UNCATEGORIZED'
    const item = document.createElement('div')
    item.className = `card-code-item uncategorized ${isActive ? 'active' : ''}`
    item.dataset.code = 'UNCATEGORIZED'
    item.textContent = `Uncategorized (${uncategorized})`
    grid.appendChild(item)
  }
}

function updateCardsetsFeedTitle() {}

// --- Cards Gallery: Cardsets Feed ---

async function loadSets(isRefresh) {
  const grid = document.getElementById('sets-grid')
  const loading = document.getElementById('sets-loading')
  const empty = document.getElementById('sets-empty')

  try {
    const res = await fetch(`${API}/sets/list`)
    const sets = await res.json()

    sets.sort((a, b) => {
      const aUnc = !a.blockHeight
      const bUnc = !b.blockHeight
      if (aUnc && !bUnc) return -1
      if (!aUnc && bUnc) return 1
      if (aUnc && bUnc) return 0
      return (b.blockHeight || 0) - (a.blockHeight || 0)
    })

    allSets = sets
    loading.style.display = 'none'
    renderCardCodeGrid()

    if (sets.length === 0) {
      empty.style.display = 'flex'
      grid.style.display = 'none'
      return
    }

    empty.style.display = 'none'
    grid.style.display = 'grid'
    renderSetsGrid()
    loadStats()
  } catch (e) {
    loading.innerHTML = `<p style="color:#ef4444">Failed to load: ${e.message}</p>`
  }
}

function getFilteredSets() {
  if (!activeCardFilter) return allSets
  if (activeCardFilter === 'UNCATEGORIZED') return allSets.filter(s => !getCardCodeForSet(s))
  return allSets.filter(s => getCardCodeForSet(s) === activeCardFilter)
}

function renderSetsGrid() {
  const grid = document.getElementById('sets-grid')
  if (!grid) return

  const filtered = getFilteredSets()

  if (filtered.length === 0) {
    grid.style.display = 'none'
    const empty = document.getElementById('sets-empty')
    if (empty) {
      empty.style.display = 'flex'
      empty.querySelector('p').textContent = activeCardFilter
        ? `No cardsets for ${activeCardFilter}.`
        : 'No cards indexed yet.'
    }
    return
  }

  const empty = document.getElementById('sets-empty')
  if (empty) empty.style.display = 'none'
  grid.style.display = 'grid'
  grid.innerHTML = ''
  filtered.forEach(set => grid.appendChild(createSetCard(set)))
}

function createSetCard(set) {
  const el = document.createElement('div')
  el.className = 'set-card'
  el.style.position = 'relative'
  const isUnconfirmed = !set.blockHeight
  const cardCode = getCardCodeForSet(set)

  const thumbSlots = set.txids.slice(0, 2).map(txid => {
    return `<div class="set-thumb-slot" data-txid="${txid}"><div class="set-placeholder"></div></div>`
  }).join('')

  el.innerHTML = `
    <div class="set-card-images">${thumbSlots}</div>
    <div class="set-card-info">
      <div class="set-card-left">
        <span class="set-card-txid" title="${set.cardsetTxid}">${shortHash(set.cardsetTxid)}</span>
      </div>
    </div>
    ${isUnconfirmed ? '<span class="set-card-badge" style="color:#fbbf24">unconfirmed</span>' : ''}
  `

  const slots = el.querySelectorAll('.set-thumb-slot')
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        slots.forEach(slot => {
          const txid = slot.dataset.txid
          const img = document.createElement('img')
          img.alt = 'Upload ' + shortHash(txid)
          img.onload = () => {
            slot.innerHTML = ''
            slot.appendChild(img)
            requestAnimationFrame(() => { img.style.opacity = '1' })
          }
          img.onerror = () => { slot.querySelector('.set-placeholder').textContent = 'N/A' }
          img.src = `${API}/thumb/tx/${txid}`
        })
        observer.unobserve(el)
      }
    })
  }, { rootMargin: '200px' })

  observer.observe(el)
  el.addEventListener('click', () => navigate(`/card/${set.cardsetTxid}`))
  return el
}

// =============================================
// UNIFIED IMMERSIVE VIEWER
// =============================================

function showViewer(txid, context) {
  // Hide gallery, show viewer
  document.getElementById('gallery-view').style.display = 'none'
  document.getElementById('viewer-page').style.display = ''
  document.getElementById('topbar').style.display = 'none'
  document.querySelector('footer').style.display = 'none'

  // Set tab active state
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === (context === 'cardset' ? 'cards' : 'uploads'))
  })

  // Reset state
  viewerContext = context
  viewerMembers = []
  viewerMemberIndex = 0
  viewerCardCode = null
  viewerCardRef = null
  document.getElementById('viewer-bottom').innerHTML = ''
  document.getElementById('viewer-meta').innerHTML = '<div class="spinner"></div>'
  document.getElementById('viewer-image').src = ''
  document.getElementById('viewer-loading').style.display = 'flex'

  if (context === 'cardset') {
    viewerCardCode = cardCodeMappings[txid]
    viewerCardRef = viewerCardCode ? cardReference.find(c => c.code === viewerCardCode) : null
    renderCardsetViewer(txid)
  } else {
    renderCardimgViewer(txid)
  }
}

// --- Cardset context ---

async function renderCardsetViewer(txid) {
  try {
    const res = await fetch(`${API}/sets/${txid}`)
    if (!res.ok) throw new Error('Card not found')
    const set = await res.json()

    viewerMembers = set.members || []
    document.getElementById('viewer-loading').style.display = 'none'

    // Load first member
    if (viewerMembers.length > 0) {
      selectViewerMember(0)
    }

    // Build thumbnail strip
    const bottom = document.getElementById('viewer-bottom')
    bottom.innerHTML = ''
    const strip = document.createElement('div')
    strip.className = 'viewer-thumb-strip'
    viewerMembers.forEach((member, i) => {
      const thumb = document.createElement('div')
      thumb.className = `viewer-thumb ${i === 0 ? 'active' : ''}`
      thumb.dataset.index = i
      const thumbImg = document.createElement('img')
      thumbImg.alt = member.role || `Member ${i}`
      thumbImg.src = member.hash ? `${API}/thumb/${member.hash}` : `${API}/thumb/tx/${member.txid}`
      thumbImg.onerror = () => { thumbImg.style.opacity = '0.3' }
      thumb.appendChild(thumbImg)
      thumb.addEventListener('click', e => {
        e.stopPropagation()
        selectViewerMember(i)
      })
      strip.appendChild(thumb)
    })
    bottom.appendChild(strip)

    // Build metadata
    let metaHtml = ''
    const isUnconfirmed = !set.blockHeight
    metaHtml += `
      <h3>Card TxID</h3>
      <a href="https://whatsonchain.com/tx/${set.cardsetTxid}" target="_blank" rel="noopener" style="display:block;margin-bottom:0.6rem;font-size:0.95rem">${set.cardsetTxid}</a>
      <h3>Block</h3>
      <p style="font-size:0.95rem">${isUnconfirmed ? '<span style="color:#fbbf24">Pending in mempool</span>' : set.blockHeight}</p>
      <h3>Members (${set.memberCount})</h3>
    `
    set.members.forEach(m => {
      metaHtml += `<p style="margin-top:0.6rem;margin-bottom:0.15rem;color:var(--text-dim);font-size:0.95rem">${m.role}</p>`
      metaHtml += `<a href="/cardimg/${m.txid}" style="display:block;margin-bottom:0.6rem;font-size:0.95rem">${m.txid}</a>`
    })
    document.getElementById('viewer-meta').innerHTML = metaHtml

  } catch (e) {
    document.getElementById('viewer-loading').style.display = 'none'
    document.getElementById('viewer-meta').innerHTML = `<p style="color:#ef4444">Failed to load: ${e.message}</p>`
  }
}

// --- Cardimg context ---

async function renderCardimgViewer(txid) {
  let card = allCards.find(c => c.txid === txid)

  if (!card) {
    try {
      const res = await fetch(`${API}/tx/${txid}`)
      if (!res.ok) throw new Error('Not found')
      const listRes = await fetch(`${API}/list`)
      const list = await listRes.json()
      card = list.find(c => c.txid === txid)
    } catch (e) {
      document.getElementById('viewer-loading').style.display = 'none'
      document.getElementById('viewer-meta').innerHTML = `<p style="color:#ef4444">Failed to load: ${e.message}</p>`
      return
    }
  }

  const img = document.getElementById('viewer-image')
  if (card) {
    const thumbUrl = `${API}/thumb/${card.hash}`
    const fullUrl = `${API}/img/${card.hash}`
    // Show thumbnail immediately, hide spinner as soon as it loads
    img.onload = () => {
      document.getElementById('viewer-loading').style.display = 'none'
    }
    img.onerror = () => {
      document.getElementById('viewer-loading').style.display = 'none'
      document.getElementById('viewer-meta').innerHTML = `<p style="color:#ef4444">Failed to load image</p>`
    }
    img.src = thumbUrl
    // Preload full-res in background, swap silently when ready
    const loadId = ++viewerLoadId
    const fullImg = new Image()
    fullImg.onload = () => {
      if (loadId !== viewerLoadId) return  // stale load, ignore
      img.src = fullUrl
    }
    fullImg.onerror = () => {
      if (loadId === viewerLoadId) {
        // Full-res failed — thumbnail is already shown, just keep it
      }
    }
    fullImg.src = fullUrl
  } else {
    img.src = `${API}/tx/${txid}`
    img.onload = () => { document.getElementById('viewer-loading').style.display = 'none' }
    img.onerror = () => {
      document.getElementById('viewer-loading').style.display = 'none'
      document.getElementById('viewer-meta').innerHTML = `<p style="color:#ef4444">Failed to load image</p>`
    }
  }

  // Build metadata
  let metaHtml = ''
  if (card) {
    const isUnconfirmed = !card.blockHeight
    metaHtml += `
      <h3>TxID</h3>
      <a href="https://whatsonchain.com/tx/${card.txid}" target="_blank" rel="noopener" style="display:block;margin-bottom:0.6rem;font-size:0.95rem">${card.txid}</a>
      <h3>Block</h3>
      <p style="font-size:0.95rem">${isUnconfirmed ? '<span style="color:#fbbf24">Pending in mempool</span>' : card.blockHeight}</p>
      <h3>Image Size</h3>
      <p style="font-size:0.95rem">${formatBytes(card.size)}</p>
      <h3>Direct Link</h3>
      <a href="${API}/img/${card.hash}" target="_blank" rel="noopener" style="display:block;margin-bottom:0.6rem;font-size:0.95rem">Open raw image →</a>
    `
  } else {
    metaHtml += `
      <h3>TxID</h3>
      <a href="https://whatsonchain.com/tx/${txid}" target="_blank" rel="noopener" style="display:block;margin-bottom:0.6rem;font-size:0.95rem">${txid}</a>
      <h3>Status</h3>
      <p style="font-size:0.95rem">Not in local index. Image fetched from chain.</p>
      <h3>Direct Link</h3>
      <a href="${API}/tx/${txid}" target="_blank" rel="noopener" style="display:block;margin-bottom:0.6rem;font-size:0.95rem">Open raw image →</a>
    `
  }

  // Fetch cardset associations
  if (card) {
    try {
      const res = await fetch(`${API}/card/${card.hash}/sets`)
      const data = await res.json()
      if (data.cardsets && data.cardsets.length > 0) {
        metaHtml += `<h3>${data.cardsets.length === 1 ? 'Member of card' : 'Member of cards'}</h3>`
        data.cardsets.forEach(s => {
          metaHtml += `<a href="/card/${s.cardsetTxid}" style="display:block;margin-bottom:0.6rem;font-size:0.95rem">${s.cardsetTxid}</a>`
        })

// (Appears-in chips section removed — kept in metadata only)
      }
    } catch (e) {}
  }

  document.getElementById('viewer-meta').innerHTML = metaHtml
}

// --- Viewer interactions ---

function selectViewerMember(index) {
  if (!viewerMembers.length) return
  viewerMemberIndex = Math.max(0, Math.min(index, viewerMembers.length - 1))
  const member = viewerMembers[viewerMemberIndex]

  const img = document.getElementById('viewer-image')
  const thumbUrl = member.hash ? `${API}/thumb/${member.hash}` : `${API}/thumb/tx/${member.txid}`
  const fullUrl = member.hash ? `${API}/img/${member.hash}` : `${API}/tx/${member.txid}`

  // Load thumbnail first for instant display, then swap to full-res
  img.src = thumbUrl
  const loadId = ++viewerLoadId
  const fullImg = new Image()
  fullImg.onload = () => {
    if (loadId !== viewerLoadId) return  // stale load, ignore
    img.src = fullUrl
  }
  fullImg.src = fullUrl

  img.alt = `Upload ${shortHash(member.txid)}`

  // Update active thumb
  document.querySelectorAll('.viewer-thumb').forEach((t, i) => {
    t.classList.toggle('active', i === viewerMemberIndex)
  })
  resetViewerZoom()
}

function cycleMember(direction) {
  if (!viewerMembers.length) return
  const newIndex = viewerMemberIndex + direction
  if (newIndex < 0 || newIndex >= viewerMembers.length) return
  selectViewerMember(newIndex)
}

// Pan/zoom state
let vzScale = 1
let vzX = 0
let vzY = 0
let vzDragging = false
let vzLastX = 0
let vzLastY = 0
let vzTouchDist = 0
let vzTouchStartScale = 1
let vzDidDrag = false

function toggleZoom() {
  if (vzScale > 1) {
    vzScale = 1
    vzX = 0
    vzY = 0
    updateViewerTransform()
  } else {
    vzScale = 2
    updateViewerTransform()
  }
}
function updateViewerTransform() {
  const img = document.getElementById('viewer-image')
  const wrap = document.getElementById('viewer-image-wrap')
  img.style.transform = `translate(${vzX}px, ${vzY}px) scale(${vzScale})`
  img.style.cursor = vzScale > 1 ? (vzDragging ? 'grabbing' : 'grab') : 'zoom-in'
  // Allow page scroll at scale=1, capture all touches when zoomed
  wrap.style.touchAction = vzScale > 1 ? 'none' : 'pan-y'
}

function initViewerPanZoom() {
  const wrap = document.getElementById('viewer-image-wrap')
  const img = document.getElementById('viewer-image')

  // Wheel to zoom
  wrap.addEventListener('wheel', e => {
    if (vzScale === 1 && e.deltaY > 0) return
    e.preventDefault()
    const delta = e.deltaY > 0 ? 0.9 : 1.1
    const oldScale = vzScale
    vzScale = Math.min(Math.max(vzScale * delta, 1), 8)
    if (vzScale === 1) {
      vzX = 0; vzY = 0
    } else {
      // Zoom toward cursor
      const rect = wrap.getBoundingClientRect()
      const cx = e.clientX - rect.width / 2 - vzX
      const cy = e.clientY - rect.height / 2 - vzY
      const ratio = vzScale / oldScale
      vzX = e.clientX - rect.width / 2 - cx * ratio
      vzY = e.clientY - rect.height / 2 - cy * ratio
    }
    updateViewerTransform()
  }, { passive: false })

  // Double-click to reset
  img.addEventListener('dblclick', e => {
    e.stopPropagation()
    vzScale = 1
    vzX = 0
    vzY = 0
    updateViewerTransform()
  })

  // Drag to pan (only when zoomed in)
  img.addEventListener('mousedown', e => {
    if (vzScale <= 1) return
    e.preventDefault()
    vzDragging = true
    vzDidDrag = false
    vzLastX = e.clientX
    vzLastY = e.clientY
    img.style.cursor = 'grabbing'
  })

  document.addEventListener('mousemove', e => {
    if (!vzDragging) return
    const dx = e.clientX - vzLastX
    const dy = e.clientY - vzLastY
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) vzDidDrag = true
    vzX += dx
    vzY += dy
    vzLastX = e.clientX
    vzLastY = e.clientY
    updateViewerTransform()
  })

  document.addEventListener('mouseup', () => {
    if (vzDragging) {
      vzDragging = false
      img.style.cursor = vzScale > 1 ? 'grab' : 'zoom-in'
    }
  })

  // Touch: pinch to zoom + drag to pan
  wrap.addEventListener('touchstart', e => {
    if (e.touches.length === 1 && vzScale > 1) {
      vzDragging = true
      vzLastX = e.touches[0].clientX
      vzLastY = e.touches[0].clientY
    } else if (e.touches.length === 2) {
      vzDragging = false
      const dx = e.touches[0].clientX - e.touches[1].clientX
      const dy = e.touches[0].clientY - e.touches[1].clientY
      vzTouchDist = Math.sqrt(dx * dx + dy * dy)
      vzTouchStartScale = vzScale
    }
  }, { passive: true })

  wrap.addEventListener('touchmove', e => {
    if (e.touches.length === 2) {
      // Pinch to zoom — works from any scale including 1
      e.preventDefault()
      const dx = e.touches[0].clientX - e.touches[1].clientX
      const dy = e.touches[0].clientY - e.touches[1].clientY
      const dist = Math.sqrt(dx * dx + dy * dy)
      const oldScale = vzScale
      vzScale = Math.min(Math.max(vzTouchStartScale * (dist / vzTouchDist), 1), 8)
      if (vzScale === 1) {
        vzX = 0; vzY = 0
      } else {
        // Zoom toward pinch midpoint
        const rect = wrap.getBoundingClientRect()
        const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2
        const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2
        const cx = midX - rect.left - rect.width / 2 - vzX
        const cy = midY - rect.top - rect.height / 2 - vzY
        const ratio = vzScale / oldScale
        vzX = midX - rect.left - rect.width / 2 - cx * ratio
        vzY = midY - rect.top - rect.height / 2 - cy * ratio
      }
      updateViewerTransform()
    } else if (e.touches.length === 1 && vzDragging && vzScale > 1) {
      e.preventDefault()
      const dx = e.touches[0].clientX - vzLastX
      const dy = e.touches[0].clientY - vzLastY
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) vzDidDrag = true
      vzX += dx
      vzY += dy
      vzLastX = e.touches[0].clientX
      vzLastY = e.touches[0].clientY
      updateViewerTransform()
    }
  }, { passive: false })

  wrap.addEventListener('touchend', () => {
    vzDragging = false
    img.style.cursor = vzScale > 1 ? 'grab' : 'zoom-in'
  }, { passive: true })
}

// Reset pan/zoom when switching members
function resetViewerZoom() {
  vzScale = 1
  vzX = 0
  vzY = 0
  updateViewerTransform()
}

// --- Utils ---

function shortHash(hash) {
  if (!hash) return ''
  return hash.slice(0, 6) + '...' + hash.slice(-6)
}

function formatBytes(bytes) {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let val = bytes
  while (val >= 1024 && i < units.length - 1) { val /= 1024; i++ }
  return val.toFixed(i === 0 ? 0 : 1) + ' ' + units[i]
}
