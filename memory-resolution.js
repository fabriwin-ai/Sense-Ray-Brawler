// ============================================================
//  SENSE RAY — Memory Tier & Resolution Management
//  Implements dynamic resource allocation based on available heap
// ============================================================

// ── MEMORY TIER CONSTANTS ────────────────────────────────────
// Heap thresholds (MB) to trigger tier transitions
const MEMORY_TIERS = {
  TIER_0_CRITICAL: { max: 50,  label: 'CRITICAL',  resolution: 'quarter', buffers: 1, frameRate: 5 },
  TIER_1_LOW:      { max: 150, label: 'LOW',       resolution: 'half',    buffers: 2, frameRate: 10 },
  TIER_2_MEDIUM:   { max: 350, label: 'MEDIUM',    resolution: 'standard', buffers: 3, frameRate: 20 },
  TIER_3_HIGH:     { max: 650, label: 'HIGH',      resolution: 'hd',      buffers: 4, frameRate: 30 },
  TIER_4_EXCELLENT:{ max: Infinity, label: 'EXCELLENT', resolution: 'fullhd', buffers: 6, frameRate: 60 }
}

// Resolution profiles with concrete dimensions and pixel costs
const RESOLUTION_PROFILES = {
  quarter: { w: 40, h: 30, name: 'QUARTER', scale: 0.25, pixelCost: 1200 },      // 40×30
  half:    { w: 80, h: 60, name: 'HALF',    scale: 0.5,  pixelCost: 4800 },      // 80×60 (current default)
  standard:{ w: 160, h: 120, name: 'STD',   scale: 1.0,  pixelCost: 19200 },     // 160×120
  hd:      { w: 320, h: 240, name: 'HD',    scale: 2.0,  pixelCost: 76800 },     // 320×240
  fullhd:  { w: 640, h: 480, name: 'FULLHD', scale: 4.0, pixelCost: 307200 }     // 640×480
}

// ── GLOBAL STATE ─────────────────────────────────────────────
let detectedMemoryTier = 'TIER_2_MEDIUM'
let currentResolutionProfile = 'half'
let heapWarningLevel = 0.75  // Warn at 75% capacity
let dynamicResolutionEnabled = false
let lastHeapCheck = performance.now()
let heapCheckInterval = 2000  // Check every 2 seconds
let processingBuffers = []
let bufferPool = []
let allocationStats = { allocations: 0, deallocations: 0, peakHeap: 0 }

// ── HEAP PRESSURE DETECTION ──────────────────────────────────
/**
 * Detects available heap and determines memory tier.
 * Uses performance.memory if available (Chrome), falls back to estimation.
 * @returns {string} Tier key (TIER_0_CRITICAL, TIER_1_LOW, etc.)
 */
function detectMemoryTier() {
  // Try Chrome's performance.memory API (non-standard but widely available)
  if (performance.memory) {
    const heapLimitMB = performance.memory.jsHeapSizeLimit / 1048576
    const heapUsedMB = performance.memory.usedJSHeapSize / 1048576
    const heapFreeMB = heapLimitMB - heapUsedMB

    // Update peak tracking
    allocationStats.peakHeap = Math.max(allocationStats.peakHeap, heapUsedMB)

    // Determine tier by free heap
    if (heapFreeMB <= MEMORY_TIERS.TIER_0_CRITICAL.max) return 'TIER_0_CRITICAL'
    if (heapFreeMB <= MEMORY_TIERS.TIER_1_LOW.max) return 'TIER_1_LOW'
    if (heapFreeMB <= MEMORY_TIERS.TIER_2_MEDIUM.max) return 'TIER_2_MEDIUM'
    if (heapFreeMB <= MEMORY_TIERS.TIER_3_HIGH.max) return 'TIER_3_HIGH'
    return 'TIER_4_EXCELLENT'
  }

  // Fallback: Conservative estimation based on device capabilities
  // Assume ~512MB for low-end, ~2GB for typical, ~8GB for high-end
  const cores = navigator.hardwareConcurrency || 4
  const ram = navigator.deviceMemory || 4
  const estimatedHeapMB = Math.max(50, ram * 128)

  if (estimatedHeapMB < 150) return 'TIER_1_LOW'
  if (estimatedHeapMB < 350) return 'TIER_2_MEDIUM'
  if (estimatedHeapMB < 650) return 'TIER_3_HIGH'
  return 'TIER_4_EXCELLENT'
}

