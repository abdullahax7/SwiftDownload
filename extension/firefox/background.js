/*
 * SwiftDownload browser companion (Chromium MV3 service worker / Firefox MV3 background script).
 *
 * - Captures browser downloads of the configured file types and hands them to SwiftDownload.
 *   Chromium: decided in downloads.onDeterminingFilename, when the real file name and MIME type
 *   are known (many links have no extension in the URL). Firefox: downloads.onCreated.
 * - Detects downloadable media: network responses (webRequest, headers only) and page elements
 *   (detector.js). Results are kept per tab in storage.session, so they survive the service
 *   worker being suspended, and are shown in the popup, on the floating button and (optionally)
 *   in SwiftDownload's Media detector.
 * - Opens clicked magnet: links in SwiftDownload (magnet.js) and adds "Download with
 *   SwiftDownload" to the context menu of links, images, video and audio.
 * - Talks only to the native messaging host "com.swiftdownload.host". If SwiftDownload cannot
 *   be reached, the browser keeps the download.
 *
 * Privacy: sends media/download URLs, the referring page, file names and the browser's
 * User-Agent. Cookies for a URL are sent only if the user enabled that option and granted the
 * permission. Nothing is sent anywhere except to the local SwiftDownload app.
 */
if (typeof importScripts === 'function') importScripts('classify.js', 'adapters.js');

const HOST = 'com.swiftdownload.host';
const ext = globalThis.browser ?? globalThis.chrome;
const C = globalThis.SwiftClassify;
const A = globalThis.SwiftAdapters;
const DEFAULTS = C.DEFAULTS;

const MIME_EXT = {
  'application/zip': 'zip',
  'application/x-zip-compressed': 'zip',
  'application/x-7z-compressed': '7z',
  'application/vnd.rar': 'rar',
  'application/x-rar-compressed': 'rar',
  'application/x-msdownload': 'exe',
  'application/vnd.microsoft.portable-executable': 'exe',
  'application/x-msi': 'msi',
  'application/x-ms-installer': 'msi',
  'application/pdf': 'pdf',
  'application/x-iso9660-image': 'iso',
  'application/gzip': 'gz',
  'application/x-tar': 'tar',
  'application/vnd.android.package-archive': 'apk',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/x-matroska': 'mkv',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a'
};

const MAX_ITEMS_PER_TAB = 150;

/** URLs handed to the browser again after SwiftDownload was unreachable (avoid a loop). */
const passThrough = new Set();

// ------------------------------------------------------------------------------- settings

let settings = { ...DEFAULTS };
const settingsReady = ext.storage.local.get(DEFAULTS).then(
  (s) => (settings = { ...DEFAULTS, ...s }),
  () => settings
);
ext.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  for (const [k, v] of Object.entries(changes)) settings[k] = v.newValue === undefined ? DEFAULTS[k] : v.newValue;
  if (changes.intercept) void syncBrowserUi();
  if (changes.detectTypes || changes.excludedSites || changes.detect) void refreshAllBadges();
});

async function getSettings() {
  await settingsReady;
  return settings;
}

// --------------------------------------------------------------------------- native host

function sendNative(message) {
  const fail = (e) => ({ ok: false, error: String(e && e.message ? e.message : e) });
  if (globalThis.browser) {
    return browser.runtime.sendNativeMessage(HOST, message).then((r) => r || { ok: false, error: 'no response' }, fail);
  }
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendNativeMessage(HOST, message, (resp) => {
        const err = chrome.runtime.lastError;
        resolve(err ? { ok: false, code: 'NO_HOST', error: err.message } : resp || { ok: false, error: 'no response' });
      });
    } catch (e) {
      resolve(fail(e));
    }
  });
}

/** Last known connection state, shared with the popup (survives worker restarts). */
let appStatus = { state: 'unknown', checkedAt: 0 };

