// ============================================================
//  SENSE RAY — Enhanced v2
//  NEW: FIIR frame-luma filter · LUT-verified gaze table · seL4 bounds
//       X3-XOR-Diff · MNIST presets · settings panel (TAB)
//       Instagram / YouTube grid nav · idle perf cap · all-time stats
// ============================================================

// ── DOM ──────────────────────────────────────────────────────
const video  = document.getElementById("video")
const proc   = document.getElementById("process")
const pctx   = proc.getContext("2d", { willReadFrequently: true })
const ctx    = document.getElementById("overlay").getContext("2d")
const bgctx  = document.getElementById("bg").getContext("2d")
const RAY_PRESETS = globalThis.SENSE_RAY_PRESETS || {}
const RAY_KEYS = globalThis.SENSE_RAY_STORAGE_KEYS || {
  preset: 'senseray_active_ray_preset_v1', cursor: 'senseray_ray_cursor_style_v1'
}

// ── X3-XOR-DIFFERENCE FRAME BUFFERS ─────────────────────────
// Three-frame temporal XOR difference suppresses single-frame noise.
// diff[i] = (F[n] XOR F[n-1]) | (F[n-1] XOR F[n-2])  masked to upper nibble
const FRAME_W = 80, FRAME_H = 60, FRAME_N = FRAME_W * FRAME_H
const frames  = [new Uint8ClampedArray(FRAME_N),
                 new Uint8ClampedArray(FRAME_N),
                 new Uint8ClampedArray(FRAME_N)]
let fidx = 0

// ── GAZE STATE ───────────────────────────────────────────────
let gx = innerWidth / 2,  gy = innerHeight / 2
let targetX = gx,          targetY = gy
let confidence = 60
let motionCount = 0
let rawGx = gx, rawGy = gy, gazeVelocity = 0, lastGazeAt = performance.now()
const CALIBRATION_KEY = 'senseray_calibration_v1'
const CALIBRATION_POINTS = [[.1,.1],[.9,.1],[.5,.5],[.1,.9],[.9,.9]]
let calibration = null, calibrationRun = null

function solve3(matrix, values) {
  const a = matrix.map((row, i) => [...row, values[i]])
  for (let col = 0; col < 3; col++) {
    let pivot = col
    for (let row = col + 1; row < 3; row++) if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row
    if (Math.abs(a[pivot][col]) < 1e-8) return null
    ;[a[col], a[pivot]] = [a[pivot], a[col]]
    const scale = a[col][col]
    for (let j = col; j < 4; j++) a[col][j] /= scale
    for (let row = 0; row < 3; row++) if (row !== col) {
      const factor = a[row][col]
      for (let j = col; j < 4; j++) a[row][j] -= factor * a[col][j]
    }
  }
  return a.map(row => row[3])
}
function fitCalibration(samples) {
  const normal = [[0,0,0],[0,0,0],[0,0,0]], bx = [0,0,0], by = [0,0,0]
  for (const p of samples) {
    const v = [p.x, p.y, 1]
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) normal[i][j] += v[i] * v[j]
      bx[i] += v[i] * p.tx; by[i] += v[i] * p.ty
    }
  }
  const x = solve3(normal, bx), y = solve3(normal, by)
  return x && y ? { x, y, points: samples.length } : null
}
function applyCalibration(x, y) {
  if (!calibration) return [x, y]
  const nx = x / innerWidth, ny = y / innerHeight
  return [
    (calibration.x[0] * nx + calibration.x[1] * ny + calibration.x[2]) * innerWidth,
    (calibration.y[0] * nx + calibration.y[1] * ny + calibration.y[2]) * innerHeight
  ]
}
function beginCalibration() {
  calibrationRun = { index: 0, samples: [] }
  idleStartAt = performance.now()
  gazeLog('CALIBRATION STARTED — look at each dot and press SPACE')
  updateSettingsUI()
}
function confirmCalibrationPoint() {
  if (!calibrationRun || confidence < 45 || gazeVelocity > 500) {
    gazeLog('CALIBRATION WAIT — hold a steady, confident gaze')
    return
  }
  const target = CALIBRATION_POINTS[calibrationRun.index]
  calibrationRun.samples.push({ x: rawGx / innerWidth, y: rawGy / innerHeight, tx: target[0], ty: target[1] })
  calibrationRun.index++
  if (calibrationRun.index < CALIBRATION_POINTS.length) {
    gazeLog(`CALIBRATION ${calibrationRun.index}/${CALIBRATION_POINTS.length} — hold next dot and press SPACE`)
  } else {
    calibration = fitCalibration(calibrationRun.samples)
    calibrationRun = null
    if (calibration) {
      try {
        if (chrome.storage?.local) chrome.storage.local.set({ [CALIBRATION_KEY]: calibration })
        else localStorage.setItem(CALIBRATION_KEY, JSON.stringify(calibration))
      } catch (_) {}
      gazeLog('CALIBRATION SAVED — 5-point affine map active')
    } else gazeLog('CALIBRATION FAILED — points were not distinct')
  }
  updateSettingsUI()
}

// ── COVER / PRODUCT ─────────────────────────────────────────
let showCover = true
const PRODUCT = "SENSE", TAGLINE = "VALUABLE PROFIT PROJECT", SUBLINE = "$ REMUNERABLE COVER"

// ── PROFILES ─────────────────────────────────────────────────
let currentProfile = 'ray2'
const PROFILES = {
  ray1: { name: 'RAY-1 BLASTER', motionTh: 68,  minCount: 13, alphaBase: 0.39, alphaMaxAdd: 0.61 },
  ray2: { name: 'RAY-2 PHASER',  motionTh: 89,  minCount: 18, alphaBase: 0.31, alphaMaxAdd: 0.54 },
  ray3: { name: 'RAY-3 SNIPER',  motionTh: 115, minCount: 25, alphaBase: 0.22, alphaMaxAdd: 0.41 }
}
let motionTh    = PROFILES.ray2.motionTh
let minCount    = PROFILES.ray2.minCount
let alphaBase   = PROFILES.ray2.alphaBase
let alphaMaxAdd = PROFILES.ray2.alphaMaxAdd
const XOR_PRESETS = {
  responsive: { label: 'RESPONSIVE', motionTh: 68, minCount: 13, mask: 0xe0 },
  balanced:   { label: 'BALANCED',   motionTh: 89, minCount: 18, mask: 0xf0 },
  precision:  { label: 'PRECISION',  motionTh: 115, minCount: 25, mask: 0xf8 }
}
let xorPreset = 'balanced', diffMask = XOR_PRESETS.balanced.mask

// ── THEMES ───────────────────────────────────────────────────
let currentTheme = 'balanced'
const THEMES = {
  minimal:     { name: '4 MINIMAL',     blurMult: 0.52, orbitCount: 24, synapse: false, pulses: 4,  color1: '#00ff9d', color2: '#ffffff' },
  balanced:    { name: '5 BALANCED',    blurMult: 1.00, orbitCount: 42, synapse: true,  pulses: 12, color1: '#00ff9d', color2: '#00ff41' },
  performance: { name: '6 PERFORMANCE', blurMult: 0.38, orbitCount: 26, synapse: false, pulses: 0,  color1: '#00ff9d', color2: '#00ff41' },
  fancy:       { name: '7 FANCY',       blurMult: 1.55, orbitCount: 58, synapse: true,  pulses: 20, color1: '#ff00ff', color2: '#ffd700' }
}

// ── FIIR / IIR FILTER FOR FRAME-LUMA DISPLAY ────────────────
// y[n] = α · x[n] + (1−α) · y[n−1]
// α=0.15 → smooth window of ~6 frames; adjustable at runtime via settings.
let fiirAlpha = 0.15   // mutable — settings panel can change this
let frameLuma = 55     // FIIR-smoothed frame-luminance proxy, not sensor IR exposure
let exposureStrength = 0.65
let exposureStats = { mean: 0, p5: 0, p95: 255, clipped: 0 }
let exposureLow = 0, exposureHigh = 255
let isTraceRecording = false

// ── SEL4 VERIFIED BOUNDS ─────────────────────────────────────
// Every gaze parameter has an invariant range that must hold at all times.
// Inspired by seL4 formal verification: violations are clamped + logged.
const SEL4 = {
  motionTh:    { lo: 20,   hi: 200  },
  minCount:    { lo: 1,    hi: 120  },
  alphaBase:   { lo: 0.01, hi: 0.99 },
  alphaMaxAdd: { lo: 0.01, hi: 0.99 },
  fiirAlpha:   { lo: 0.01, hi: 0.99 },
  frameLuma:   { lo: 0,    hi: 100  },
  confidence:  { lo: 0,    hi: 100  },
  gx:          { lo: 0,    hi: () => innerWidth  },
  gy:          { lo: 0,    hi: () => innerHeight }
}
function sel4(key, val) {
  const b = SEL4[key]; if (!b) return val
  const lo = typeof b.lo === 'function' ? b.lo() : b.lo
  const hi = typeof b.hi === 'function' ? b.hi() : b.hi
  if (val < lo || val > hi) gazeLog(`[seL4] ${key} OOB ${+val.toFixed(3)} → clamped [${lo},${hi}]`)
  return Math.max(lo, Math.min(hi, val))
}

// ── GAZE LUT (LOOKUP TABLE / VERIFIED ZONES) ─────────────────
// 5×4 grid of screen zones. Only consecutive confident, stable samples count.
const LUT_COLS = 5, LUT_ROWS = 4, LUT_DWELL = 30
let gazeLUT = Array.from({ length: LUT_ROWS }, () =>
  Array.from({ length: LUT_COLS }, () => ({ dwell: 0, verified: false, hits: 0 }))
)
let lutCell = { col: 0, row: 0 }

