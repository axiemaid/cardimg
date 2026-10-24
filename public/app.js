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
      navigate(tab === 'cards' ? '/' : '/uploads')
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

  if (path === '/uploads') {
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

// --- Uploads Gallery ---

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
    <div class="card-image-wrap" style="position:relative">
      <img class="card-image loading" alt="Upload ${shortHash(card.txid)}" />
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
        img.onload = () => img.classList.remove('loading')
        img.onerror = () => {
          img.classList.remove('loading')
          img.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="200" height="280"><rect width="200" height="280" fill="%231c1c22"/><text x="100" y="140" text-anchor="middle" fill="%235a5a66" font-size="14">Failed to load</text></svg>'
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
          img.onload = () => { slot.innerHTML = ''; slot.appendChild(img) }
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