function describeFailure(resp) {
  const code = resp && resp.code;
  const raw = (resp && resp.error) || '';
  if (code === 'NOT_RUNNING') return { state: 'not-running', message: 'SwiftDownload is not running. Start it, then click Reconnect.' };
  if (code === 'UPDATE_REQUIRED') return { state: 'update-required', message: 'SwiftDownload is installing a required update. Downloads stay in the browser until it is done.' };
  if (code === 'NOT_INSTALLED' || code === 'NO_HOST' || /not found|forbidden|not allowed|native messaging host/i.test(raw))
    return { state: 'not-installed', message: 'SwiftDownload is not connected to this browser. Open SwiftDownload → Options → Browser and click Register, then click Reconnect.' };
  return { state: 'error', message: `SwiftDownload could not be reached: ${raw || 'unknown error'}` };
}

async function setAppStatus(resp) {
  appStatus = resp && resp.ok ? { state: 'connected', version: resp.version || '', features: resp.features || [], checkedAt: Date.now() } : { ...describeFailure(resp), checkedAt: Date.now() };
  await ext.storage.session.set({ appStatus }).catch(() => undefined);
  return appStatus;
}

async function ping() {
  const status = await setAppStatus(await sendNative({ type: 'ping' }));
  if (status.state === 'connected') void reportAll();
  return status;
}

function setBadge(text, color, title, tabId) {
  try {
    const opts = tabId >= 0 ? { tabId } : {};
    ext.action.setBadgeBackgroundColor({ color, ...opts });
    ext.action.setBadgeText({ text, ...opts });
    ext.action.setTitle({ title, ...opts });
    setTimeout(() => {
      if (tabId >= 0) void updateBadge(tabId);
      else {
        ext.action.setBadgeText({ text: '' });
        ext.action.setTitle({ title: 'SwiftDownload' });
      }
    }, 5000);
  } catch (e) {
    // the tab may be gone
  }
}

async function cookieHeader(url) {
  const s = await getSettings();
  if (!s.sendCookies || !ext.cookies) return null;
  try {
    const origin = new URL(url).origin + '/*';
    if (!(await ext.permissions.contains({ permissions: ['cookies'], origins: [origin] }))) return null;
    const cookies = await ext.cookies.getAll({ url });
    return cookies.length ? cookies.map((c) => `${c.name}=${c.value}`).join('; ') : null;
  } catch (e) {
    return null;
  }
}

function isMagnet(url) {
  return /^magnet:\?/i.test(url || '');
}

/** Same download sent twice within this window is ignored (double clicks, repeated events). */
const recentSends = new Map();

/**
 * Hands a download to SwiftDownload. `extra`: { kind: 'hls'|'dash', video, audio, title }.
 */
async function sendToApp(url, referrer, filename, extra = {}, tabId = -1) {
  const magnet = isMagnet(url);
  if (!magnet && !C.isHttp(url)) {
    setBadge('!', '#dc2626', 'SwiftDownload: only http, https and magnet links can be sent.', tabId);
    return { ok: false, error: 'Only http, https and magnet links can be sent.' };
  }
  const key = [url, extra.video || '', extra.audio || ''].join('\n');
  const last = recentSends.get(key);
  if (last && Date.now() - last < 10_000) return { ok: true, duplicate: true };
  recentSends.set(key, Date.now());
  for (const [k, t] of recentSends) if (Date.now() - t > 60_000) recentSends.delete(k);
  const resp = await sendNative({
    type: 'add',
    url,
    referrer: referrer || null,
    filename: filename || null,
    userAgent: navigator.userAgent,
    cookie: magnet ? null : await cookieHeader(url),
    kind: extra.kind && extra.kind !== 'direct' ? extra.kind : null,
    video: extra.video || null,
    audio: extra.audio || null,
    title: extra.title || null
  });
  if (resp && resp.ok) {
    void setAppStatus({ ok: true, version: appStatus.version, features: appStatus.features });
    setBadge('↓', '#2563eb', 'Sent to SwiftDownload', tabId);
  } else {
    recentSends.delete(key);
    const st = await setAppStatus(resp);
    setBadge('!', '#dc2626', st.message, tabId);
  }
  return resp && resp.ok ? resp : { ...(resp || {}), ok: false, error: describeFailure(resp).message };
}

// ------------------------------------------------------------------- download interception

function baseName(p) {
  return (p || '').split(/[\\/]/).pop() || '';
}

