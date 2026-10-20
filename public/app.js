/* CARDIMG Viewer — Client logic with routing + card code directory */

const API = window.CARDIMG_API != null ? window.CARDIMG_API : 'http://localhost:3014'
let allCards = []
let allSets = []
let cardReference = []      // 42 card codes from card-reference.json
let cardCodeMappings = {}   // { cardsetTxid → cardCode } from card-codes.json
let activeCardFilter = null // null = show all, or 'C01' etc.
let activeTab = 'cards'

// --- Init ---

document.addEventListener('DOMContentLoaded', () => {
  // Brand click → home
  document.getElementById('brand-link').addEventListener('click', e => {
    e.preventDefault()
    navigate('/')
  })

  // Tab switching
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab
      navigate(tab === 'cards' ? '/' : '/uploads')
    })
  })

  document.addEventListener('click', e => {
    const backLink = e.target.closest('.back-link')
    const viewLink = e.target.closest('.cardset-view-link')
    const codeChip = e.target.closest('.card-code-item')
    const clearFilter = e.target.closest('#clear-filter-btn')

    if (clearFilter) {
      e.preventDefault()
      activeCardFilter = null
      updateCardsetsFeedTitle()
      renderSetsGrid()
      renderCardCodeGrid()
    } else if (codeChip) {
      e.preventDefault()
      const code = codeChip.dataset.code
      // Toggle off if clicking same
      if (activeCardFilter === code) {
        activeCardFilter = null
      } else {
        activeCardFilter = code
      }
      updateCardsetsFeedTitle()
      renderCardCodeGrid()
      renderSetsGrid()
      // Scroll down to feed
      document.getElementById('cardsets-feed').scrollIntoView({ behavior: 'smooth', block: 'start' })
    } else if (backLink) {
      e.preventDefault()
      window.history.back()
    } else if (viewLink) {
      e.preventDefault()
      navigate(viewLink.getAttribute('href'))
    }
  })

  // Lightbox interactions
  initLightbox()

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
  // If we're on the cards tab, render the grid
  if (activeTab === 'cards') {
    renderCardCodeGrid()
  }
}

// --- Routing ---

window.addEventListener('popstate', handleRoute)

function handleRoute() {
  const path = window.location.pathname

  // /cardimg/:txid — upload detail page
  if (path.startsWith('/cardimg/')) {
    const txid = path.replace('/cardimg/', '')
    showUploadPage(txid)
    return
  }

  // /card/:txid — card detail page
  if (path.startsWith('/card/')) {
    const txid = path.replace('/card/', '')
    showCardPage(txid)
    return
  }

  // /uploads — uploads tab
  if (path === '/uploads') {
    showGallery('uploads')
    return
  }

  // / — cards tab (default)
  showGallery('cards')
}

function navigate(path) {
  window.history.pushState({}, '', path)
  handleRoute()
  window.scrollTo(0, 0)
}

function showGallery(tab) {
  activeTab = tab
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === (tab === 'cards' ? 'cards' : 'uploads'))
  })

  document.getElementById('gallery-view').style.display = ''
  document.getElementById('upload-page').style.display = 'none'
  document.getElementById('card-page').style.display = 'none'

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
    // Render card code grid (may already be loaded from init)
    renderCardCodeGrid()
  }
}

function showUploadPage(txid) {
  document.getElementById('gallery-view').style.display = 'none'
  document.getElementById('card-page').style.display = 'none'
  document.getElementById('upload-page').style.display = ''
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === 'uploads'))
  renderUploadPage(txid)
}

function showCardPage(txid) {
  document.getElementById('gallery-view').style.display = 'none'
  document.getElementById('upload-page').style.display = 'none'
  document.getElementById('card-page').style.display = ''
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === 'cards'))
  renderCardPage(txid)
}

// --- Stats ---