// ── HEAP PRESSURE CALCULATION ───────────────────────────────
/**
 * Returns heap pressure as a normalized 0–1 value.
 * Also logs warnings if pressure exceeds threshold.
 * @returns {number} Normalized pressure (0=free, 1=at limit)
 */
function getHeapPressure() {
  if (!performance.memory) return 0.5  // Default mid-point if unavailable

  const used = performance.memory.usedJSHeapSize
  const limit = performance.memory.jsHeapSizeLimit
  const pressure = used / limit

  // Log warning if near capacity
  if (pressure > heapWarningLevel) {
    gazeLog(`[MEMORY] ⚠ Heap pressure ${(pressure * 100).toFixed(1)}% > ${(heapWarningLevel * 100)}% threshold`)
  }

  return Math.min(1, pressure)
}

// ── RESOLUTION PROFILE SELECTION ────────────────────────────
/**
 * Selects the highest resolution supported by the current memory tier.
 * Ensures frame processing buffers remain within heap constraints.
 * @param {string} tier - Memory tier key (e.g., 'TIER_2_MEDIUM')
 * @returns {string} Resolution profile key (e.g., 'half')
 */
function selectResolutionProfile(tier) {
  const tierConfig = MEMORY_TIERS[tier]
  if (!tierConfig) {
    gazeLog(`[RESOLUTION] Unknown tier: ${tier}, using TIER_2_MEDIUM`)
    tier = 'TIER_2_MEDIUM'
    return 'half'
  }

  // Estimate memory budget: (profile pixelCost × bufferCount) in bytes
  // Assume each pixel costs ~1 byte (grayscale); uint8ClampedArray overhead ~15-20%
  const bufferCount = tierConfig.buffers
  const overheadFactor = 1.2

  // Try profiles in descending quality order
  const profileOrder = ['fullhd', 'hd', 'standard', 'half', 'quarter']
  for (const profileKey of profileOrder) {
    const profile = RESOLUTION_PROFILES[profileKey]
    const memoryNeeded = profile.pixelCost * bufferCount * overheadFactor  // in bytes
    const memoryNeededMB = memoryNeeded / 1048576

    // Allow up to 60% of free heap for frame buffers
    const heapFreeMB = (performance.memory?.jsHeapSizeLimit - performance.memory?.usedJSHeapSize) / 1048576 || 100
    const budgetMB = heapFreeMB * 0.6

    if (memoryNeededMB <= budgetMB) {
      gazeLog(`[RESOLUTION] Tier=${tierConfig.label} buffers=${bufferCount} → ${profile.name} (${profile.w}×${profile.h}, ~${memoryNeededMB.toFixed(1)}MB)`)
      return profileKey
    }
  }

  // Fallback to smallest if all profiles exceed budget
  gazeLog(`[RESOLUTION] All profiles exceed budget, using QUARTER`)
  return 'quarter'
}

// ── PROCESSING BUFFER ALLOCATION ────────────────────────────
/**
 * Allocates frame processing buffers at specified resolution.
 * Uses object pooling to reduce GC pressure.
 * @param {number} w - Buffer width in pixels
 * @param {number} h - Buffer height in pixels
 * @returns {Array<Uint8ClampedArray>} Array of allocated buffers (or pooled reused ones)
 */