function extensionOf(item) {
  const m = /\.([a-z0-9]{1,10})$/i.exec(baseName(item.filename));
  if (m) return m[1].toLowerCase();
  for (const u of [item.finalUrl, item.url]) {
    try {
      const p = /\.([a-z0-9]{1,10})$/i.exec(new URL(u).pathname);
      if (p) return p[1].toLowerCase();
    } catch (e) {
      // ignore
    }
  }
  return item.mime ? MIME_EXT[item.mime.split(';')[0].trim().toLowerCase()] || '' : '';
}

async function shouldCapture(item) {
  const s = await getSettings();
  if (!s.intercept) return false;
  const url = item.finalUrl || item.url;
  if (!/^https?:\/\//i.test(url)) return false; // blob:, data:, file: stay in the browser
  if (item.byExtensionId && item.byExtensionId === ext.runtime.id) return false;
  if (item.state && item.state !== 'in_progress') return false;
  if (passThrough.has(item.url) || passThrough.has(url)) return false;
  if (C.isExcluded(A.hostOf(item.referrer || url), s.excludedSites)) return false;
  if (!s.captureAll) {
    const wanted = s.extensions.toLowerCase().split(/[\s,;]+/).filter(Boolean);
    const e = extensionOf(item);
    if (!e || !wanted.includes(e)) return false;
  }
  if (s.minSizeMB > 0 && item.totalBytes > 0 && item.totalBytes < s.minSizeMB * 1024 * 1024) return false;
  return true;
}

/** Download ids already being handled (several events can fire for one download). */
const handled = new Set();

/** Returns true when the download was taken over by SwiftDownload. */
async function capture(item) {
  if (handled.has(item.id)) return false;
  handled.add(item.id);
  if (!(await shouldCapture(item))) {
    handled.delete(item.id);
    return false;
  }
  setTimeout(() => handled.delete(item.id), 120_000);
  const url = item.finalUrl || item.url;
  // Cancel the browser's copy immediately so it never shows up in the browser.
  await ext.downloads.cancel(item.id).catch(() => undefined);
  ext.downloads.erase({ id: item.id }).catch(() => undefined);
  const resp = await sendToApp(url, item.referrer || null, baseName(item.filename) || null);
  if (resp && resp.ok) return true;
  // SwiftDownload is unreachable: let the browser download the file after all.
  passThrough.add(item.url);
  passThrough.add(url);
  setTimeout(() => {
    passThrough.delete(item.url);
    passThrough.delete(url);
  }, 60_000);
  setBrowserUi(true);
  setTimeout(() => void syncBrowserUi(), 30_000);
  await ext.downloads.download({ url }).catch(() => undefined);
  return false;
}

/** Hide the browser's own download bubble/shelf while SwiftDownload takes the downloads (Chromium 115+). */
function setBrowserUi(enabled) {
  try {
    if (ext.downloads.setUiOptions) void ext.downloads.setUiOptions({ enabled }).catch(() => undefined);
  } catch (e) {
    // not supported (Firefox)
  }
}

async function syncBrowserUi() {
  const s = await getSettings();
  setBrowserUi(!s.intercept);
}

void syncBrowserUi();

// 1) As soon as the download starts, when the URL or MIME type already shows the file type.
ext.downloads.onCreated.addListener((item) => {
  void capture(item).catch(() => undefined);
});

// 2) Chromium: when the real file name (Content-Disposition) is known, for links without an extension.
if (ext.downloads.onDeterminingFilename) {
  ext.downloads.onDeterminingFilename.addListener((item, suggest) => {
    capture(item)
      .catch(() => false)
      .then(() => {
        try {
          suggest();
        } catch (e) {
          // the download may already be cancelled
        }
      });
    return true; // we call suggest() asynchronously
  });
}

// 3) Fallback for browsers/situations where (2) does not run: the file name changed.
ext.downloads.onChanged.addListener((delta) => {
  if (!delta.filename || !delta.filename.current) return;
  ext.downloads
    .search({ id: delta.id })
    .then((items) => items[0] && items[0].state === 'in_progress' && capture(items[0]))
    .catch(() => undefined);
});

// ------------------------------------------------------------------------ detected media

/** tabId → { pageUrl, title, items: { [id]: item } } */
let tabs = {};
const tabsReady = ext.storage.session.get(['tabs', 'appStatus']).then(
  (s) => {
    tabs = { ...(s.tabs || {}), ...tabs };
    if (s.appStatus) appStatus = s.appStatus;
  },
  () => undefined
);

let saveTimer = null;
function saveTabs() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void ext.storage.session.set({ tabs }).catch(() => undefined);
  }, 400);
}