function lutUpdate(x, y) {
  const col = Math.min(LUT_COLS - 1, Math.floor(x / innerWidth  * LUT_COLS))
  const row = Math.min(LUT_ROWS - 1, Math.floor(y / innerHeight * LUT_ROWS))
  if (col === lutCell.col && row === lutCell.row) {
    const c = gazeLUT[row][col]
    c.dwell++; c.hits++
    if (c.dwell >= LUT_DWELL && !c.verified) {
      c.verified = true
      gazeLog(`LUT [${col},${row}] VERIFIED`)
    }
  } else {
    gazeLUT[lutCell.row][lutCell.col].dwell = 0
    lutCell = { col, row }
  }
}

// ── MNIST PRESETS ────────────────────────────────────────────
// Five symbol sets for the orbiting neural nodes.
const MNIST_PRESETS = {
  classic: "0123456789ΦΨΔλ▒░▓█ΣΩ⊗⊕∇∞≈≠",
  sparse:  "0 1 · ∘ ○ ● 0 1 0 · ∘",
  dense:   "0123456789ABCDEFabcdef▒▓█░",
  neural:  "▓▒░ΣΩΨΦΔλ∇⊗⊕∞≈≠±×÷√π",
  binary:  "0101001100010110101001"
}
let mnistPreset = 'classic'
let mnistRings = 8
let activeRayPreset = 'sense'
let rayCursorSettings = { ...(RAY_PRESETS.sense?.cursor || { color: '#00ff9d', size: 18, glow: 14, opacity: 0.94, holdMs: 400 }) }
let rayStyleSaveTimer = null

const SAVED_PROFILES_KEY = 'senseray_saved_profiles_v1'
let savedProfiles = {}
let activeSavedProfile = ''
const FINGER_NAMES = ['thumb', 'index', 'middle', 'ring', 'pinky']
let handCalibration = { open: null, closed: null }
let latestHandPose = null
let handAssertion = 'Waiting for an optional hand-landmark source.'
function readStored(key, fallback) {
  return new Promise(resolve => {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        chrome.storage.local.get(key, result => resolve(result?.[key] ?? fallback))
      } else resolve(JSON.parse(localStorage.getItem(key) || 'null') ?? fallback)
    } catch (_) { resolve(fallback) }
  })
}
function writeStored(key, value) {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) chrome.storage.local.set({ [key]: value })
    else localStorage.setItem(key, JSON.stringify(value))
  } catch (_) { gazeLog(`SAVE FAILED: ${key}`) }
}
function snapshotSettings() {
  return {
    currentProfile, currentTheme, motionTh, minCount, alphaBase, alphaMaxAdd,
    fiirAlpha, exposureStrength, xorPreset, diffMask, mnistPreset, mnistRings,
    calibration, handCalibration, activeRayPreset, rayCursorSettings: { ...rayCursorSettings },
    gazeLUT: gazeLUT.map(row => row.map(cell => ({ ...cell })))
  }
}
function saveNamedProfile() {
  const input = panelEl?.querySelector('#sr-profile-name')
  const name = input?.value.trim().slice(0, 32)
  if (!name) { gazeLog('PROFILE SAVE — enter a name'); input?.focus(); return }
  savedProfiles[name] = snapshotSettings()
  activeSavedProfile = name
  writeStored(SAVED_PROFILES_KEY, savedProfiles)
  refreshSavedProfileOptions()
  gazeLog(`PROFILE SAVED: ${name}`)
  updateSettingsUI()
}
function loadNamedProfile() {
  const name = panelEl?.querySelector('#sr-profile-select')?.value
  const data = savedProfiles[name]
  if (!data) return
  if (PROFILES[data.currentProfile]) currentProfile = data.currentProfile
  if (THEMES[data.currentTheme]) currentTheme = data.currentTheme
  motionTh = sel4('motionTh', Number(data.motionTh) || PROFILES.ray2.motionTh)
  minCount = sel4('minCount', Number(data.minCount) || PROFILES.ray2.minCount)
  alphaBase = sel4('alphaBase', Number(data.alphaBase) || PROFILES.ray2.alphaBase)
  alphaMaxAdd = sel4('alphaMaxAdd', Number(data.alphaMaxAdd) || PROFILES.ray2.alphaMaxAdd)
  fiirAlpha = sel4('fiirAlpha', Number(data.fiirAlpha) || 0.15)
  exposureStrength = Math.max(0, Math.min(1, Number(data.exposureStrength) || 0))
  xorPreset = XOR_PRESETS[data.xorPreset] ? data.xorPreset : 'balanced'
  diffMask = Number.isInteger(data.diffMask) ? data.diffMask & 0xff : XOR_PRESETS[xorPreset].mask
  mnistPreset = MNIST_PRESETS[data.mnistPreset] ? data.mnistPreset : 'classic'
  mnistRings = Math.max(1, Math.min(12, Math.round(Number(data.mnistRings) || 8)))
  activeRayPreset = RAY_PRESETS[data.activeRayPreset] ? data.activeRayPreset : 'sense'
  rayCursorSettings = cleanRayCursorSettings(data.rayCursorSettings, RAY_PRESETS[activeRayPreset].cursor)
  if (data.calibration?.x?.length === 3 && data.calibration?.y?.length === 3 && data.calibration.x.concat(data.calibration.y).every(Number.isFinite)) calibration = data.calibration
  const handOpen = normalizeHandPose(data.handCalibration?.open), handClosed = normalizeHandPose(data.handCalibration?.closed)
  handCalibration = { open: handOpen, closed: handClosed }
  if (Array.isArray(data.gazeLUT) && data.gazeLUT.length === LUT_ROWS && data.gazeLUT.every(row => Array.isArray(row) && row.length === LUT_COLS)) {
    gazeLUT = data.gazeLUT.map(row => row.map(cell => ({ dwell: Math.max(0, Number(cell.dwell) || 0), verified: Boolean(cell.verified), hits: Math.max(0, Number(cell.hits) || 0) })))
  }
  activeSavedProfile = name
  gazeLog(`PROFILE LOADED: ${name}`)
  updateSettingsUI()
  publishRayConfiguration()
}
function refreshSavedProfileOptions() {
  const select = panelEl?.querySelector('#sr-profile-select')
  if (!select) return
  select.replaceChildren(new Option('Select saved profile…', ''))
  Object.keys(savedProfiles).sort((a, b) => a.localeCompare(b)).forEach(name => select.add(new Option(name, name)))
  if (activeSavedProfile && savedProfiles[activeSavedProfile]) select.value = activeSavedProfile
}
function normalizeHandPose(input) {
  const angles = input?.angles || input
  if (!angles || typeof angles !== 'object') return null
  const pose = {}
  for (const finger of FINGER_NAMES) {
    const joints = angles[finger]
    if (!joints || !['mcp', 'pip', 'dip'].every(joint => Number.isFinite(joints[joint]) && Math.abs(joints[joint]) <= 180)) return null
    pose[finger] = { mcp: joints.mcp, pip: joints.pip, dip: joints.dip }
  }
  return pose
}
function captureHandAssertionPoint(kind) {
  if (!latestHandPose) {
    handAssertion = 'No hand-pose sample. Connect a provider using the documented event first.'
  } else {
    handCalibration[kind] = JSON.parse(JSON.stringify(latestHandPose))
    handAssertion = `${kind.toUpperCase()} hand assertion captured for five fingers.`
    activeSavedProfile = ''
    gazeLog(`HAND ${kind.toUpperCase()} ASSERTION POINT CAPTURED`)
  }
  updateSettingsUI()
}
function evaluateHandAssertion(pose) {
  const open = handCalibration.open, closed = handCalibration.closed
  if (!open || !closed) return 'Capture both open-hand and closed-fist reference poses.'
  const assertions = []
  for (const finger of FINGER_NAMES) {
    const a = open[finger], b = closed[finger], live = pose[finger]
    const span = b.mcp - a.mcp
    if (Math.abs(span) < 1) { assertions.push(`${finger}: invalid MCP range`); continue }
    const curl = Math.max(0, Math.min(1, (live.mcp - a.mcp) / span))
    const expectedPip = a.pip + curl * (b.pip - a.pip)
    const expectedDip = a.dip + curl * (b.dip - a.dip)
    const error = Math.max(Math.abs(live.pip - expectedPip), Math.abs(live.dip - expectedDip))
    assertions.push(`${finger} ${Math.round(curl * 100)}% ${error <= 25 ? 'OK' : `Δ${Math.round(error)}°`}`)
  }
  return assertions.join(' · ')
}
function receiveHandPose(event) {
  const pose = normalizeHandPose(event.detail)
  if (!pose) { handAssertion = 'Hand-pose sample rejected: expected MCP/PIP/DIP angles for five fingers.'; updateHandAssertionUI(); updateMathTable(); return }
  latestHandPose = pose
  handAssertion = evaluateHandAssertion(pose)
  updateHandAssertionUI()
  updateMathTable()
}
function updateHandAssertionUI() {
  const status = panelEl?.querySelector('#sr-hand-status')
  if (status) status.textContent = handAssertion
}

// ── CLICK / IDLE DETECTION ───────────────────────────────────
let sparks = [], closedFrames = 0
const drops = Array(100).fill(0).map(() => Math.random() * innerHeight)
let lastSendAt = 0, clickCooldownUntil = 0, lastAckAt = 0
let idleStartAt = 0, idleCenter = { x: gx, y: gy }
const IDLE_RADIUS      = 24
const IDLE_LEFT_MS     = 700
const IDLE_RIGHT_MS    = 1400
const IDLE_COOLDOWN_MS = 900
const MIN_CONFIDENCE   = 65

