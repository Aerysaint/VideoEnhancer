// background/service_worker.js
// Manifest V3 module-type service worker.
// Handles all chrome.storage.local reads/writes and updates the extension badge.

const STORAGE_PREFIX = 'profile::';

const DEFAULT_PARAMS = {
  blackPoint:       0.03,
  whitePoint:       1.0,
  gamma:            1.0,
  saturation:       1.2,
  vibrance:         0.3,
  contrastMid:      0.5,
  contrastStrength: 0.5,
  brightness:       0.0,
};

// ── Message router ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case 'SAVE_PROFILE':
      saveProfile(msg.key, msg.data).then(sendResponse);
      return true;

    case 'LOAD_PROFILE':
      loadProfile(msg.key).then(sendResponse);
      return true;

    case 'DELETE_PROFILE':
      deleteProfile(msg.key).then(sendResponse);
      return true;

    case 'LIST_PROFILES':
      listProfiles().then(sendResponse);
      return true;

    case 'SET_BADGE':
      if (sender.tab?.id) {
        chrome.action.setBadgeText({ text: msg.text || '', tabId: sender.tab.id });
        chrome.action.setBadgeBackgroundColor({
          color: msg.color || '#4CAF50',
          tabId: sender.tab.id,
        });
      }
      sendResponse({ ok: true });
      break;
  }
});

// ── Storage helpers ────────────────────────────────────────────────────────

async function saveProfile(key, data) {
  await chrome.storage.local.set({ [STORAGE_PREFIX + key]: data });
  return { ok: true };
}

async function loadProfile(key) {
  const result = await chrome.storage.local.get(STORAGE_PREFIX + key);
  const stored = result[STORAGE_PREFIX + key];
  if (stored) return stored;
  return { params: { ...DEFAULT_PARAMS }, manualOverrides: {}, isDefault: true };
}

async function deleteProfile(key) {
  await chrome.storage.local.remove(STORAGE_PREFIX + key);
  return { ok: true };
}

async function listProfiles() {
  const all = await chrome.storage.local.get(null);
  const profiles = {};
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith(STORAGE_PREFIX)) {
      profiles[k.slice(STORAGE_PREFIX.length)] = v;
    }
  }
  return profiles;
}

// ── Install / update ───────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') {
    console.log('[VideoEnhancer] Installed');
  }
});