function tabEntry(tabId) {
  if (!tabs[tabId]) tabs[tabId] = { pageUrl: '', title: '', items: {} };
  return tabs[tabId];
}

function visibleItems(entry, s) {
  return Object.values(entry.items).filter((i) => C.wants(s, i.category, i.method));
}

async function updateBadge(tabId) {
  const s = await getSettings();
  const entry = tabs[tabId];
  const n = entry && s.detect && !C.isExcluded(A.hostOf(entry.pageUrl), s.excludedSites) ? visibleItems(entry, s).length : 0;
  try {
    await ext.action.setBadgeBackgroundColor({ color: '#2563eb', tabId });
    await ext.action.setBadgeText({ text: n ? String(Math.min(n, 99)) : '', tabId });
    await ext.action.setTitle({ title: n ? `SwiftDownload — ${n} downloadable item${n === 1 ? '' : 's'} on this page` : 'SwiftDownload', tabId });
  } catch (e) {
    // the tab is gone
  }
}

async function refreshAllBadges() {
  await tabsReady;
  for (const id of Object.keys(tabs)) void updateBadge(Number(id));
}

function resetTab(tabId, pageUrl) {
  tabs[tabId] = { pageUrl: pageUrl || '', title: '', items: {} };
  saveTabs();
  void updateBadge(tabId);
}

const pendingReports = new Map(); // tabId -> timer

/**
 * Adds or updates a detected item for a tab. `r` comes from SwiftClassify.classify (network) or
 * from a validated content-script report.
 */
function addItem(tabId, r, source, extra = {}) {
  const entry = tabEntry(tabId);
  const id = C.idOf(r.url);
  const old = entry.items[id];
  const item = {
    id,
    url: C.normalizeUrl(r.url),
    category: r.category,
    method: r.method,
    format: r.format || (old && old.format) || '',
    mime: r.mime || (old && old.mime) || null,
    size: r.size || (old && old.size) || null,
    fileName: r.fileName || (old && old.fileName) || null,
    title: extra.title || (old && old.title) || null,
    resolution: extra.resolution || (old && old.resolution) || null,
    duration: extra.duration || (old && old.duration) || null,
    source: old && old.source !== source ? 'both' : source,
    detectedAt: (old && old.detectedAt) || Date.now(),
    reported: old ? old.reported : false,
    media: old ? old.media : null
  };
  if (old && JSON.stringify({ ...old, reported: 0 }) === JSON.stringify({ ...item, reported: 0 })) return;
  entry.items[id] = item;
  const all = Object.values(entry.items);
  if (all.length > MAX_ITEMS_PER_TAB) {
    all.sort((a, b) => a.detectedAt - b.detectedAt);
    for (const x of all.slice(0, all.length - MAX_ITEMS_PER_TAB)) delete entry.items[x.id];
  }
  if (!old || item.size !== old.size || item.title !== old.title) item.reported = false;
  saveTabs();
  void updateBadge(tabId);
  scheduleReport(tabId);
}

function scheduleReport(tabId) {
  if (pendingReports.has(tabId)) return;
  pendingReports.set(
    tabId,
    setTimeout(() => {
      pendingReports.delete(tabId);
      void reportTab(tabId);
    }, 1500)
  );
}

