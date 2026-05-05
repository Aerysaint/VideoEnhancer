// popup/popup.js
// Popup UI — communicates with the active tab's content script via chrome.tabs.sendMessage.

const SLIDERS = [
  { name: 'blackPoint',       label: 'Black Crush',   min: 0,    max: 0.15, step: 0.001, dec: 3 },
  { name: 'contrastStrength', label: 'Contrast',      min: 0,    max: 1.0,  step: 0.01,  dec: 2 },
  { name: 'contrastMid',      label: 'Contrast Mid',  min: 0.30, max: 0.70, step: 0.01,  dec: 2 },
  { name: 'saturation',       label: 'Saturation',    min: 0.50, max: 2.00, step: 0.01,  dec: 2 },
  { name: 'vibrance',         label: 'Vibrance',      min: 0,    max: 1.0,  step: 0.01,  dec: 2 },
  { name: 'gamma',            label: 'Gamma',         min: 0.70, max: 1.30, step: 0.01,  dec: 2 },
  { name: 'brightness',       label: 'Brightness',    min: -0.3, max: 0.3,  step: 0.005, dec: 3 },
  { name: 'whitePoint',       label: 'White Point',   min: 0.80, max: 1.05, step: 0.005, dec: 2 },
];

let activeTabId  = null;
let sliderEls    = {};     // name → { label, input, val }
let currentState = null;

// ── Messaging ──────────────────────────────────────────────────────────────

async function sendMsg(msg) {
  if (!activeTabId) return null;
  try {
    return await chrome.tabs.sendMessage(activeTabId, msg);
  } catch {
    return null;
  }
}

// ── Build slider rows ──────────────────────────────────────────────────────

function buildSliders(params, overrides) {
  const container = document.getElementById('sliders');
  container.innerHTML = '';
  sliderEls = {};

  for (const cfg of SLIDERS) {
    const val       = params[cfg.name] ?? 0;
    const overridden = cfg.name in overrides;

    const row = document.createElement('div');
    row.className = 'row';

    const labelEl = document.createElement('span');
    labelEl.className = 'row-label' + (overridden ? ' override' : '');
    labelEl.textContent = cfg.label;
    labelEl.title = overridden ? 'Manually adjusted (•)' : '';

    const input = document.createElement('input');
    input.type  = 'range';
    input.min   = cfg.min;
    input.max   = cfg.max;
    input.step  = cfg.step;
    input.value = val;

    const valEl = document.createElement('span');
    valEl.className = 'row-val';
    valEl.textContent = val.toFixed(cfg.dec);

    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      valEl.textContent = v.toFixed(cfg.dec);
      labelEl.className = 'row-label override';
      sendMsg({ type: 'SET_PARAM', name: cfg.name, value: v });
    });

    row.appendChild(labelEl);
    row.appendChild(input);
    row.appendChild(valEl);
    container.appendChild(row);

    sliderEls[cfg.name] = { label: labelEl, input, val: valEl, dec: cfg.dec };
  }
}

function updateSliders(params, overrides) {
  for (const cfg of SLIDERS) {
    const els = sliderEls[cfg.name];
    if (!els) continue;
    els.input.value  = params[cfg.name] ?? 0;
    els.val.textContent = (params[cfg.name] ?? 0).toFixed(els.dec);
    const ov = cfg.name in overrides;
    els.label.className = 'row-label' + (ov ? ' override' : '');
  }
}

// ── Profile bar ────────────────────────────────────────────────────────────

const TYPE_CLASSES = {
  'anime':        'badge-anime',
  'live-action':  'badge-live',
  'dark-ambient': 'badge-dark',
  'unknown':      'badge-unknown',
};

const TYPE_LABELS = {
  'anime':        'Anime',
  'live-action':  'Live Action',
  'dark-ambient': 'Dark Film',
  'unknown':      'Analyzing…',
};

function updateProfile(profile) {
  if (!profile) return;

  const key  = profile.profileKey || '';
  const raw  = key.includes('::') ? key.split('::').slice(1).join('::') : key;
  // Strip non-ASCII characters (e.g. Japanese/Chinese anime titles from the page)
  const title = raw.replace(/[^\x20-\x7E]/g, '').trim();

  const titleEl = document.getElementById('content-title');
  titleEl.textContent = title || 'Unknown';
  titleEl.title = title || 'Unknown';

  const badge = document.getElementById('type-badge');
  const type  = profile.contentType || 'unknown';
  badge.className   = 'badge ' + (TYPE_CLASSES[type] || 'badge-unknown');
  badge.textContent = TYPE_LABELS[type] || type;

  const countEl = document.getElementById('sample-count');
  countEl.textContent = profile.sampleCount
    ? `${profile.sampleCount} samples`
    : 'Collecting samples…';
}

// ── Init ───────────────────────────────────────────────────────────────────

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  activeTabId = tab.id;

  const state = await sendMsg({ type: 'GET_STATE' });

  const noVideoEl = document.getElementById('no-video');
  const mainEl    = document.getElementById('main');

  if (!state || !state.hasVideo) {
    noVideoEl.style.display = 'block';
    mainEl.style.display    = 'none';
    return;
  }

  noVideoEl.style.display = 'none';
  mainEl.style.display    = 'block';
  currentState = state;

  // Toggle
  const toggle      = document.getElementById('toggle');
  const toggleLabel = document.getElementById('toggle-label');
  toggle.checked    = state.isEnabled;
  toggleLabel.textContent = state.isEnabled ? 'ON' : 'OFF';

  toggle.addEventListener('change', async () => {
    const res = await sendMsg({ type: 'SET_ENABLED', enabled: toggle.checked });
    if (res) toggleLabel.textContent = toggle.checked ? 'ON' : 'OFF';
  });

  // Profile info
  if (state.profile) updateProfile(state.profile);

  // Sliders
  if (state.profile?.params) {
    buildSliders(state.profile.params, state.profile.manualOverrides || {});
  }

  // Reset button
  document.getElementById('btn-reset').addEventListener('click', async () => {
    await sendMsg({ type: 'RESET_PARAMS' });
    const fresh = await sendMsg({ type: 'GET_STATE' });
    if (fresh?.profile?.params) {
      updateSliders(fresh.profile.params, {});
    }
  });

  // Delete profile button
  document.getElementById('btn-delete').addEventListener('click', async () => {
    const key = state.profile?.profileKey;
    if (!key) return;
    await chrome.runtime.sendMessage({ type: 'DELETE_PROFILE', key });
    await sendMsg({ type: 'RESET_PARAMS' });
    window.close();
  });

  // Poll for live updates from auto-tuner while popup is open.
  setInterval(async () => {
    const fresh = await sendMsg({ type: 'GET_STATE' });
    if (!fresh?.profile) return;
    updateProfile(fresh.profile);
    updateSliders(fresh.profile.params, fresh.profile.manualOverrides || {});
  }, 2000);
}

document.addEventListener('DOMContentLoaded', init);
