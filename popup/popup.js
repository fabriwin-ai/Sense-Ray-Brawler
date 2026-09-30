'use strict';

const presets = globalThis.SENSE_RAY_PRESETS || {};
const statusLabel = document.getElementById('status-label');
const statusDetail = document.getElementById('status-detail');
const statusDot = document.getElementById('status-dot');
const messageEl = document.getElementById('popup-message');
const presetButtons = [...document.querySelectorAll('[data-preset]')];
let latestState = { active: false, preset: 'sense' };

function sendMessage(message) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage(message, response => {
      const error = chrome.runtime.lastError;
      resolve(error ? { ok: false, error: error.message } : response || { ok: true });
    });
  });
}

function renderState(state = {}) {
  latestState = { ...latestState, ...state };
  const preset = presets[latestState.preset] ? latestState.preset : 'sense';
  presetButtons.forEach(button => {
    const selected = button.dataset.preset === preset;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  statusLabel.textContent = latestState.active ? 'OVERLAY ACTIVE' : 'OVERLAY CLOSED';
  statusDetail.textContent = `${presets[preset]?.name || 'Sense'} preset · webcam gaze`;
  statusDot.classList.toggle('active', Boolean(latestState.active));
}

async function refreshState() {
  const state = await sendMessage({ type: 'GET_RAY_STATE' });
  if (state.ok === false) {
    statusLabel.textContent = 'STATUS UNAVAILABLE';
    messageEl.textContent = state.error || 'Could not read extension state.';
    return;
  }
  renderState(state);
}

chrome.runtime.onMessage.addListener(message => {
  if (message?.type === 'RAY_CONFIGURATION_CHANGED') renderState({ preset: message.preset });
});

presetButtons.forEach(button => button.addEventListener('click', async () => {
  const preset = button.dataset.preset;
  if (!presets[preset]) return;
  messageEl.textContent = 'Applying preset…';
  const result = await sendMessage({ type: 'APPLY_RAY_PRESET', preset });
  if (result.ok === false) {
    messageEl.textContent = result.error || 'Preset could not be applied.';
    return;
  }
  renderState(result);
  messageEl.textContent = `${presets[preset].name} preset applied.`;
}));

document.getElementById('open').addEventListener('click', async () => {
  messageEl.textContent = 'Opening overlay…';
  const result = await sendMessage({ type: 'OPEN_OVERLAY' });
  if (result.ok === false) messageEl.textContent = result.error || 'Overlay could not be opened.';
  await refreshState();
});

document.getElementById('close').addEventListener('click', async () => {
  messageEl.textContent = 'Closing overlay…';
  const result = await sendMessage({ type: 'CLOSE_OVERLAY' });
  if (result.ok === false) messageEl.textContent = result.error || 'Overlay could not be closed.';
  await refreshState();
});

refreshState();