/** Sends unreported items of a tab to the app's Media detector (when connected). */
async function reportTab(tabId) {
  const s = await getSettings();
  const entry = tabs[tabId];
  if (!entry || !s.reportToApp || !s.detect) return;
  if (appStatus.state !== 'connected' && Date.now() - (appStatus.checkedAt || 0) < 60_000) return;
  if (C.isExcluded(A.hostOf(entry.pageUrl), s.excludedSites)) return;
  const items = visibleItems(entry, s)
    .filter((i) => !i.reported)
    .slice(0, 50);
  if (!items.length) return;
  const payload = [];
  for (const i of items) {
    payload.push({
      url: i.url,
      method: i.method,
      category: i.category,
      mime: i.mime,
      size: i.size,
      title: i.title || entry.title || null,
      fileName: i.fileName,
      pageUrl: C.isHttp(entry.pageUrl) ? entry.pageUrl : null,
      pageTitle: entry.title || null,
      resolution: i.resolution,
      format: i.format || null,
      duration: i.duration,
      cookie: await cookieHeader(i.url)
    });
  }
  const resp = await sendNative({ type: 'detected', items: payload, userAgent: navigator.userAgent });
  if (resp && resp.ok) {
    for (const i of items) if (entry.items[i.id]) entry.items[i.id].reported = true;
    saveTabs();
    if (appStatus.state !== 'connected') void setAppStatus({ ok: true, version: appStatus.version, features: appStatus.features });
  } else {
    void setAppStatus(resp);
  }
}

async function reportAll() {
  await tabsReady;
  for (const id of Object.keys(tabs)) scheduleReport(Number(id));
}

function headerMap(headers) {
  const m = {};
  for (const h of headers || []) m[h.name.toLowerCase()] = h.value || '';
  return m;
}

function onHeaders(d) {
  if (d.tabId < 0 || d.statusCode >= 400 || d.statusCode === 204) return;
  // After a worker restart the saved lists must be loaded before anything is added.
  void Promise.all([tabsReady, settingsReady]).then(() => handleHeaders(d));
}

function handleHeaders(d) {
  const h = headerMap(d.responseHeaders);
  if (d.type === 'main_frame') {
    // A new document in the tab: start a fresh list (but not for downloads, which keep the page).
    if (!C.isAttachment(h['content-disposition'])) resetTab(d.tabId, d.url);
  }
  if (!settings.detect) return;
  const entry = tabEntry(d.tabId);
  const pageUrl = entry.pageUrl || d.documentUrl || d.initiator || '';
  if (C.isExcluded(A.hostOf(pageUrl), settings.excludedSites)) return;
  if (!A.allowNetwork(pageUrl, d.url)) return;
  const r = C.classify({ url: d.url, mime: h['content-type'], disposition: h['content-disposition'], contentRange: h['content-range'], contentLength: h['content-length'] });
  if (!r || r.segment) return;
  // From network traffic only media, streams and real file responses are offered; images and
  // documents fetched by scripts are page resources (the page scanner finds the useful ones).
  const isFile = d.type === 'main_frame' || d.type === 'sub_frame' || r.attachment;
  if (r.method === 'direct') {
    if (r.category === 'video' || r.category === 'audio') {
      if (r.size !== null && r.size < C.MIN_NETWORK_MEDIA_BYTES) return;
    } else if (!isFile) return;
  }
  addItem(d.tabId, r, 'network');
}

if (ext.webRequest) {
  try {
    ext.webRequest.onHeadersReceived.addListener(onHeaders, { urls: ['<all_urls>'], types: ['main_frame', 'sub_frame', 'media', 'xmlhttprequest', 'object', 'other'] }, ['responseHeaders']);
  } catch (e) {
    // no host permission yet (Firefox until granted)
  }
}

ext.tabs.onRemoved.addListener((tabId) => {
  void tabsReady.then(() => {
    delete tabs[tabId];
    saveTabs();
  });
});
ext.tabs.onReplaced.addListener((added, removed) => {
  void tabsReady.then(() => {
    if (tabs[removed]) tabs[added] = tabs[removed];
    delete tabs[removed];
    saveTabs();
  });
});
ext.tabs.onUpdated.addListener((tabId, info, tab) => {
  void tabsReady.then(() => {
    const entry = tabEntry(tabId);
    if (info.url) entry.pageUrl = info.url;
    if (tab && tab.title) entry.title = tab.title.slice(0, 300);
    if (info.url || info.title) saveTabs();
  });
});