// ── USE / IDLE PERFORMANCE CAP ───────────────────────────────
// When no motion is detected for PERF_IDLE_MS → drop to idle fps.
// On motion → wake back to active fps immediately.
const PERF_FPS_ACTIVE  = 30    // ~33ms per frame
const PERF_FPS_IDLE    = 5     // ~200ms per frame
const PERF_IDLE_MS     = 8000  // 8 s no motion → idle mode
let perfMode = 'active'
let perfTimer  = null
let procInterv = null

function setPerfMode(mode) {
  if (perfMode === mode) return
  perfMode = mode
  gazeLog(`PERF → ${mode.toUpperCase()}`)
  clearInterval(procInterv)
  const ms = mode === 'idle'
    ? Math.round(1000 / PERF_FPS_IDLE)
    : Math.round(1000 / PERF_FPS_ACTIVE)
  procInterv = setInterval(processFrame, ms)
  updateSettingsUI()
}

function wakePerf() {
  if (perfMode === 'idle') setPerfMode('active')
  clearTimeout(perfTimer)
  perfTimer = setTimeout(() => setPerfMode('idle'), PERF_IDLE_MS)
}

// ── ALL-TIME STATISTICS ──────────────────────────────────────
const STATS_KEY = 'senseray_stats_v1'
let stats = {
  sessions: 0, frames: 0,
  clicks: 0, leftClicks: 0, rightClicks: 0,
  activeMs: 0, startTime: Date.now()
}
;(function loadStats() {
  try {
    const s = JSON.parse(localStorage.getItem(STATS_KEY) || '{}')
    Object.assign(stats, s)
  } catch (_) {}
  stats.sessions++
  stats.startTime = Date.now()
})()
function saveStats() {
  try { localStorage.setItem(STATS_KEY, JSON.stringify(stats)) } catch (_) {}
}
setInterval(() => { if (perfMode === 'active') { stats.activeMs += 1000; saveStats() } }, 1000)

// ── SITE DETECTION & GRID NAVIGATION ────────────────────────
// When on Instagram/YouTube, gaze maps to a content grid.
// Grid math is loaded on demand and unloaded when leaving the site.
const SITE_CFG = {
  instagram: { cols: 3, rows: 3, color: '#e1306c', label: 'INSTAGRAM GRID',
               sel: 'article a[href*="/p/"]' },
  youtube:   { cols: 4, rows: 3, color: '#ff0000', label: 'YOUTUBE GRID',
               sel: 'ytd-thumbnail, a#thumbnail' }
}
let siteMode = null
let gridFocusCol = -1, gridFocusRow = -1
let gridMathLoaded = false
let gridOverlayEl  = null

function detectSite() {
  try {
    const h = location.hostname
    if (h.includes('instagram.com')) return 'instagram'
    if (h.includes('youtube.com'))   return 'youtube'
  } catch (_) {}
  return null
}

function loadGridMath()   { if (gridMathLoaded) return; gridMathLoaded = true;  gazeLog('GRID MATH LOADED') }
function unloadGridMath() { if (!gridMathLoaded) return; gridMathLoaded = false; gridFocusCol = -1; gridFocusRow = -1; gazeLog('GRID MATH UNLOADED') }

function getGridCell(x, y, cfg) {
  return {
    col: Math.min(cfg.cols - 1, Math.floor(x / innerWidth  * cfg.cols)),
    row: Math.min(cfg.rows - 1, Math.floor(y / innerHeight * cfg.rows))
  }
}

function activateGridCell(col, row) {
  if (!siteMode || col < 0) return
  const cfg = SITE_CFG[siteMode]
  const els = document.querySelectorAll(cfg.sel)
  const el  = els[row * cfg.cols + col]
  if (el) {
    el.focus()
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    gazeLog(`GRID [${siteMode}] (${col},${row}) activated`)
  }
}

function createGridOverlay() {
  if (gridOverlayEl) return
  const el = document.createElement('canvas')
  el.id = 'sr-grid-overlay'
  el.style.cssText = 'position:fixed;top:0;left:0;z-index:2147483646;width:100vw;height:100vh;pointer-events:none'
  document.body.appendChild(el)
  gridOverlayEl = el
}

function drawGridOverlay() {
  if (!gridOverlayEl || !siteMode) return
  const cfg = SITE_CFG[siteMode]
  const w = innerWidth, h = innerHeight
  gridOverlayEl.width = w; gridOverlayEl.height = h
  const gc = gridOverlayEl.getContext('2d')
  gc.clearRect(0, 0, w, h)
  const cw = w / cfg.cols, ch = h / cfg.rows
  for (let r = 0; r < cfg.rows; r++) {
    for (let c = 0; c < cfg.cols; c++) {
      const focus = c === gridFocusCol && r === gridFocusRow
      gc.strokeStyle = focus ? cfg.color : cfg.color + '44'
      gc.lineWidth   = focus ? 2.5 : 1
      gc.strokeRect(c * cw + 2, r * ch + 2, cw - 4, ch - 4)
      if (focus) {
        gc.fillStyle = cfg.color + '1a'
        gc.fillRect(c * cw + 2, r * ch + 2, cw - 4, ch - 4)
        gc.fillStyle  = cfg.color
        gc.font       = 'bold 13px monospace'
        gc.textAlign  = 'center'
        gc.fillText(`[${c},${r}]`, c * cw + cw / 2, r * ch + 20)
      }
    }
  }
}

// ── LOG ──────────────────────────────────────────────────────
let logs = []
function gazeLog(msg) {
  const t = new Date().toISOString().slice(11, 19)
  logs.push(`[${t}] ${msg}`)
  if (logs.length > 200) logs.shift()
  console.log(`[SENSE RAY] ${msg}`)
}

// ── RESIZE ───────────────────────────────────────────────────
function resize() {
  const w = innerWidth, h = innerHeight
  document.getElementById("bg").width      = w
  document.getElementById("bg").height     = h
  document.getElementById("overlay").width  = w
  document.getElementById("overlay").height = h
  if (gridOverlayEl) { gridOverlayEl.width = w; gridOverlayEl.height = h }
}
window.addEventListener("resize", resize)
resize()
proc.width = FRAME_W; proc.height = FRAME_H

// ── CHROME RUNTIME ───────────────────────────────────────────
if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener(m => {
    if (m?.type === 'RAY_CONFIGURATION_CHANGED') {
      if (m.applyPreset) applyRayPreset(m.preset, { cursor: m.cursor, publish: false })
      else {
        if (RAY_PRESETS[m.preset]) activeRayPreset = m.preset
        rayCursorSettings = cleanRayCursorSettings(m.cursor, RAY_PRESETS[activeRayPreset]?.cursor)
        updateSettingsUI()
      }
      return
    }
    if (m?.type === "GAZE_ACK") {
      lastAckAt = performance.now()
      return
    }
    // SITE_MODE is relayed by background when content.js reports the active page
    if (m?.type === "SITE_MODE") {
      const next = m.site || null
      if (next !== siteMode) {
        siteMode = next
        if (siteMode) {
          gazeLog(`SITE MODE: ${siteMode.toUpperCase()}`)
          createGridOverlay()
          loadGridMath()
        } else {
          unloadGridMath()
          if (gridOverlayEl) {
            gridOverlayEl.remove()
            gridOverlayEl = null
          }
          gazeLog('SITE MODE: GENERIC')
        }
        updateSettingsUI()
      }
    }
  })
}

// ── SET PROFILE / THEME ──────────────────────────────────────
function setProfile(p) {
  if (!PROFILES[p]) return
  currentProfile = p
  const pr = PROFILES[p]
  motionTh    = sel4('motionTh',    pr.motionTh)
  minCount    = sel4('minCount',    pr.minCount)
  alphaBase   = sel4('alphaBase',   pr.alphaBase)
  alphaMaxAdd = sel4('alphaMaxAdd', pr.alphaMaxAdd)
  xorPreset = p === 'ray1' ? 'responsive' : p === 'ray3' ? 'precision' : 'balanced'
  diffMask = XOR_PRESETS[xorPreset].mask
  activeSavedProfile = ''
  gazeLog(`PROFILE → ${pr.name}`)
  updateSettingsUI()
}

function setXorPreset(preset) {
  const cfg = XOR_PRESETS[preset]
  if (!cfg) return
  xorPreset = preset
  diffMask = cfg.mask
  motionTh = sel4('motionTh', cfg.motionTh)
  minCount = sel4('minCount', cfg.minCount)
  activeSavedProfile = ''
  gazeLog(`3× XOR → ${cfg.label}`)
  updateSettingsUI()
}

function cleanRayCursorSettings(value, fallback = rayCursorSettings) {
  const safe = value && typeof value === 'object' ? value : {}
  const base = fallback && typeof fallback === 'object' ? fallback : (RAY_PRESETS.sense?.cursor || {})
  const number = (key, min, max) => {
    const n = Number(safe[key])
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : base[key]
  }
  return {
    color: /^#[0-9a-f]{6}$/i.test(safe.color || '') ? safe.color : base.color,
    size: number('size', 8, 40), glow: number('glow', 0, 40),
    opacity: number('opacity', 0.2, 1), holdMs: number('holdMs', 100, 1500)
  }
}

function applyRayPreset(presetId, { cursor = null, publish = false } = {}) {
  const preset = RAY_PRESETS[presetId]
  if (!preset) return
  activeRayPreset = presetId
  setProfile(preset.profile)
  setTheme(preset.theme)
  mnistPreset = MNIST_PRESETS[preset.mnist] ? preset.mnist : 'classic'
  mnistRings = Math.max(1, Math.min(12, Math.round(preset.rings || 8)))
  rayCursorSettings = cleanRayCursorSettings(cursor, preset.cursor)
  activeSavedProfile = ''
  updateSettingsUI()
  if (publish && chrome.runtime?.sendMessage) {
    chrome.runtime.sendMessage({ type: 'APPLY_RAY_PRESET', preset: presetId }, () => {})
  }
  gazeLog(`RAY SENSE → ${preset.name.toUpperCase()}`)
}