async function loadStats() {
  try {
    const res = await fetch(`${API}/stats`)
    const data = await res.json()
    document.getElementById('stat-count').textContent = data.totalImages.toLocaleString()
    document.getElementById('stat-size')?.textContent ? '' : '' // stat-size may not exist

    if (data.sets) {
      const setsStats = document.getElementById('sets-stats')
      if (setsStats) setsStats.textContent = ''
    }
  } catch (e) {
    // silent fail
  }
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

    // Deduplicate by hash — same image uploaded multiple times = show once
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

    cards.forEach((card, i) => {
      grid.appendChild(createCardElement(card, i))
    })

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
      <div class="card-size">${formatBytes(card.size)}</div>
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

// --- Upload Detail Page ---

async function renderUploadPage(txid) {
  const img = document.getElementById('upload-image')
  const meta = document.getElementById('upload-meta')

  const h1 = document.querySelector('#upload-page .page-header h1')
  h1.innerHTML = '<span class="header-protocol">CARDIMG</span> <span class="header-txid">' + txid + '</span>'

  img.src = ''
  meta.innerHTML = '<div class="spinner"></div>'

  let card = allCards.find(c => c.txid === txid)

  if (!card) {
    try {
      const res = await fetch(`${API}/tx/${txid}`)
      if (!res.ok) throw new Error('Not found')
      const listRes = await fetch(`${API}/list`)
      const list = await listRes.json()
      card = list.find(c => c.txid === txid)
    } catch (e) {
      meta.innerHTML = `<p style="color:#ef4444">Failed to load: ${e.message}</p>`
      return
    }
  }

  if (!card) {
    img.src = `${API}/thumb/tx/${txid}`
    meta.innerHTML = `
      <h3>TxID</h3>
      <div class="meta-value">${txid}</div>
      <a href="https://whatsonchain.com/tx/${txid}" target="_blank" rel="noopener">View on WhatsOnChain →</a>
      <h3>Status</h3>
      <p>Not in local index. Image fetched from chain.</p>
      <h3>Direct Link</h3>
      <a href="${API}/tx/${txid}" target="_blank" rel="noopener">Open raw image →</a>
    `
    return
  }

  img.src = `${API}/thumb/${card.hash}`

  const isUnconfirmed = !card.blockHeight

  // Fetch card associations
  let cardsetHtml = ''
  try {
    const res = await fetch(`${API}/card/${card.hash}/sets`)
    const data = await res.json()
    if (data.cardsets && data.cardsets.length > 0) {
      const refs = await Promise.all(data.cardsets.map(async s => {
        const setRes = await fetch(`${API}/sets/${s.cardsetTxid}`)
        const setData = await setRes.json()
        const others = (setData.members || []).filter(m => m.txid !== card.txid)
        const thumbs = others.map(m => {
          const src = m.hash ? `${API}/thumb/${m.hash}` : `${API}/thumb/tx/${m.txid}`
          return `<img src="${src}" alt="${shortHash(m.txid)}" class="cardset-thumb" onclick="navigate('/cardimg/${m.txid}')" />`
        }).join('')
        return `
          <div class="cardset-ref">
            <div class="cardset-thumbs">${thumbs}</div>
            <a href="/card/${s.cardsetTxid}" class="cardset-view-link">View card →</a>
          </div>
        `
      }))
      cardsetHtml = `
        <h3>Appears in ${data.cardsets.length} card${data.cardsets.length > 1 ? 's' : ''}</h3>
        ${refs.join('')}
      `
    }
  } catch (e) {}

  meta.innerHTML = `
    <h3>TxID</h3>
    <div class="meta-value">${card.txid}</div>
    <a href="https://whatsonchain.com/tx/${card.txid}" target="_blank" rel="noopener">View on WhatsOnChain →</a>

    <h3>Block</h3>
    <p>${isUnconfirmed ? '<span style="color:#fbbf24">Unconfirmed (mempool)</span>' : card.blockHeight}</p>

    <h3>Image Size</h3>
    <p>${formatBytes(card.size)}</p>

    <h3>Direct Link</h3>
    <a href="${API}/img/${card.hash}" target="_blank" rel="noopener">Open raw image →</a>

    ${cardsetHtml}
  `
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

  // Update stats
  const statsEl = document.getElementById('card-code-stats')
  if (statsEl) statsEl.textContent = `${totalSets} cards`

  grid.innerHTML = ''

  // Render all 42 reference codes
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

  // Uncategorized bucket
  if (uncategorized > 0 || activeCardFilter === 'UNCATEGORIZED') {
    const isActive = activeCardFilter === 'UNCATEGORIZED'
    const item = document.createElement('div')
    item.className = `card-code-item uncategorized ${isActive ? 'active' : ''}`
    item.dataset.code = 'UNCATEGORIZED'
    item.textContent = `Uncategorized (${uncategorized})`
    grid.appendChild(item)
  }
}

function updateCardsetsFeedTitle() {
  const titleEl = document.getElementById('cardsets-feed-title')
  const clearBtn = document.getElementById('clear-filter-btn')
  if (activeCardFilter) {
    if (activeCardFilter === 'UNCATEGORIZED') {
      titleEl.textContent = 'Uncategorized Cardsets'
    } else {
      const ref = cardReference.find(c => c.code === activeCardFilter)
      titleEl.textContent = ref ? `${activeCardFilter} — ${ref.name}` : activeCardFilter
    }
    if (clearBtn) clearBtn.style.display = ''
  } else {
    titleEl.textContent = 'Newest Cardsets'
    if (clearBtn) clearBtn.style.display = 'none'
  }
}

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

  if (activeCardFilter === 'UNCATEGORIZED') {
    return allSets.filter(s => !getCardCodeForSet(s))
  }

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

  filtered.forEach(set => {
    grid.appendChild(createSetCard(set))
  })

  // Update sets count
  const setsStats = document.getElementById('sets-stats')
  if (setsStats) {
    setsStats.textContent = ''
  }
}