function allocateProcessingBuffers(w, h) {
  const tierConfig = MEMORY_TIERS[detectedMemoryTier]
  const bufferCount = tierConfig?.buffers || 3
  const pixelCount = w * h

  const buffers = []
  for (let i = 0; i < bufferCount; i++) {
    // Try pool first
    let buf = null
    if (bufferPool.length > 0) {
      const pooled = bufferPool.pop()
      if (pooled.length === pixelCount) {
        buf = pooled
      } else {
        // Wrong size, discard and allocate new
        buf = new Uint8ClampedArray(pixelCount)
      }
    } else {
      buf = new Uint8ClampedArray(pixelCount)
    }
    buffers.push(buf)
  }

  allocationStats.allocations++
  gazeLog(`[BUFFER] Allocated ${bufferCount}× ${w}×${h} buffers (${(pixelCount * bufferCount / 1024).toFixed(1)}KB)`)
  return buffers
}

// ── HEAP-AWARE PROCESSING RESOLUTION ADJUSTMENT ──────────────
/**
 * Dynamically adjusts resolution based on heap pressure and motion count.
 * Called each frame to decide if we should downgrade to preserve performance.
 * @param {number} motionPixelCount - Number of motion-detected pixels
 * @param {number} effectiveMinCount - Minimum pixel threshold for valid gaze
 * @returns {boolean} true if resolution was changed
 */
function maybeAdjustProcessingResolution(motionPixelCount, effectiveMinCount) {
  if (!dynamicResolutionEnabled) return false

  const now = performance.now()
  if (now - lastHeapCheck < heapCheckInterval) return false
  lastHeapCheck = now

  const pressure = getHeapPressure()
  const tier = detectedMemoryTier
  const tierConfig = MEMORY_TIERS[tier]

  // Decision thresholds
  const pressureHigh = 0.85
  const pressureLow = 0.55
  const motionRatio = motionPixelCount / effectiveMinCount

  // Downgrade: pressure too high, or motion is sparse
  if (pressure > pressureHigh || (pressure > 0.7 && motionRatio < 1.2)) {
    const profileOrder = ['quarter', 'half', 'standard', 'hd', 'fullhd']
    const currentIndex = profileOrder.indexOf(currentResolutionProfile)
    if (currentIndex > 0) {
      const nextProfile = profileOrder[currentIndex - 1]
      const nextConfig = RESOLUTION_PROFILES[nextProfile]
      gazeLog(`[RESOLUTION ADJUST] Downgrade: pressure=${(pressure*100).toFixed(0)}% → ${nextConfig.name}`)
      return reallocateBuffers(nextConfig.w, nextConfig.h, nextProfile)
    }
  }

  // Upgrade: pressure low and motion is robust
  if (pressure < pressureLow && motionRatio > 1.8) {
    const profileOrder = ['quarter', 'half', 'standard', 'hd', 'fullhd']
    const currentIndex = profileOrder.indexOf(currentResolutionProfile)
    if (currentIndex < profileOrder.length - 1) {
      // Only upgrade if tier supports it
      const maxProfile = selectResolutionProfile(tier)
      const maxIndex = profileOrder.indexOf(maxProfile)
      if (currentIndex < maxIndex) {
        const nextProfile = profileOrder[currentIndex + 1]
        const nextConfig = RESOLUTION_PROFILES[nextProfile]
        gazeLog(`[RESOLUTION ADJUST] Upgrade: pressure=${(pressure*100).toFixed(0)}% → ${nextConfig.name}`)
        return reallocateBuffers(nextConfig.w, nextConfig.h, nextProfile)
      }
    }
  }

  return false
}

// ── BUFFER REALLOCATION HELPER ───────────────────────────────
/**
 * Internal: reallocates buffers when resolution changes.
 * Pools old buffers for reuse to reduce allocation churn.
 * @private
 */
