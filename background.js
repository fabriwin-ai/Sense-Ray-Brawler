// ============================================================
//  SENSE RAY — Background Service Worker (MV3)
//
//  Message flows:
//    overlay (index.js) → GAZE_POS / GAZE_PING → background
//      └─ GAZE_ACK  via runtime.sendMessage ──→ overlay (index.js)
//      └─ GAZE_POS  via tabs.sendMessage ────→ active tab content.js
//
//    content.js → SITE_INFO → background
//      └─ SITE_MODE via runtime.sendMessage ─→ overlay (index.js)
//
//    popup → OPEN_OVERLAY / CLOSE_OVERLAY → background
//
//  NOTE: The overlay is an extension page (chrome-extension://...),
//  NOT a content-script tab. chrome.tabs.sendMessage only reaches
//  content scripts, so messages TO the overlay must use
//  chrome.runtime.sendMessage. Messages TO normal pages use tabs.
// ============================================================

'use strict'
importScripts('ray-presets.js')

const RAY_PRESETS = globalThis.SENSE_RAY_PRESETS
const RAY_KEYS = globalThis.SENSE_RAY_STORAGE_KEYS

let overlayWinId = null   // chrome.windows ID of the gaze overlay window
let overlayTabId = null   // chrome.tabs  ID of the overlay tab
let activeTabId  = null   // tab being controlled by gaze

function boundedNumber(value, fallback, min, max) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback
}

function sanitizeCursorStyle(style, fallback = {}) {
  const safe = style && typeof style === 'object' ? style : {}
  const base = fallback && typeof fallback === 'object' ? fallback : RAY_PRESETS.sense.cursor
  const color = /^#[0-9a-f]{6}$/i.test(safe.color || '') ? safe.color : base.color
  return {
    color,
    size: boundedNumber(safe.size, base.size, 8, 40),
    glow: boundedNumber(safe.glow, base.glow, 0, 40),
    opacity: boundedNumber(safe.opacity, base.opacity, 0.2, 1),
    holdMs: boundedNumber(safe.holdMs, base.holdMs, 100, 1500)
  }
}

async function getActivePageId() {
  if (activeTabId !== null) {
    try {
      const tab = await chrome.tabs.get(activeTabId)
      if (isContentTab(tab) && tab.id !== overlayTabId) return tab.id
    } catch (_) {}
  }
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  const tab = tabs.find(item => isContentTab(item) && item.id !== overlayTabId)
  if (tab) activeTabId = tab.id
  return tab?.id ?? null
}

async function sendToActivePage(message) {
  const tabId = await getActivePageId()
  if (tabId === null) return
  try { await chrome.tabs.sendMessage(tabId, message) } catch (_) {}
}

async function getRayState() {
  const [local, session] = await Promise.all([
    chrome.storage.local.get([RAY_KEYS.preset, RAY_KEYS.cursor]),
    chrome.storage.session.get('gazeActive')
  ])
  const preset = RAY_PRESETS[local[RAY_KEYS.preset]] ? local[RAY_KEYS.preset] : 'sense'
  return {
    ok: true,
    active: Boolean(session.gazeActive),
    preset,
    cursor: sanitizeCursorStyle(local[RAY_KEYS.cursor], RAY_PRESETS[preset].cursor)
  }
}

async function saveRayConfiguration(presetId, cursorStyle, applyPreset = false) {
  const preset = RAY_PRESETS[presetId] ? presetId : 'sense'
  const cursor = sanitizeCursorStyle(cursorStyle, RAY_PRESETS[preset].cursor)
  await chrome.storage.local.set({ [RAY_KEYS.preset]: preset, [RAY_KEYS.cursor]: cursor })
  const message = { type: 'RAY_CONFIGURATION_CHANGED', preset, cursor, applyPreset }
  await Promise.all([
    sendToActivePage(message),
    chrome.runtime.sendMessage(message).catch(() => {})
  ])
  return getRayState()
}