function publishRayConfiguration() {
  clearTimeout(rayStyleSaveTimer)
  rayStyleSaveTimer = setTimeout(() => {
    if (chrome.runtime?.sendMessage) chrome.runtime.sendMessage({
      type: 'SAVE_RAY_CONFIGURATION', preset: activeRayPreset, cursor: rayCursorSettings
    }, () => {})
  }, 220)
}

function updateRayCursorSetting(key, value) {
  rayCursorSettings = cleanRayCursorSettings({ ...rayCursorSettings, [key]: value })
  activeSavedProfile = ''
  const valueNode = panelEl?.querySelector(`#sp-cursor-${key}`)
  if (valueNode) valueNode.textContent = key === 'opacity' ? `${Math.round(value * 100)}%`
    : key === 'holdMs' ? `${value}ms`
    : key === 'size' || key === 'glow' ? `${value}px` : value
  if (key === 'color') panelEl?.querySelector('#sp-cursor-color')?.style.setProperty('--cursor-preview', value)
  publishRayConfiguration()
}

function setTheme(t) {
  if (!THEMES[t]) return
  currentTheme = t
  activeSavedProfile = ''
  gazeLog(`THEME → ${THEMES[t].name}`)
  updateSettingsUI()
}

// ── PROCESS FRAME ────────────────────────────────────────────
function processFrame() {
  if (video.videoWidth === 0 || showCover) return

  // Capture → grayscale
  pctx.drawImage(video, 0, 0, FRAME_W, FRAME_H)
  const data = pctx.getImageData(0, 0, FRAME_W, FRAME_H).data
  const gray = new Uint8ClampedArray(FRAME_N)
  const histogram = new Uint32Array(256)
  let sum = 0
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    gray[j] = (data[i] * 0.3 + data[i+1] * 0.59 + data[i+2] * 0.11) | 0
    sum += gray[j]
    histogram[gray[j]]++
  }

  const percentile = q => {
    const target = Math.ceil(FRAME_N * q)
    let seen = 0
    for (let i = 0; i < histogram.length; i++) { seen += histogram[i]; if (seen >= target) return i }
    return 255
  }
  const low = percentile(0.05), high = percentile(0.95)
  const avgGray = sum / FRAME_N
  exposureStats = { mean: avgGray, p5: low, p95: high, clipped: histogram[0] + histogram[255] }
  exposureLow += fiirAlpha * (low - exposureLow)
  exposureHigh += fiirAlpha * (high - exposureHigh)
  if (exposureStrength > 0 && exposureHigh > exposureLow + 2) {
    const span = exposureHigh - exposureLow
    for (let i = 0; i < FRAME_N; i++) {
      const stretched = Math.max(0, Math.min(255, ((gray[i] - exposureLow) * 255) / span))
      gray[i] = Math.round(gray[i] * (1 - exposureStrength) + stretched * exposureStrength)
    }
  }

  // X3-XOR-Difference across 3 frames
  fidx = (fidx + 1) % 3
  frames[fidx].set(gray)
  const p = (fidx + 2) % 3, pp = (fidx + 1) % 3
  let sx = 0, sy = 0, count = 0
  for (let i = 0; i < FRAME_N; i++) {
    const diff = ((frames[fidx][i] ^ frames[p][i]) | (frames[p][i] ^ frames[pp][i])) & diffMask
    if (diff > motionTh) { sx += i % FRAME_W; sy += (i / FRAME_W) | 0; count++ }
  }
  motionCount = count

  stats.frames++

  if (count >= minCount) {
    targetX    = innerWidth  - (sx / count / FRAME_W)  * innerWidth
    targetY    = innerHeight - (sy / count / FRAME_H) * innerHeight
    confidence = sel4('confidence', Math.min(98, 48 + count * 2.1))
    wakePerf()
  } else {
    confidence = sel4('confidence', Math.max(20, confidence - 6))
  }

  // FIIR low-pass filter on the frame-luminance indicator
  const rawExp  = Math.max(8, Math.min(98, avgGray * 1.72))
  frameLuma     = sel4('frameLuma', fiirAlpha * rawExp + (1 - fiirAlpha) * frameLuma)

  if (avgGray < 35) closedFrames++; else closedFrames = 0
  isTraceRecording = (count >= minCount && confidence > 45)

  // Smooth gaze
  const previousGx = gx, previousGy = gy
  const dist  = Math.hypot(targetX - rawGx, targetY - rawGy)
  const alpha = alphaBase + Math.min(alphaMaxAdd, dist * 0.0026)
  rawGx = sel4('gx', rawGx * (1 - alpha) + targetX * alpha)
  rawGy = sel4('gy', rawGy * (1 - alpha) + targetY * alpha)
  const gazeNow = performance.now(), gazeDt = Math.max(1, gazeNow - lastGazeAt)
  // Calibration assertion point: map the smoothed estimate once, then clamp.
  // LUT, dwell, clicks, reticle, and GAZE_POS all consume this final ray.
  ;[gx, gy] = applyCalibration(rawGx, rawGy)
  gx = sel4('gx', gx); gy = sel4('gy', gy); lastGazeAt = gazeNow
  gazeVelocity = Math.hypot(gx - previousGx, gy - previousGy) / gazeDt * 1000

  // LUT update
  if (confidence >= MIN_CONFIDENCE && gazeVelocity < 500) lutUpdate(gx, gy)
  else gazeLUT[lutCell.row][lutCell.col].dwell = 0

  // Grid math load/unload
  if (siteMode && !gridMathLoaded) loadGridMath()
  if (!siteMode && gridMathLoaded) unloadGridMath()
  if (siteMode && gridMathLoaded) {
    const cell    = getGridCell(gx, gy, SITE_CFG[siteMode])
    gridFocusCol  = cell.col
    gridFocusRow  = cell.row
    drawGridOverlay()
  }

  // Click: blink detection (closed frames)
  const now = performance.now()
  const shouldClick = closedFrames > 6 && confidence >= MIN_CONFIDENCE && gazeVelocity < 900 && now > clickCooldownUntil
  if (shouldClick) {
    clickCooldownUntil = now + 800; closedFrames = 0
    stats.clicks++
    if (siteMode) activateGridCell(gridFocusCol, gridFocusRow)
  }

  // Idle dwell click
  const dxI = gx - idleCenter.x, dyI = gy - idleCenter.y
  if (Math.hypot(dxI, dyI) > IDLE_RADIUS || confidence < MIN_CONFIDENCE) {
    idleCenter = { x: gx, y: gy }; idleStartAt = now
  }
  let idleClick = null
  if (confidence >= MIN_CONFIDENCE && gazeVelocity < 500 && now > clickCooldownUntil) {
    if (now - idleStartAt > IDLE_RIGHT_MS) {
      idleClick = "right"; stats.rightClicks++; stats.clicks++
      clickCooldownUntil = now + IDLE_COOLDOWN_MS; idleStartAt = now
    } else if (now - idleStartAt > IDLE_LEFT_MS) {
      idleClick = "left"; stats.leftClicks++; stats.clicks++
      clickCooldownUntil = now + IDLE_COOLDOWN_MS; idleStartAt = now
    }
  }

  // Send to background
  const disconnected = now - lastAckAt > 2000
  if (now - lastSendAt > 33 && !disconnected) {
    lastSendAt = now
    const nx = Math.max(0, Math.min(1, gx / innerWidth))
    const ny = Math.max(0, Math.min(1, gy / innerHeight))
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage)
      chrome.runtime.sendMessage({ type: "GAZE_POS", payload: { x: nx, y: ny, click: shouldClick, idleClick } }, () => {})
  }
  if (disconnected && now - lastSendAt > 500) {
    lastSendAt = now
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage)
      chrome.runtime.sendMessage({ type: "GAZE_PING" }, () => {})
  }

  // Sparks
  if (Math.random() < 0.7) {
    sparks.push({
      x: gx + (Math.random() - 0.5) * 24, y: gy + (Math.random() - 0.5) * 24,
      vx: (Math.random() - 0.5) * 3.8,    vy: (Math.random() - 0.5) * 3.8,
      life: 22 + Math.random() * 12
    })
    if (sparks.length > 14) sparks.shift()
  }
}

