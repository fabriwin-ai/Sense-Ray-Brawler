'use strict';

// Lightweight on-page ray indicator + site reporter.
// Receives GAZE_POS from background (originating in overlay/index.js).

let rayEl = null;
let hideTimer = null;
const RAY_PRESETS = globalThis.SENSE_RAY_PRESETS || {};
const RAY_KEYS = globalThis.SENSE_RAY_STORAGE_KEYS || {
  preset: 'senseray_active_ray_preset_v1', cursor: 'senseray_ray_cursor_style_v1'
};
let activePreset = 'sense';
let cursorStyle = { ...(RAY_PRESETS.sense?.cursor || { color: '#00ff9d', size: 18, glow: 14, opacity: 0.94, holdMs: 400 }) };

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function applyCursorStyle(style = cursorStyle) {
  const color = /^#[0-9a-f]{6}$/i.test(style.color || '') ? style.color : '#00ff9d';
  cursorStyle = {
    color,
    size: clampNumber(style.size, 18, 8, 40),
    glow: clampNumber(style.glow, 14, 0, 40),
    opacity: clampNumber(style.opacity, 0.94, 0.2, 1),
    holdMs: clampNumber(style.holdMs, 400, 100, 1500)
  };
  if (!rayEl) return;
  const { size, glow } = cursorStyle;
  rayEl.style.width = `${size}px`;
  rayEl.style.height = `${size}px`;
  rayEl.style.marginLeft = `${-size / 2}px`;
  rayEl.style.marginTop = `${-size / 2}px`;
  rayEl.style.borderRadius = activePreset === 'brawler' ? '5px' : '50%';
  rayEl.style.background = `radial-gradient(circle,${color} 0%,${color}88 42%,transparent 72%)`;
  rayEl.style.boxShadow = `0 0 ${glow}px ${color},0 0 ${glow * 2}px ${color}66`;
  rayEl.style.border = `1px solid ${color}`;
}

function applyRayConfiguration(preset, customStyle) {
  const config = RAY_PRESETS[preset] || RAY_PRESETS.sense;
  activePreset = RAY_PRESETS[preset] ? preset : 'sense';
  applyCursorStyle({ ...config.cursor, ...(customStyle || {}) });
}

function ensureRay() {
  if (rayEl) return rayEl;
  rayEl = document.createElement('div');
  rayEl.id = 'sense-ray-cursor';
  rayEl.style.cssText = [
    'position:fixed',
    'left:0',
    'top:0',
    `width:${cursorStyle.size}px`,
    `height:${cursorStyle.size}px`,
    `margin-left:${-cursorStyle.size / 2}px`,
    `margin-top:${-cursorStyle.size / 2}px`,
    `border-radius:${activePreset === 'brawler' ? '5px' : '50%'}`,
    'pointer-events:none',
    'z-index:2147483647',
    `background:radial-gradient(circle,${cursorStyle.color} 0%,${cursorStyle.color}88 42%,transparent 72%)`,
    `box-shadow:0 0 ${cursorStyle.glow}px ${cursorStyle.color},0 0 ${cursorStyle.glow * 2}px ${cursorStyle.color}66`,
    `border:1px solid ${cursorStyle.color}`,
    'opacity:0',
    'transition:opacity 0.12s linear',
    'will-change:transform,opacity'
  ].join(';');
  (document.documentElement || document.body).appendChild(rayEl);
  return rayEl;
}

function showRay(nx, ny) {
  const el = ensureRay();
  const x = (nx || 0) * window.innerWidth;
  const y = (ny || 0) * window.innerHeight;
  el.style.transform = `translate(${x}px,${y}px)`;
  el.style.opacity = String(cursorStyle.opacity);
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (rayEl) rayEl.style.opacity = '0';
  }, cursorStyle.holdMs);
}

chrome.storage.local.get([RAY_KEYS.preset, RAY_KEYS.cursor], stored => {
  const preset = stored?.[RAY_KEYS.preset] || 'sense';
  applyRayConfiguration(preset, stored?.[RAY_KEYS.cursor]);
});

function reportSite() {
  let site = null;
  try {
    const h = location.hostname;
    if (h.includes('instagram.com')) site = 'instagram';
    else if (h.includes('youtube.com')) site = 'youtube';
  } catch (_) {}
  chrome.runtime.sendMessage({ type: 'SITE_INFO', site }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'RAY_CONFIGURATION_CHANGED') {
    applyRayConfiguration(msg.preset, msg.cursor);
    return;
  }
  if (msg?.type === 'QUERY_SITE') {
    reportSite();
    return;
  }
  if (msg?.type === 'GAZE_POS' && msg.payload) {
    const { x, y, click, idleClick } = msg.payload;
    showRay(x, y);
    // Optional: synthetic click when overlay reports a blink / dwell
    if (click || idleClick === 'left') {
      const el = document.elementFromPoint(
        (x || 0) * window.innerWidth,
        (y || 0) * window.innerHeight
      );
      if (el) {
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x * innerWidth, clientY: y * innerHeight }));
      }
    }
  }
});

reportSite();