/** Validates an item reported by the content script. */
function fromPage(raw) {
  if (!raw || typeof raw.url !== 'string') return null;
  const r = C.classifyElementSource(raw.url, typeof raw.mime === 'string' ? raw.mime : '', raw.category);
  if (!r || r.segment) return null;
  if (typeof raw.fileName === 'string') r.fileName = C.sanitizeName(raw.fileName) || r.fileName;
  const str = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
  const res = str(raw.resolution, 32);
  return {
    r,
    extra: {
      title: str(raw.title, 300),
      resolution: res && /^\d{1,5}x\d{1,5}$/.test(res) ? res : null,
      duration: Number.isFinite(raw.duration) && raw.duration > 0 ? raw.duration : null
    }
  };
}

async function tabMedia(tabId) {
  await tabsReady;
  const s = await getSettings();
  const entry = tabs[tabId] || { pageUrl: '', title: '', items: {} };
  let pageUrl = entry.pageUrl;
  if (!pageUrl) pageUrl = await ext.tabs.get(tabId).then((t) => t.url || '', () => '');
  const excluded = C.isExcluded(A.hostOf(pageUrl), s.excludedSites);
  const items = excluded || !s.detect ? [] : visibleItems(entry, s).sort((a, b) => b.detectedAt - a.detectedAt);
  return { items, pageUrl, title: entry.title, excluded, adapter: A.describe(pageUrl), appStatus, settings: s };
}

function findItem(tabId, id) {
  const entry = tabs[tabId];
  return entry && entry.items[id] ? { entry, item: entry.items[id] } : null;
}

async function inspectItem(tabId, id) {
  await tabsReady;
  const found = findItem(tabId, id);
  if (!found) return { ok: false, error: 'This item is no longer listed. Reload the page.' };
  const { entry, item } = found;
  if (item.method === 'direct') return { ok: true, media: null };
  const resp = await sendNative({ type: 'inspect', url: item.url, referrer: C.isHttp(entry.pageUrl) ? entry.pageUrl : null, userAgent: navigator.userAgent, cookie: await cookieHeader(item.url) });
  if (resp && resp.ok) {
    item.media = resp.media;
    saveTabs();
    void setAppStatus({ ok: true, version: appStatus.version, features: appStatus.features });
    return resp;
  }
  if (resp && resp.code && /NOT_|NO_HOST/.test(resp.code)) {
    const st = await setAppStatus(resp);
    return { ok: false, error: st.message, offline: true };
  }
  if (resp && /invalid message|Unknown channel/i.test(resp.error || '')) return { ok: false, error: 'Update SwiftDownload: this version cannot list stream formats.' };
  return { ok: false, error: (resp && resp.error) || 'The stream could not be read.' };
}

async function downloadItem(tabId, id, selection = {}) {
  await tabsReady;
  const found = findItem(tabId, id);
  if (!found) return { ok: false, error: 'This item is no longer listed. Reload the page.' };
  const { entry, item } = found;
  const title = item.title || (item.method !== 'direct' ? entry.title : null);
  return sendToApp(
    item.url,
    C.isHttp(entry.pageUrl) ? entry.pageUrl : null,
    item.method === 'direct' ? item.fileName : null,
    { kind: item.method, video: selection.video, audio: selection.audio, title },
    tabId
  );
}