// ── DRAW COVER ───────────────────────────────────────────────
function drawCover() {
  ctx.fillStyle = "rgba(5,5,15,0.96)"
  ctx.fillRect(0, 0, innerWidth, innerHeight)
  ctx.strokeStyle = "rgba(0,255,157,0.07)"; ctx.lineWidth = 1
  for (let x = 40; x < innerWidth;  x += 80) { ctx.beginPath(); ctx.moveTo(x,0);          ctx.lineTo(x,innerHeight); ctx.stroke() }
  for (let y = 40; y < innerHeight; y += 80) { ctx.beginPath(); ctx.moveTo(0,y);          ctx.lineTo(innerWidth,y);  ctx.stroke() }

  ctx.shadowBlur = 40; ctx.shadowColor = "#00ff9d"; ctx.fillStyle = "#00ff9d"
  ctx.font = "bold 128px monospace"; ctx.textAlign = "center"
  ctx.fillText(PRODUCT, innerWidth/2, innerHeight/2 - 110)

  ctx.shadowBlur = 25; ctx.shadowColor = "#ffd700"; ctx.fillStyle = "#ffd700"
  ctx.font = "bold 48px monospace"
  ctx.fillText(TAGLINE, innerWidth/2, innerHeight/2 + 10)

  ctx.shadowBlur = 15; ctx.shadowColor = "#00ff41"; ctx.fillStyle = "#00ff41"
  ctx.font = "bold 34px monospace"
  ctx.fillText(SUBLINE, innerWidth/2, innerHeight/2 + 70)

  ctx.shadowBlur = 12; ctx.font = "19px monospace"
  const px = [innerWidth/2 - 280, innerWidth/2 - 80, innerWidth/2 + 120]
  ;['ray1','ray2','ray3'].forEach((p,i) => {
    ctx.fillStyle = currentProfile === p ? "#ff00ff" : "#00ff9d"
    ctx.fillText(PROFILES[p].name, px[i], innerHeight/2 + 160)
  })
  ctx.fillStyle = "#00ff9d"
  ctx.fillText("4 MINIMAL   5 BALANCED   6 PERFORMANCE   7 FANCY", innerWidth/2, innerHeight/2 + 200)

  ctx.shadowBlur = 20; ctx.shadowColor = "#ffd700"; ctx.fillStyle = "#ffd700"
  ctx.font = "bold 21px monospace"
  ctx.fillText("♥ SUPPORT THIS REMUNERABLE PROJECT $", innerWidth/2, innerHeight - 115)

  ctx.shadowBlur = 8; ctx.fillStyle = "#00ff9d"; ctx.font = "15px monospace"
  ctx.fillText("ko-fi.com / paypal.me / github sponsors", innerWidth/2, innerHeight - 82)

  ctx.shadowBlur = 0; ctx.fillStyle = "#ffffff"; ctx.font = "17px monospace"
  ctx.fillText("PRESS SPACE / CLICK TO ACTIVATE   [TAB = SETTINGS]", innerWidth/2, innerHeight - 38)
}

// ── DRAW GAZE ────────────────────────────────────────────────
function drawGaze() {
  ctx.clearRect(0, 0, innerWidth, innerHeight)
  if (showCover) { drawCover(); return }

  const theme      = THEMES[currentTheme]
  const t          = Date.now() / 240
  const tracePulse = isTraceRecording ? Math.sin(Date.now() / 70) * 0.4 + 1.35 : 1
  const bm         = theme.blurMult

  // Core gaze dot
  const pulse = Math.sin(Date.now() / 140) * 5 + 16 + confidence / 8
  ctx.shadowBlur = 28; ctx.shadowColor = "#00ff9d"
  ctx.fillStyle = `rgba(0,255,157,${0.7 + confidence / 280})`
  ctx.beginPath(); ctx.arc(gx, gy, pulse, 0, Math.PI * 2); ctx.fill()

  // Adjustable orbital rings used by the reticle and MNIST symbols.
  const rR = Array.from({ length: mnistRings }, (_, l) => mnistRings === 1 ? 65 : 112 - l * 93 / (mnistRings - 1))
  for (let l = 0; l < mnistRings; l++) {
    const depth = mnistRings === 1 ? 0.5 : l / (mnistRings - 1)
    ctx.shadowBlur  = (68 - depth * 59) * bm * tracePulse
    ctx.shadowColor = l % 2 === 0 ? theme.color1 : theme.color2
    ctx.strokeStyle = `rgba(255,255,255,${0.26 + (1 - depth) * 0.74})`
    ctx.lineWidth   = 2.2 + (1 - depth) * 5.5
    ctx.beginPath(); ctx.arc(gx, gy, rR[l], 0, Math.PI * 2); ctx.stroke()
  }

  // Orbiting MNIST nodes (active preset)
  const syms = MNIST_PRESETS[mnistPreset]
  ctx.shadowBlur = 19 * bm * tracePulse; ctx.shadowColor = "#ffffff"
  ctx.fillStyle = "#ffffff"; ctx.font = "bold 15px monospace"
  ctx.textAlign = "center"; ctx.textBaseline = "middle"
  for (let i = 0; i < theme.orbitCount; i++) {
    const layer = i % mnistRings, speed = 0.7 + layer * 0.28
    const a = t * speed + i * (Math.PI * 2 / theme.orbitCount)
    ctx.fillText(syms[i % syms.length], gx + Math.cos(a) * (rR[layer] - 6), gy + Math.sin(a) * (rR[layer] - 6))
  }

  // Dynamic synapse connections
  if (theme.synapse) {
    ctx.shadowBlur = 8 * bm * tracePulse
    ctx.strokeStyle = isTraceRecording ? "rgba(255,0,136,0.85)" : "rgba(0,255,157,0.6)"
    ctx.lineWidth = 1.15
    for (let i = 0; i < theme.orbitCount; i += 4) {
      const a1 = t * 1.6 + i * 0.14, a2 = t * 2.3 + (i+11) * 0.14
      const r1 = rR[i%mnistRings]-8, r2 = rR[(i+3)%mnistRings]-8
      ctx.beginPath()
      ctx.moveTo(gx + Math.cos(a1)*r1, gy + Math.sin(a1)*r1)
      ctx.lineTo(gx + Math.cos(a2)*r2, gy + Math.sin(a2)*r2)
      ctx.stroke()
    }
  }

  // Pulsing neuron nodes
  ctx.shadowBlur = 24 * bm * tracePulse
  for (let i = 0; i < theme.pulses; i++) {
    const a = t * 3.2 + i * (Math.PI * 2 / theme.pulses)
    const np = Math.sin(t * 9 + i) * 2.5 + 4.5
    const r  = rR[i%mnistRings] - 14
    ctx.fillStyle = isTraceRecording ? "#ff0088" : theme.color1
    ctx.fillRect(gx + Math.cos(a)*r - np/2, gy + Math.sin(a)*r - np/2, np, np)
  }

  // Rotating arms
  ctx.shadowBlur = -1; ctx.shadowColor = "#00ff41"; ctx.strokeStyle = "#00ff41"; ctx.lineWidth = 5
  const r1 = 56*Math.sin(t*1.3), r2 = 56*Math.cos(t*1.3)
  const r3 = 38*Math.sin(t*2.1), r4 = 38*Math.cos(t*2.1)
  ctx.beginPath()
  ctx.moveTo(gx,gy); ctx.lineTo(gx+r1,gy+r2)
  ctx.moveTo(gx,gy); ctx.lineTo(gx-r2,gy+r1)
  ctx.stroke()
  ctx.lineWidth = 2.6; ctx.beginPath()
  ctx.moveTo(gx,gy); ctx.lineTo(gx+r3,gy+r4)
  ctx.moveTo(gx,gy); ctx.lineTo(gx-r4,gy+r3)
  ctx.stroke()

  // Target brackets
  ctx.strokeStyle = "#ffd700"; ctx.lineWidth = 2.4; ctx.shadowBlur = 14*bm; ctx.shadowColor = "#ffd700"
  ctx.beginPath()
  ctx.moveTo(gx-26,gy-26); ctx.lineTo(gx-14,gy-26); ctx.lineTo(gx-14,gy-14)
  ctx.moveTo(gx+26,gy-26); ctx.lineTo(gx+14,gy-26); ctx.lineTo(gx+14,gy-14)
  ctx.moveTo(gx-26,gy+26); ctx.lineTo(gx-14,gy+26); ctx.lineTo(gx-14,gy+14)
  ctx.moveTo(gx+26,gy+26); ctx.lineTo(gx+14,gy+26); ctx.lineTo(gx+14,gy+14)
  ctx.stroke()

  // HUD left
  ctx.shadowBlur = 14; ctx.shadowColor = "#ffd700"; ctx.fillStyle = "#ffd700"
  ctx.font = "bold 19px monospace"; ctx.textAlign = "left"
  ctx.fillText(`${activeRayPreset.toUpperCase()} · ${PROFILES[currentProfile].name}`, 38, 58)
  ctx.font = "13px monospace"; ctx.fillStyle = "#00ff9d"
  ctx.fillText(`3×XOR:${XOR_PRESETS[xorPreset].label} TH:${motionTh} MIN:${minCount}`, 38, 82)
  ctx.fillStyle = "#55aa77"; ctx.font = "11px monospace"
  ctx.fillText(`MNIST:${mnistPreset.toUpperCase()} RINGS:${mnistRings} SITE:${siteMode || 'GENERIC'} PERF:${perfMode.toUpperCase()}`, 38, 100)
  ctx.fillStyle = "#336655"
  ctx.fillText(`α=${fiirAlpha.toFixed(2)}  LUT[${lutCell.col},${lutCell.row}]${gazeLUT[lutCell.row]?.[lutCell.col]?.verified ? ' ✓' : ''}`, 38, 116)

  // Frame-luminance HUD (top-right, FIIR-filtered)
  ctx.textAlign = "right"
  ctx.fillStyle = "#00ff9d"; ctx.shadowBlur = 16
  ctx.shadowColor = isTraceRecording ? "#ff0088" : "#00ff9d"
  ctx.font = "bold 21px monospace"
  ctx.fillText("FRAME LUMA · FIIR", innerWidth - 48, 68)
  const barW = Math.round(frameLuma) * 2.6
  ctx.fillStyle = isTraceRecording ? "#ff0088" : "#00ff9d"; ctx.shadowBlur = 9
  ctx.fillRect(innerWidth - 260, 82, barW, 9)
  ctx.shadowBlur = 0; ctx.font = "bold 17px monospace"; ctx.fillStyle = "#ffffff"
  ctx.fillText(Math.round(frameLuma) + "%", innerWidth - 48, 94)
  ctx.fillStyle = "#77aa99"; ctx.font = "10px monospace"
  ctx.fillText(`MEAN ${Math.round(exposureStats.mean)} · P5–P95 ${exposureStats.p5}–${exposureStats.p95} · CLIP ${exposureStats.clipped}`, innerWidth - 48, 108)

  if (isTraceRecording) {
    ctx.shadowBlur = 22; ctx.shadowColor = "#ff0088"; ctx.fillStyle = "#ff0088"
    ctx.font = "bold 23px monospace"; ctx.fillText("● TRACE REC", innerWidth - 48, 124)
  } else {
    ctx.shadowBlur = 8; ctx.shadowColor = "#555"; ctx.fillStyle = "#555"
    ctx.font = "bold 17px monospace"; ctx.fillText("TRACE IDLE", innerWidth - 48, 124)
  }

  // Site-mode badge
  if (siteMode) {
    const cfg = SITE_CFG[siteMode]
    ctx.shadowBlur = 12; ctx.shadowColor = cfg.color; ctx.fillStyle = cfg.color
    ctx.font = "bold 14px monospace"; ctx.textAlign = "right"
    ctx.fillText(`▦ ${cfg.label}  [${gridFocusCol},${gridFocusRow}]`, innerWidth - 48, 152)
  }

  // Dwell progress ring
  const now = performance.now(), dwellTime = now - idleStartAt
  if (confidence >= MIN_CONFIDENCE && dwellTime > 100) {
    const progress = Math.min(1, dwellTime / IDLE_LEFT_MS)
    ctx.beginPath(); ctx.strokeStyle = "#ffd700"; ctx.lineWidth = 4
    ctx.shadowBlur = 10; ctx.shadowColor = "#ffd700"
    ctx.arc(gx, gy, 125, -Math.PI/2, -Math.PI/2 + Math.PI*2*progress)
    ctx.stroke()
  }

  if (calibrationRun) {
    const [px, py] = CALIBRATION_POINTS[calibrationRun.index]
    const cx = px * innerWidth, cy = py * innerHeight
    ctx.shadowBlur = 24; ctx.shadowColor = '#ffd700'; ctx.strokeStyle = '#ffd700'; ctx.lineWidth = 3
    ctx.beginPath(); ctx.arc(cx, cy, 17, 0, Math.PI * 2); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(cx - 26, cy); ctx.lineTo(cx + 26, cy); ctx.moveTo(cx, cy - 26); ctx.lineTo(cx, cy + 26); ctx.stroke()
    ctx.shadowBlur = 0; ctx.fillStyle = '#fff'; ctx.font = 'bold 15px monospace'; ctx.textAlign = 'center'
    ctx.fillText(`LOOK HERE · ${calibrationRun.index + 1}/${CALIBRATION_POINTS.length} · SPACE`, cx, cy + 48)
  }

  // Idle mode indicator
  if (perfMode === 'idle') {
    ctx.shadowBlur = 0; ctx.fillStyle = "#ffd70066"; ctx.font = "bold 12px monospace"
    ctx.textAlign = "center"
    ctx.fillText("⏸ IDLE — move to wake", innerWidth/2, innerHeight - 18)
  }

  // Sparks
  for (let i = sparks.length - 1; i >= 0; i--) {
    const s = sparks[i]
    ctx.shadowBlur = 14; ctx.shadowColor = "#00ff9d"
    ctx.fillStyle = `rgba(0,255,157,${s.life/28})`
    ctx.fillRect(s.x - 2.5, s.y - 2.5, 5, 5)
    s.x += s.vx; s.y += s.vy; s.life -= 1.2
    if (s.life <= 0) sparks.splice(i, 1)
  }

  // Settings hint
  ctx.shadowBlur = 0; ctx.fillStyle = "#00ff9d33"; ctx.font = "11px monospace"; ctx.textAlign = "left"
  ctx.fillText("TAB = SETTINGS", 38, innerHeight - 18)
}