function createSetCard(set) {
  const el = document.createElement('div')
  el.className = 'set-card'
  el.style.position = 'relative'

  const isUnconfirmed = !set.blockHeight
  const cardCode = getCardCodeForSet(set)

  const thumbSlots = set.txids.slice(0, 2).map(txid => {
    return `<div class="set-thumb-slot" data-txid="${txid}"><div class="set-placeholder">…</div></div>`
  }).join('')

  el.innerHTML = `
    <div class="set-card-images">${thumbSlots}</div>
    ${cardCode ? `<span class="set-card-code">${cardCode}</span>` : ''}
    <div class="set-card-info">
      <div class="set-card-left">
        <span class="set-card-txid" title="${set.cardsetTxid}">${shortHash(set.cardsetTxid)}</span>
      </div>
      <div class="set-card-members">${set.memberCount} uploads</div>
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
          }
          img.onerror = () => {
            slot.querySelector('.set-placeholder').textContent = 'N/A'
          }
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

// --- Card Detail Page ---

async function renderCardPage(txid) {
  const img = document.getElementById('card-primary-image')
  const metaEl = document.getElementById('card-detail-meta')
  const thumbStrip = document.getElementById('card-thumb-strip')
  const zoomHint = document.getElementById('card-zoom-hint')

  const h1 = document.querySelector('#card-page .page-header h1')
  const cardCode = cardCodeMappings[txid]
  const ref = cardCode ? cardReference.find(c => c.code === cardCode) : null

  if (cardCode && ref) {
    h1.innerHTML = `<span class="header-protocol">CARDSET</span> <span class="header-card-code">${cardCode}</span> <span class="header-card-name">${ref.name}</span>`
  } else {
    h1.innerHTML = '<span class="header-protocol">CARDSET</span> <span class="header-txid">' + txid + '</span>'
  }

  img.src = ''
  metaEl.innerHTML = '<div class="spinner"></div>'
  thumbStrip.innerHTML = ''

  // Track current member for lightbox full-res
  let currentMember = null

  // Click primary image to open lightbox (full-res)
  img.addEventListener('click', () => {
    if (!currentMember) return
    const fullSrc = currentMember.hash ? `${API}/img/${currentMember.hash}` : `${API}/tx/${currentMember.txid}`
    openLightbox(fullSrc)
  })

  try {
    const res = await fetch(`${API}/sets/${txid}`)
    if (!res.ok) throw new Error('Card not found')
    const set = await res.json()

    const isUnconfirmed = !set.blockHeight

    // Build metadata sidebar
    let metaHtml = ''

    if (cardCode && ref) {
      metaHtml += `
        <h3>Card Code</h3>
        <p>${cardCode} — ${ref.name}</p>
        <p style="color:var(--text-dim);font-size:0.8rem">${ref.title}</p>
      `
    }

    metaHtml += `
      <h3>Cardset TxID</h3>
      <div class="meta-value">${set.cardsetTxid}</div>
      <a href="https://whatsonchain.com/tx/${set.cardsetTxid}" target="_blank" rel="noopener">View on WhatsOnChain →</a>

      <h3>Status</h3>
      <p>${isUnconfirmed ? '<span style="color:#fbbf24">Unconfirmed (mempool)</span>' : 'Confirmed'}</p>

      <h3>Members</h3>
      <p>${set.memberCount} card${set.memberCount !== 1 ? 's' : ''} in this set</p>
    `

    set.members.forEach(m => {
      metaHtml += `<p style="margin-bottom:0.3rem"><a href="/cardimg/${m.txid}" style="color:var(--text-dim)">${m.role}</a> — <span style="font-family:'SF Mono','Fira Code',monospace;font-size:0.72rem;color:var(--text-faint)">${shortHash(m.txid)}</span></p>`
    })

    metaEl.innerHTML = metaHtml

    // Select a member into the primary image
    function selectMember(member) {
      currentMember = member
      const src = member.hash ? `${API}/thumb/${member.hash}` : `${API}/thumb/tx/${member.txid}`
      img.src = src
      img.alt = `Upload ${shortHash(member.txid)}`
      // Update active thumb
      thumbStrip.querySelectorAll('.card-thumb').forEach(t => t.classList.remove('active'))
      const activeThumb = thumbStrip.querySelector(`[data-txid="${member.txid}"]`)
      if (activeThumb) activeThumb.classList.add('active')
    }

    // Build thumbnails
    set.members.forEach(member => {
      const thumb = document.createElement('div')
      thumb.className = 'card-thumb'
      thumb.dataset.txid = member.txid

      const thumbImg = document.createElement('img')
      thumbImg.alt = `Upload ${shortHash(member.txid)}`
      const thumbSrc = member.hash ? `${API}/thumb/${member.hash}` : `${API}/thumb/tx/${member.txid}`
      thumbImg.src = thumbSrc
      thumbImg.onerror = () => {
        thumbImg.style.display = 'none'
        const ph = document.createElement('div')
        ph.className = 'set-member-placeholder'
        ph.textContent = 'N/A'
        thumb.insertBefore(ph, thumb.firstChild)
      }
      thumb.appendChild(thumbImg)

      const thumbRole = document.createElement('div')
      thumbRole.className = 'card-thumb-role'
      thumbRole.textContent = member.role
      thumb.appendChild(thumbRole)

      thumb.addEventListener('click', () => selectMember(member))
      thumbStrip.appendChild(thumb)
    })

    // Load front card (position 0) as default
    if (set.members.length > 0) {
      selectMember(set.members[0])
    }
  } catch (e) {
    metaEl.innerHTML = `<p style="color:#ef4444">Failed to load: ${e.message}</p>`
  }
}

// --- Lightbox ---

let lbScale = 1
let lbX = 0
let lbY = 0
let lbDragging = false
let lbLastX = 0
let lbLastY = 0

function openLightbox(src) {
  const lb = document.getElementById('lightbox')
  const img = document.getElementById('lightbox-img')
  img.src = src
  lb.style.display = 'flex'
  document.body.style.overflow = 'hidden'
  lbScale = 1
  lbX = 0
  lbY = 0
  updateLightboxTransform()
}

function closeLightbox() {
  const lb = document.getElementById('lightbox')
  lb.style.display = 'none'
  document.getElementById('lightbox-img').src = ''
  document.body.style.overflow = ''
}

function updateLightboxTransform() {
  const img = document.getElementById('lightbox-img')
  img.style.transform = `translate(${lbX}px, ${lbY}px) scale(${lbScale})`
}

// Init lightbox interactions
function initLightbox() {
  const lb = document.getElementById('lightbox')
  const img = document.getElementById('lightbox-img')

  // Close on background click
  lb.addEventListener('click', e => {
    if (e.target === lb || e.target.id === 'lightbox-close') closeLightbox()
  })

  // ESC to close
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeLightbox()
  })

  // Wheel to zoom
  lb.addEventListener('wheel', e => {
    if (lb.style.display === 'none') return
    e.preventDefault()
    const delta = e.deltaY > 0 ? 0.9 : 1.1
    const oldScale = lbScale
    lbScale = Math.min(Math.max(lbScale * delta, 0.5), 8)
    // Zoom toward cursor (both directions)
    const rect = lb.getBoundingClientRect()
    const cx = e.clientX - rect.width / 2 - lbX
    const cy = e.clientY - rect.height / 2 - lbY
    const ratio = lbScale / oldScale
    lbX = e.clientX - rect.width / 2 - cx * ratio
    lbY = e.clientY - rect.height / 2 - cy * ratio
    updateLightboxTransform()
  }, { passive: false })

  // Double-click to reset
  img.addEventListener('dblclick', e => {
    e.stopPropagation()
    lbScale = 1
    lbX = 0
    lbY = 0
    updateLightboxTransform()
  })

  // Drag to pan
  img.addEventListener('mousedown', e => {
    e.preventDefault()
    lbDragging = true
    lbLastX = e.clientX
    lbLastY = e.clientY
    img.style.cursor = 'grabbing'
  })

  document.addEventListener('mousemove', e => {
    if (!lbDragging) return
    lbX += e.clientX - lbLastX
    lbY += e.clientY - lbLastY
    lbLastX = e.clientX
    lbLastY = e.clientY
    updateLightboxTransform()
  })

  document.addEventListener('mouseup', () => {
    if (lbDragging) {
      lbDragging = false
      img.style.cursor = 'grab'
    }
  })

  // Touch: pinch to zoom + drag to pan
  let touchDist = 0
  let touchStartScale = 1

  lb.addEventListener('touchstart', e => {
    if (e.touches.length === 1) {
      lbDragging = true
      lbLastX = e.touches[0].clientX
      lbLastY = e.touches[0].clientY
    } else if (e.touches.length === 2) {
      lbDragging = false
      const dx = e.touches[0].clientX - e.touches[1].clientX
      const dy = e.touches[0].clientY - e.touches[1].clientY
      touchDist = Math.sqrt(dx * dx + dy * dy)
      touchStartScale = lbScale
    }
  }, { passive: true })

  lb.addEventListener('touchmove', e => {
    if (lb.style.display === 'none') return
    e.preventDefault()
    if (e.touches.length === 1 && lbDragging) {
      lbX += e.touches[0].clientX - lbLastX
      lbY += e.touches[0].clientY - lbLastY
      lbLastX = e.touches[0].clientX
      lbLastY = e.touches[0].clientY
      updateLightboxTransform()
    } else if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX
      const dy = e.touches[0].clientY - e.touches[1].clientY
      const dist = Math.sqrt(dx * dx + dy * dy)
      lbScale = Math.min(Math.max(touchStartScale * (dist / touchDist), 0.5), 8)
      updateLightboxTransform()
    }
  }, { passive: false })

  lb.addEventListener('touchend', () => {
    lbDragging = false
  }, { passive: true })
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
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024
    i++
  }
  return val.toFixed(i === 0 ? 0 : 1) + ' ' + units[i]
}