// ── Track the active browsing tab ────────────────────────────
// Ignore the overlay window itself and chrome:// / extension pages.
function isContentTab(tab) {
  return tab && tab.url &&
    !tab.url.startsWith('chrome-extension://') &&
    !tab.url.startsWith('chrome://') &&
    !tab.url.startsWith('about:')
}

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId, tab => {
    if (chrome.runtime.lastError) return
    if (isContentTab(tab)) activeTabId = tabId
  })
})

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.status !== 'complete') return
  if (!isContentTab(tab) || tabId === overlayTabId) return
  activeTabId = tabId
  // Ask newly-loaded content script for site info
  chrome.tabs.sendMessage(tabId, { type: 'QUERY_SITE' }).catch(() => {})
})

// ── Central message router ────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg?.type) return

  switch (msg.type) {

    // ── Gaze position from overlay (index.js) ─────────────────
    case 'GAZE_POS':
    case 'GAZE_PING':
      // 1. Acknowledge back to overlay via runtime (extension page)
      //    tabs.sendMessage does NOT reach extension pages.
      chrome.runtime.sendMessage({ type: 'GAZE_ACK' }).catch(() => {})

      // 2. Forward gaze to the active browsing tab's content.js
      if (activeTabId && activeTabId !== overlayTabId) {
        chrome.tabs.sendMessage(activeTabId, msg).catch(() => {})
      }
      break

    // ── Site report from content script ──────────────────────
    case 'SITE_INFO':
      // Relay detected site to overlay so it can adjust grid mode
      chrome.runtime.sendMessage({ type: 'SITE_MODE', site: msg.site }).catch(() => {})
      break

    // ── Popup controls ────────────────────────────────────────
    case 'OPEN_OVERLAY':
      openOverlay().then(() => getRayState()).then(sendResponse)
        .catch(error => sendResponse({ ok: false, error: error.message }))
      return true

    case 'CLOSE_OVERLAY':
      closeOverlay().then(() => getRayState()).then(sendResponse)
        .catch(error => sendResponse({ ok: false, error: error.message }))
      return true

    case 'GET_RAY_STATE':
      getRayState().then(sendResponse)
        .catch(error => sendResponse({ ok: false, error: error.message }))
      return true

    case 'APPLY_RAY_PRESET':
      if (!RAY_PRESETS[msg.preset]) {
        sendResponse({ ok: false, error: 'Unknown ray preset.' })
        return false
      }
      saveRayConfiguration(msg.preset, RAY_PRESETS[msg.preset].cursor, true).then(sendResponse)
        .catch(error => sendResponse({ ok: false, error: error.message }))
      return true

    case 'SAVE_RAY_CONFIGURATION':
      saveRayConfiguration(msg.preset, msg.cursor).then(sendResponse)
        .catch(error => sendResponse({ ok: false, error: error.message }))
      return true
  }
})

// ── Overlay window lifecycle ──────────────────────────────────
async function openOverlay() {
  if (overlayWinId !== null) {
    // Bring existing overlay to front
    chrome.windows.update(overlayWinId, { focused: true }).catch(() => {})
    return
  }

  const win = await chrome.windows.create({
    url:    chrome.runtime.getURL('overlay/overlay.html'),
    type:   'popup',
    width:  960,
    height: 720,
    top:    0,
    left:   0
  })

  overlayWinId = win.id
  overlayTabId = win.tabs[0].id
  await chrome.storage.session.set({ gazeActive: true })

  // Ask the current content tab for site so overlay can enter grid mode ASAP
  if (activeTabId) {
    chrome.tabs.sendMessage(activeTabId, { type: 'QUERY_SITE' }).catch(() => {})
  } else {
    // Fallback: find the focused non-overlay tab
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, tabs => {
      const t = tabs && tabs[0]
      if (t && isContentTab(t)) {
        activeTabId = t.id
        chrome.tabs.sendMessage(t.id, { type: 'QUERY_SITE' }).catch(() => {})
      }
    })
  }
}

async function closeOverlay() {
  if (overlayWinId !== null) {
    chrome.windows.remove(overlayWinId).catch(() => {})
    overlayWinId = null
    overlayTabId = null
  }
  await chrome.storage.session.set({ gazeActive: false })
}

// Clean up state if user closes the overlay window manually
chrome.windows.onRemoved.addListener(winId => {
  if (winId === overlayWinId) {
    overlayWinId = null
    overlayTabId = null
    chrome.storage.session.set({ gazeActive: false })
  }
})