// ── MATRIX RAIN ──────────────────────────────────────────────
function rain() {
  bgctx.fillStyle = "rgba(10,10,20,0.10)"
  bgctx.fillRect(0, 0, innerWidth, innerHeight)
  bgctx.fillStyle = "#00ff9d"; bgctx.font = "13px monospace"
  for (let i = 0; i < drops.length; i++) {
    let ch = String.fromCharCode(0x30a0 + (Math.random() * 96) | 0)
    if (Math.random() < 0.11) ch = '⚡'
    bgctx.fillText(ch, i * 13, drops[i])
    if (drops[i] > innerHeight && Math.random() > 0.96) drops[i] = 0
    drops[i] += 12 + Math.random() * 4
  }
}

// ── SETTINGS PANEL ───────────────────────────────────────────
// Floating DOM overlay; neon/monospace aesthetic matching the canvas HUD.
let panelEl    = null
let panelOpen  = false
let statsTimer = null

function buildSettingsPanel() {
  if (panelEl) return
  const style = document.createElement('style')
  style.textContent = `
    #sr-panel{position:fixed;top:54px;right:18px;z-index:2147483647;
      background:rgba(4,4,18,0.97);border:1.5px solid #00ff9d;
      color:#00ff9d;font:13px/1.6 monospace;padding:18px 20px 14px;
      border-radius:5px;width:330px;box-shadow:0 0 40px #00ff9d33;
      display:none;user-select:none;max-height:calc(100vh - 70px);overflow:auto}
    #sr-panel h2{margin:0 0 12px;font-size:15px;color:#ffd700;
      letter-spacing:3px;border-bottom:1px solid #00ff9d22;padding-bottom:8px}
    .sr-row{margin-bottom:11px}
    .sr-label{color:#556;font-size:11px;display:block;margin-bottom:4px}
    .sr-btn{background:transparent;border:1px solid #00ff9d33;color:#00ff9d;
      font:bold 11px monospace;padding:3px 9px;margin:2px 2px 2px 0;
      cursor:pointer;border-radius:3px;transition:border-color .12s,background .12s}
    .sr-btn:hover{border-color:#00ff9d;background:#00ff9d11}
    .sr-btn.on{border-color:#ffd700;color:#ffd700;background:#ffd70015}
    .sr-slider{width:100%;accent-color:#00ff9d;display:block;margin-top:3px}
    .sr-input,.sr-select{box-sizing:border-box;width:100%;margin:3px 0;padding:5px;
      background:#080818;border:1px solid #00ff9d55;color:#00ff9d;font:12px monospace}
    .sr-color{width:42px;height:26px;padding:2px;vertical-align:middle;
      background:#080818;border:1px solid #00ff9d55;cursor:pointer}
    .sr-color-preview{display:inline-block;width:13px;height:13px;margin-right:5px;
      border-radius:50%;background:var(--cursor-preview,#00ff9d);vertical-align:middle}
    .sr-val{float:right;color:#fff}
    .sr-sep{border:0;border-top:1px solid #00ff9d1a;margin:12px 0}
    .sr-stat{color:#445;line-height:1.9;font-size:11px}
    .sr-stat span{color:#aaa}
    #sr-lut{border-collapse:collapse;width:100%;margin-top:6px}
    #sr-lut td{border:1px solid #00ff9d22;text-align:center;
      padding:3px 2px;font-size:10px;line-height:1.3;cursor:default}
    #sr-math{border-collapse:collapse;width:100%;margin-top:5px;font-size:10px}
    #sr-math th,#sr-math td{border:1px solid #00ff9d22;padding:4px;text-align:left;vertical-align:top}
    #sr-math th{color:#ffd700;width:34%}
    .sr-actions{display:flex;gap:8px;margin-top:12px;justify-content:flex-end}
    .sr-act-btn{background:transparent;font:bold 12px monospace;
      padding:4px 12px;cursor:pointer;border-radius:3px}
    #sr-close{border:1px solid #ff0088;color:#ff0088}
    #sr-reset-lut{border:1px solid #ffd700;color:#ffd700}
  `
  document.head.appendChild(style)

  panelEl = document.createElement('div')
  panelEl.id = 'sr-panel'
  panelEl.innerHTML = `
    <h2>⚙ SENSERAY SETTINGS</h2>

    <div class="sr-row">
      <span class="sr-label">RAYGUN PROFILE</span>
      <button class="sr-btn" data-p="ray1">RAY-1 BLASTER</button>
      <button class="sr-btn" data-p="ray2">RAY-2 PHASER</button>
      <button class="sr-btn" data-p="ray3">RAY-3 SNIPER</button>
    </div>

    <div class="sr-row">
      <span class="sr-label">BRAWLER RAY SENSE PRESET</span>
      <button class="sr-btn" data-ray-preset="brawler">BRAWLER</button>
      <button class="sr-btn" data-ray-preset="sense">SENSE</button>
      <button class="sr-btn" data-ray-preset="precision">PRECISION</button>
      <button class="sr-btn" data-ray-preset="phantom">PHANTOM</button>
    </div>

    <div class="sr-row">
      <span class="sr-label">PAGE RAY CURSOR</span>
      <label class="sr-label"><span class="sr-color-preview" id="sp-cursor-color"></span> COLOR <input class="sr-color" id="sl-cursor-color" type="color" value="${rayCursorSettings.color}"></label>
      <span class="sr-label">SIZE <span class="sr-val" id="sp-cursor-size">${rayCursorSettings.size}px</span></span>
      <input class="sr-slider" id="sl-cursor-size" type="range" min="8" max="40" value="${rayCursorSettings.size}">
      <span class="sr-label">GLOW <span class="sr-val" id="sp-cursor-glow">${rayCursorSettings.glow}px</span></span>
      <input class="sr-slider" id="sl-cursor-glow" type="range" min="0" max="40" value="${rayCursorSettings.glow}">
      <span class="sr-label">OPACITY <span class="sr-val" id="sp-cursor-opacity">${Math.round(rayCursorSettings.opacity*100)}%</span></span>
      <input class="sr-slider" id="sl-cursor-opacity" type="range" min="20" max="100" value="${Math.round(rayCursorSettings.opacity*100)}">
      <span class="sr-label">VISIBILITY <span class="sr-val" id="sp-cursor-holdMs">${rayCursorSettings.holdMs}ms</span></span>
      <input class="sr-slider" id="sl-cursor-holdMs" type="range" min="100" max="1500" step="50" value="${rayCursorSettings.holdMs}">
    </div>

    <div class="sr-row">
      <span class="sr-label">GAZE CALIBRATION (${calibration?.points || 0} POINTS SAVED)</span>
      <button class="sr-btn" id="sr-calibrate">${calibration ? 'RECALIBRATE' : 'START 5-POINT CALIBRATION'}</button>
      <span class="sr-label">Look at each dot and press SPACE while steady.</span>
    </div>

    <div class="sr-row">
      <span class="sr-label">SAVE / LOAD FULL PROFILE</span>
      <input class="sr-input" id="sr-profile-name" maxlength="32" placeholder="Profile name">
      <button class="sr-btn" id="sr-profile-save">SAVE CURRENT</button>
      <select class="sr-select" id="sr-profile-select"><option value="">Select saved profile…</option></select>
      <button class="sr-btn" id="sr-profile-load">LOAD SELECTED</button>
      <span class="sr-label">Includes estimator, exposure, calibration, LUT, theme and ring settings.</span>
    </div>

    <div class="sr-row">
      <span class="sr-label">FINGER CALIBRATION ASSERTION POINTS</span>
      <button class="sr-btn" id="sr-hand-open">CAPTURE OPEN HAND</button>
      <button class="sr-btn" id="sr-hand-closed">CAPTURE CLOSED FIST</button>
      <span class="sr-label" id="sr-hand-status">${handAssertion}</span>
      <span class="sr-label">Needs an external provider. Emit sense-ray-hand-pose with detail.angles.finger.mcp/pip/dip in degrees for thumb, index, middle, ring, pinky. Capture open and closed poses, then save the profile.</span>
    </div>

    <div class="sr-row">
      <span class="sr-label">VISUAL THEME</span>
      <button class="sr-btn" data-t="minimal">MINIMAL</button>
      <button class="sr-btn" data-t="balanced">BALANCED</button>
      <button class="sr-btn" data-t="performance">PERF</button>
      <button class="sr-btn" data-t="fancy">FANCY</button>
    </div>

    <div class="sr-row">
      <span class="sr-label">MNIST SYMBOL PRESET</span>
      <button class="sr-btn" data-m="classic">CLASSIC</button>
      <button class="sr-btn" data-m="sparse">SPARSE</button>
      <button class="sr-btn" data-m="dense">DENSE</button>
      <button class="sr-btn" data-m="neural">NEURAL</button>
      <button class="sr-btn" data-m="binary">BINARY</button>
    </div>

    <div class="sr-row">
      <span class="sr-label">3× XOR PRESET</span>
      <button class="sr-btn" data-xor="responsive">RESPONSIVE</button>
      <button class="sr-btn" data-xor="balanced">BALANCED</button>
      <button class="sr-btn" data-xor="precision">PRECISION</button>
    </div>

    <div class="sr-row">
      <span class="sr-label">MNIST ORBIT RINGS <span class="sr-val" id="sp-rings">${mnistRings}</span></span>
      <input class="sr-slider" type="range" id="sl-rings" min="1" max="12" value="${mnistRings}">
    </div>

    <hr class="sr-sep">

    <div class="sr-row">
      <span class="sr-label">MOTION THRESHOLD (seL4: 20–200)
        <span class="sr-val" id="sp-th">${motionTh}</span></span>
      <input class="sr-slider" type="range" id="sl-th" min="20" max="200" value="${motionTh}">
    </div>

    <div class="sr-row">
      <span class="sr-label">MIN COUNT (seL4: 1–120)
        <span class="sr-val" id="sp-mc">${minCount}</span></span>
      <input class="sr-slider" type="range" id="sl-mc" min="1" max="120" value="${minCount}">
    </div>

    <div class="sr-row">
      <span class="sr-label">FIIR α — FRAME LUMA SMOOTHING
        <span class="sr-val" id="sp-fiir">${fiirAlpha.toFixed(2)}</span></span>
      <input class="sr-slider" type="range" id="sl-fiir" min="1" max="99" value="${Math.round(fiirAlpha*100)}">
    </div>

    <div class="sr-row">
      <span class="sr-label">FRAME HISTOGRAM STRETCH <span class="sr-val" id="sp-exposure">${Math.round(exposureStrength*100)}%</span></span>
      <input class="sr-slider" type="range" id="sl-exposure" min="0" max="100" value="${Math.round(exposureStrength*100)}">
      <span class="sr-label">P5–P95 contrast correction before XOR; frame-luma proxy only, not iris or hardware exposure.</span>
    </div>

    <hr class="sr-sep">

    <div class="sr-stat" id="sr-stats"></div>

    <hr class="sr-sep">

    <span class="sr-label">GAZE LUT — VERIFIED ZONES
      (${LUT_COLS}×${LUT_ROWS}, dwell=${LUT_DWELL} frames)</span>
    <div id="sr-lut-wrap"></div>

    <hr class="sr-sep">
    <span class="sr-label">MATH / ASSERTION TABLE</span>
    <div id="sr-math-wrap"></div>

    <div class="sr-actions">
      <button id="sr-reset-lut" class="sr-act-btn">RESET LUT</button>
      <button id="sr-close"     class="sr-act-btn">✕ CLOSE</button>
    </div>
  `
  document.body.appendChild(panelEl)

  // Profile buttons
  panelEl.querySelectorAll('[data-p]').forEach(b =>
    b.addEventListener('click', () => setProfile(b.dataset.p)))
  // Theme buttons
  panelEl.querySelectorAll('[data-t]').forEach(b =>
    b.addEventListener('click', () => setTheme(b.dataset.t)))
  // MNIST preset buttons
  panelEl.querySelectorAll('[data-m]').forEach(b =>
    b.addEventListener('click', () => { mnistPreset = b.dataset.m; gazeLog(`MNIST → ${b.dataset.m}`); updateSettingsUI() }))
  panelEl.querySelectorAll('[data-xor]').forEach(b =>
    b.addEventListener('click', () => setXorPreset(b.dataset.xor)))
  panelEl.querySelectorAll('[data-ray-preset]').forEach(b =>
    b.addEventListener('click', () => applyRayPreset(b.dataset.rayPreset, { publish: true })))
  panelEl.querySelector('#sr-calibrate').addEventListener('click', beginCalibration)
  panelEl.querySelector('#sr-profile-save').addEventListener('click', saveNamedProfile)
  panelEl.querySelector('#sr-profile-load').addEventListener('click', loadNamedProfile)
  panelEl.querySelector('#sr-hand-open').addEventListener('click', () => captureHandAssertionPoint('open'))
  panelEl.querySelector('#sr-hand-closed').addEventListener('click', () => captureHandAssertionPoint('closed'))
  panelEl.querySelector('#sl-cursor-color').addEventListener('input', e => updateRayCursorSetting('color', e.target.value))
  for (const key of ['size', 'glow', 'opacity', 'holdMs']) {
    panelEl.querySelector(`#sl-cursor-${key}`).addEventListener('input', e => {
      const value = key === 'opacity' ? +e.target.value / 100 : +e.target.value
      updateRayCursorSetting(key, value)
    })
  }

  // Motion threshold slider
  panelEl.querySelector('#sl-th').addEventListener('input', e => {
    motionTh = sel4('motionTh', +e.target.value)
    panelEl.querySelector('#sp-th').textContent = motionTh
  })
  // Min count slider
  panelEl.querySelector('#sl-mc').addEventListener('input', e => {
    minCount = sel4('minCount', +e.target.value)
    panelEl.querySelector('#sp-mc').textContent = minCount
  })
  // FIIR alpha slider
  panelEl.querySelector('#sl-fiir').addEventListener('input', e => {
    fiirAlpha = sel4('fiirAlpha', +e.target.value / 100)
    panelEl.querySelector('#sp-fiir').textContent = fiirAlpha.toFixed(2)
  })
  panelEl.querySelector('#sl-exposure').addEventListener('input', e => {
    exposureStrength = Math.max(0, Math.min(1, +e.target.value / 100))
    panelEl.querySelector('#sp-exposure').textContent = `${Math.round(exposureStrength*100)}%`
  })
  panelEl.querySelector('#sl-rings').addEventListener('input', e => {
    mnistRings = Math.max(1, Math.min(12, +e.target.value))
    panelEl.querySelector('#sp-rings').textContent = mnistRings
  })

  // Actions
  panelEl.querySelector('#sr-close').addEventListener('click', () => togglePanel(false))
  panelEl.querySelector('#sr-reset-lut').addEventListener('click', () => {
    gazeLUT.forEach(row => row.forEach(c => { c.dwell = 0; c.verified = false; c.hits = 0 }))
    gazeLog('LUT RESET'); updateSettingsUI()
  })

  updateSettingsUI()
}

