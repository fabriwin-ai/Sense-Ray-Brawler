'use strict';

globalThis.SENSE_RAY_PRESETS = Object.freeze({
  brawler: Object.freeze({
    name: 'Brawler',
    tagline: 'Arcade response · bold target glow',
    profile: 'ray1', theme: 'fancy', mnist: 'binary', rings: 10,
    cursor: Object.freeze({ color: '#ff365d', size: 24, glow: 24, opacity: 0.98, holdMs: 560 })
  }),
  sense: Object.freeze({
    name: 'Sense',
    tagline: 'Balanced tracking · classic reticle',
    profile: 'ray2', theme: 'balanced', mnist: 'classic', rings: 8,
    cursor: Object.freeze({ color: '#00ff9d', size: 18, glow: 14, opacity: 0.94, holdMs: 400 })
  }),
  precision: Object.freeze({
    name: 'Precision',
    tagline: 'Steady input · compact cursor',
    profile: 'ray3', theme: 'performance', mnist: 'neural', rings: 5,
    cursor: Object.freeze({ color: '#58d9ff', size: 14, glow: 8, opacity: 0.9, holdMs: 300 })
  }),
  phantom: Object.freeze({
    name: 'Phantom',
    tagline: 'Minimal overlay · low visual weight',
    profile: 'ray3', theme: 'minimal', mnist: 'sparse', rings: 3,
    cursor: Object.freeze({ color: '#bd8cff', size: 12, glow: 5, opacity: 0.76, holdMs: 240 })
  })
});

globalThis.SENSE_RAY_STORAGE_KEYS = Object.freeze({
  preset: 'senseray_active_ray_preset_v1',
  cursor: 'senseray_ray_cursor_style_v1'
});