/** Streams of a tab (newest first) for blob:/MSE players. */
function tabStreams(tabId) {
  const entry = tabs[tabId];
  if (!entry) return [];
  return Object.values(entry.items)
    .filter((i) => i.method !== 'direct')
    .sort((a, b) => b.detectedAt - a.detectedAt);
}

ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;
  // Only our own pages and content scripts can send messages here (no externally_connectable).
  if (sender.id && sender.id !== ext.runtime.id) return false;
  // Content scripts act on their own tab; extension pages (popup, also when opened as a tab) name one.
  const fromExtensionPage = sender.url && sender.url.startsWith(ext.runtime.getURL(''));
  const tabId = fromExtensionPage && msg.tabId !== undefined ? Number(msg.tabId) : sender.tab ? sender.tab.id : Number(msg.tabId);
  const reply = (p) => {
    Promise.resolve(p).then(sendResponse, (e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  };
  switch (msg.type) {
    case 'ping':
    case 'reconnect':
      return reply(ping());
    case 'status':
      return reply(tabsReady.then(() => appStatus));
    case 'magnet':
      if (!isMagnet(msg.url)) return false;
      return reply(sendToApp(msg.url, (sender.tab && sender.tab.url) || null, null, {}, tabId));
    case 'page-media': {
      if (!sender.tab || !Array.isArray(msg.items)) return false;
      return reply(
        (async () => {
          await tabsReady;
          const s = await getSettings();
          const entry = tabEntry(tabId);
          if (sender.frameId === 0) {
            if (typeof msg.pageTitle === 'string') entry.title = msg.pageTitle.slice(0, 300);
            if (sender.tab.url) entry.pageUrl = sender.tab.url;
          }
          if (!s.detect || C.isExcluded(A.hostOf(entry.pageUrl || sender.tab.url), s.excludedSites)) return { ok: true, accepted: 0 };
          let accepted = 0;
          for (const raw of msg.items.slice(0, 150)) {
            const v = fromPage(raw);
            if (!v) continue;
            addItem(tabId, v.r, 'page', v.extra);
            accepted++;
          }
          return { ok: true, accepted };
        })()
      );
    }
    case 'tab-media':
      return reply(tabMedia(tabId));
    case 'player-sources':
      // Floating button: what can be downloaded for a player on this page?
      return reply(tabsReady.then(() => ({ streams: tabStreams(tabId), appStatus })));
    case 'inspect':
      return reply(inspectItem(tabId, String(msg.id || '')));
    case 'download':
      return reply(downloadItem(tabId, String(msg.id || ''), msg.selection || {}));
    case 'download-url': {
      // A direct media/image URL from the page (floating button, image indicator).
      const r = typeof msg.url === 'string' && C.isHttp(msg.url) ? C.classifyElementSource(msg.url, null, 'video') : null;
      if (!r) return reply({ ok: false, error: 'This media has no downloadable address.' });
      const title = typeof msg.title === 'string' ? msg.title.slice(0, 300) : null;
      return reply(sendToApp(r.url, (sender.tab && sender.tab.url) || null, r.method === 'direct' ? r.fileName : null, { kind: r.method, title }, tabId));
    }
    default:
      return false;
  }
});

// ------------------------------------------------------------------------- context menus

const MENU_ID = 'swiftdownload-link';
function createMenu() {
  ext.contextMenus.removeAll(() => {
    ext.contextMenus.create({ id: MENU_ID, title: 'Download with SwiftDownload', contexts: ['link', 'image', 'video', 'audio'] }, () => void ext.runtime.lastError);
  });
}

async function onMenu(info, tab) {
  const tabId = tab ? tab.id : -1;
  const pageUrl = info.pageUrl || (tab && tab.url) || null;
  const media = info.mediaType && info.srcUrl;
  if (media && C.isHttp(info.srcUrl)) {
    const r = C.classify({ url: info.srcUrl });
    return sendToApp(info.srcUrl, pageUrl, r && r.fileName, {}, tabId);
  }
  if (media && (info.mediaType === 'video' || info.mediaType === 'audio')) {
    // blob:/MediaSource players: use the stream this tab loaded.
    await tabsReady;
    const stream = tabStreams(tabId)[0];
    if (stream) return downloadItem(tabId, stream.id, {});
    if (!info.linkUrl) return setBadge('!', '#dc2626', 'SwiftDownload: no downloadable source was found for this player. It may be protected (DRM) or not supported.', tabId);
  }
  if (info.linkUrl) return sendToApp(info.linkUrl, pageUrl, null, {}, tabId);
  return null;
}

if (ext.contextMenus) {
  ext.runtime.onInstalled.addListener(createMenu);
  ext.runtime.onStartup.addListener(createMenu);
  ext.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === MENU_ID) void onMenu(info, tab).catch(() => undefined);
  });
}