function updateMathTable() {
  const wrap = panelEl?.querySelector('#sr-math-wrap')
  if (!wrap) return
  const affine = calibration
    ? `x'=${calibration.x[0].toFixed(3)}x + ${calibration.x[1].toFixed(3)}y + ${calibration.x[2].toFixed(3)}; y'=${calibration.y[0].toFixed(3)}x + ${calibration.y[1].toFixed(3)}y + ${calibration.y[2].toFixed(3)}`
    : 'identity (not calibrated)'
  const rows = [
    ['Frame', `${FRAME_W}×${FRAME_H} grayscale; P5=${exposureStats.p5}, P95=${exposureStats.p95}, mean=${exposureStats.mean.toFixed(1)}, clipped=${exposureStats.clipped}`],
    ['3× XOR', `((Fₙ⊕Fₙ₋₁)∨(Fₙ₋₁⊕Fₙ₋₂)) & 0x${diffMask.toString(16).toUpperCase()} > ${motionTh}; min=${minCount}`],
    ['Centroid', `target = inverted motion centroid; accepted pixels=${motionCount}; confidence=${Math.round(confidence)}%`],
    ['Smoothing', `rawₙ = (1−α)·rawₙ₋₁ + α·target; α=${alphaBase.toFixed(2)} + distance term`],
    ['Affine (normalized)', affine],
    ['Bounds', `x∈[0,${innerWidth}], y∈[0,${innerHeight}] after calibration`],
    ['Exposure', `stretch mix=${Math.round(exposureStrength*100)}%; FIIR α=${fiirAlpha.toFixed(2)}; frame-luma proxy=${Math.round(frameLuma)}%`],
    ['LUT', `${LUT_COLS}×${LUT_ROWS}; active [${lutCell.col},${lutCell.row}], dwell=${gazeLUT[lutCell.row]?.[lutCell.col]?.dwell || 0}/${LUT_DWELL}`],
    ['MNIST', `${mnistPreset}; ${mnistRings} orbital rings; ${THEMES[currentTheme].orbitCount} glyphs`],
    ['Fingers', `s=clip((MCP−open)/(closed−open),0,1); PIP/DIP interpolation ±25°; ${handCalibration.open && handCalibration.closed ? handAssertion : 'awaiting external hand samples'}`]
  ]
  wrap.innerHTML = `<table id="sr-math"><tbody>${rows.map(([name, value]) => `<tr><th>${name}</th><td>${value}</td></tr>`).join('')}</tbody></table>`
}