function reallocateBuffers(w, h, profileKey) {
  // Pool old buffers
  processingBuffers.forEach(buf => bufferPool.push(buf))
  bufferPool.splice(100)  // Keep pool size bounded

  // Allocate new
  processingBuffers = allocateProcessingBuffers(w, h)
  currentResolutionProfile = profileKey
  allocationStats.deallocations++
  return true
}

// ── TOGGLE DYNAMIC RESOLUTION ────────────────────────────────
/**
 * Enables/disables dynamic resolution adjustment.
 * When enabled, the system automatically downgrades/upgrades
 * frame resolution to maintain 30 FPS under varying load.
 * @param {boolean} enable - true to enable, false to disable
 * @returns {object} Current state and tier info
 */
function toggleDynamicResolution(enable) {
  dynamicResolutionEnabled = Boolean(enable)
  const tier = detectMemoryTier()
  const profile = RESOLUTION_PROFILES[currentResolutionProfile]
  const pressure = getHeapPressure()

  gazeLog(`[DYNAMIC RESOLUTION] ${dynamicResolutionEnabled ? 'ENABLED' : 'DISABLED'} | tier=${MEMORY_TIERS[tier].label} | profile=${profile.name} | pressure=${(pressure*100).toFixed(0)}%`)

  return {
    enabled: dynamicResolutionEnabled,
    tier,
    profile: currentResolutionProfile,
    pressure,
    stats: { ...allocationStats }
  }
}

// ── INITIALIZATION & INTEGRATION ─────────────────────────────
/**
 * Initializes memory management system.
 * Call once during start() before processing begins.
 */
function initializeMemoryManagement() {
  detectedMemoryTier = detectMemoryTier()
  currentResolutionProfile = selectResolutionProfile(detectedMemoryTier)
  processingBuffers = allocateProcessingBuffers(
    RESOLUTION_PROFILES[currentResolutionProfile].w,
    RESOLUTION_PROFILES[currentResolutionProfile].h
  )

  gazeLog(`[MEMORY INIT] tier=${MEMORY_TIERS[detectedMemoryTier].label} | profile=${currentResolutionProfile}`)

  // Periodic tier checks
  setInterval(() => {
    const newTier = detectMemoryTier()
    if (newTier !== detectedMemoryTier) {
      detectedMemoryTier = newTier
      const newProfile = selectResolutionProfile(newTier)
      if (newProfile !== currentResolutionProfile) {
        reallocateBuffers(
          RESOLUTION_PROFILES[newProfile].w,
          RESOLUTION_PROFILES[newProfile].h,
          newProfile
        )
      }
    }
  }, 5000)
}

// ── INTEGRATION HOOKS FOR index.js ──────────────────────────
/**
 * Replaces FRAME_W, FRAME_H, and frames[] allocation in processFrame().
 * Call this at the top of processFrame() to use dynamic resolution:
 *
 *   function processFrame() {
 *     if (dynamicResolutionEnabled) maybeAdjustProcessingResolution(count, minCount)
 *     const profile = RESOLUTION_PROFILES[currentResolutionProfile]
 *     const FRAME_W = profile.w, FRAME_H = profile.h, FRAME_N = FRAME_W * FRAME_H
 *     const [frameBuf0, frameBuf1, frameBuf2] = processingBuffers
 *     ...
 */
function getFrameBufferConfig() {
  const profile = RESOLUTION_PROFILES[currentResolutionProfile]
  return {
    w: profile.w,
    h: profile.h,
    n: profile.w * profile.h,
    buffers: processingBuffers.slice(0, 3),
    profile: currentResolutionProfile
  }
}

// Export for use in index.js (if using modules)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    detectMemoryTier,
    selectResolutionProfile,
    getHeapPressure,
    allocateProcessingBuffers,
    maybeAdjustProcessingResolution,
    toggleDynamicResolution,
    initializeMemoryManagement,
    getFrameBufferConfig,
    MEMORY_TIERS,
    RESOLUTION_PROFILES,
    allocationStats
  }
}