function updateSettingsUI() {
  if (!panelEl) return

  const calibrateButton = panelEl.querySelector('#sr-calibrate')
  if (calibrateButton) calibrateButton.textContent = calibrationRun
    ? `CALIBRATING ${calibrationRun.index + 1}/${CALIBRATION_POINTS.length}`
    : calibration ? 'RECALIBRATE' : 'START 5-POINT CALIBRATION'

  panelEl.querySelectorAll('[data-p]').forEach(b => b.classList.toggle('on', b.dataset.p === currentProfile))
  panelEl.querySelectorAll('[data-t]').forEach(b => b.classList.toggle('on', b.dataset.t === currentTheme))
  panelEl.querySelectorAll('[data-m]').forEach(b => b.classList.toggle('on', b.dataset.m === mnistPreset))
  panelEl.querySelectorAll('[data-xor]').forEach(b => b.classList.toggle('on', b.dataset.xor === xorPreset))
  panelEl.querySelectorAll('[data-ray-preset]').forEach(b => b.classList.toggle('on', b.dataset.rayPreset === activeRayPreset))
  panelEl.querySelector('#sl-th').value = motionTh
  panelEl.querySelector('#sl-mc').value = minCount
  panelEl.querySelector('#sl-fiir').value = Math.round(fiirAlpha * 100)
  panelEl.querySelector('#sl-exposure').value = Math.round(exposureStrength * 100)
  panelEl.querySelector('#sp-exposure').textContent = `${Math.round(exposureStrength * 100)}%`
  panelEl.querySelector('#sl-rings').value = mnistRings
  panelEl.querySelector('#sp-rings').textContent = mnistRings
  panelEl.querySelector('#sl-cursor-color').value = rayCursorSettings.color
  panelEl.querySelector('#sp-cursor-color').style.setProperty('--cursor-preview', rayCursorSettings.color)
  for (const key of ['size', 'glow', 'opacity', 'holdMs']) {
    const value = key === 'opacity' ? Math.round(rayCursorSettings.opacity * 100) : rayCursorSettings[key]
    panelEl.querySelector(`#sl-cursor-${key}`).value = value
    const label = key === 'opacity' ? `${value}%` : key === 'holdMs' ? `${value}ms` : `${value}px`
    panelEl.querySelector(`#sp-cursor-${key}`).textContent = label
  }
  updateHandAssertionUI()

  const activeMin = Math.floor(stats.activeMs / 60000)
  panelEl.querySelector('#sr-stats').innerHTML =
    `SESSIONS: <span>${stats.sessions}</span><br>` +
    `FRAMES: <span>${stats.frames.toLocaleString()}</span><br>` +
    `CLICKS: <span>${stats.clicks}</span>  (L:<span>${stats.leftClicks}</span> R:<span>${stats.rightClicks}</span>)<br>` +
    `ACTIVE TIME: <span>${activeMin} min</span><br>` +
    `PERF MODE: <span style="color:${perfMode==='idle'?'#ffd700':'#00ff9d'}">${perfMode.toUpperCase()}</span><br>` +
    `RAY STYLE: <span>${activeRayPreset.toUpperCase()}</span><br>` +
    `SITE: <span>${siteMode ? SITE_CFG[siteMode].label : 'GENERIC'}</span>`

  // LUT table
  let html = '<table id="sr-lut">'
  for (let r = 0; r < LUT_ROWS; r++) {
    html += '<tr>'
    for (let c = 0; c < LUT_COLS; c++) {
      const cell   = gazeLUT[r][c]
      const active = lutCell.col === c && lutCell.row === r
      const bg     = cell.verified ? '#00ff9d22' : active ? '#ffd70022' : 'transparent'
      const bc     = cell.verified ? '#00ff9d' : active ? '#ffd700' : '#00ff9d22'
      const sym    = cell.verified ? '✓' : active ? '◉' : '·'
      html += `<td style="background:${bg};border-color:${bc};color:${cell.verified?'#00ff9d':active?'#ffd700':'#444'}">
                 ${sym}<br><span style="color:#333">${cell.hits}</span></td>`
    }
    html += '</tr>'
  }
  html += '</table>'
  panelEl.querySelector('#sr-lut-wrap').innerHTML = html
  updateMathTable()
}

function togglePanel(force) {
  if (!panelEl) buildSettingsPanel()
  panelOpen = typeof force === 'boolean' ? force : !panelOpen
  panelEl.style.display = panelOpen ? 'block' : 'none'
  if (panelOpen) {
    updateSettingsUI()
    clearInterval(statsTimer)
    statsTimer = setInterval(updateSettingsUI, 1500)
  } else {
    clearInterval(statsTimer)
  }
}

// ── START ─────────────────────────────────────────────────────
function start() {
  window.addEventListener('sense-ray-hand-pose', receiveHandPose)
  readStored(SAVED_PROFILES_KEY, {}).then(value => {
    if (value && typeof value === 'object' && !Array.isArray(value)) savedProfiles = value
    refreshSavedProfileOptions()
  })
  siteMode = detectSite()
  if (siteMode) {
    gazeLog(`SITE MODE: ${siteMode.toUpperCase()}`)
    createGridOverlay()
  }

  navigator.mediaDevices
    .getUserMedia({ video: { facingMode: "user" }, audio: false })
    .then(stream => { video.srcObject = stream; return video.play() })
    .catch(() => gazeLog("Camera access denied"))

  window.addEventListener('keydown', e => {
    // Settings panel toggle — TAB
    if (e.key === 'Tab') { e.preventDefault(); togglePanel(); return }
    if (calibrationRun && e.code === 'Space') { e.preventDefault(); confirmCalibrationPoint(); return }

    if (showCover) {
      if (e.key === ' ' || e.key === 'Enter' || (e.key >= '1' && e.key <= '7'))
        showCover = false
    }
    if (e.key === '1') setProfile('ray1')
    if (e.key === '2') setProfile('ray2')
    if (e.key === '3') setProfile('ray3')
    if (e.key === '4') setTheme('minimal')
    if (e.key === '5') setTheme('balanced')
    if (e.key === '6') setTheme('performance')
    if (e.key === '7') setTheme('fancy')
    if (!showCover) {
      if (e.key === '+' || e.key === '=') { motionTh = sel4('motionTh', motionTh + 4);  gazeLog(`TH ↑ ${motionTh}`) }
      if (e.key === '-' || e.key === '_') { motionTh = sel4('motionTh', motionTh - 4);  gazeLog(`TH ↓ ${motionTh}`) }
    }
  })

  document.getElementById("overlay").addEventListener('click', () => {
    if (showCover) showCover = false
  })

  // Performance-capped frame processing
  procInterv = setInterval(processFrame, Math.round(1000 / PERF_FPS_ACTIVE))
  perfTimer  = setTimeout(() => setPerfMode('idle'), PERF_IDLE_MS)

  setInterval(rain, 60)

  const drawLoop = () => {
    // In idle mode, skip most frames to save GPU
    if (perfMode !== 'idle' || Math.random() < 0.08) drawGaze()
    requestAnimationFrame(drawLoop)
  }
  drawLoop()

  setProfile('ray2')
  setTheme('balanced')
  try {
    if (chrome.storage?.local) chrome.storage.local.get([RAY_KEYS.preset, RAY_KEYS.cursor], result => {
      applyRayPreset(result?.[RAY_KEYS.preset] || 'sense', {
        cursor: result?.[RAY_KEYS.cursor], publish: false
      })
    })
  } catch (_) {}
  try {
    if (chrome.storage?.local) chrome.storage.local.get(CALIBRATION_KEY, result => {
      const saved = result?.[CALIBRATION_KEY]
      if (saved?.x?.length === 3 && saved?.y?.length === 3 && saved.x.concat(saved.y).every(Number.isFinite)) {
        calibration = saved
        gazeLog(`CALIBRATION RESTORED — ${saved.points || 5} points`)
      }
    })
    else {
      const saved = JSON.parse(localStorage.getItem(CALIBRATION_KEY) || 'null')
      if (saved?.x?.length === 3 && saved?.y?.length === 3 && saved.x.concat(saved.y).every(Number.isFinite)) calibration = saved
    }
  } catch (_) {}
  gazeLog(`STARTED | site:${siteMode||'GENERIC'} | session #${stats.sessions} | v2`)
}

start()
