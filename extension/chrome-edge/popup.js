const ext = globalThis.browser ?? globalThis.chrome;
const C = globalThis.SwiftClassify;
const $ = (id) => document.getElementById(id);

const ICONS = { video: '🎬', audio: '🎵', image: '🖼️', document: '📄', archive: '🗜️', other: '📦' };
const FILTERS = [
  ['all', 'All'],
  ['video', 'Video'],
  ['audio', 'Audio'],
  ['image', 'Images'],
  ['document', 'Documents'],
  ['archive', 'Archives'],
  ['other', 'Other']
];
const METHOD = { direct: 'File', hls: 'HLS stream', dash: 'DASH stream' };

let tabId = -1;
let data = null;
let filter = 'all';
let openFormats = null;

function send(msg) {
  return Promise.resolve(ext.runtime.sendMessage({ ...msg, tabId })).catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
}

function el(tag, props = {}, children = []) {
  const e = document.createElement(tag);
  Object.assign(e, props);
  for (const c of [].concat(children)) if (c !== null && c !== undefined) e.append(c);
  return e;
}

function renderStatus(st) {
  const bar = $('status');
  const text = $('status-text');
  bar.className = 'status-bar';
  $('reconnect').hidden = true;
  if (!st || st.state === 'unknown') {
    text.textContent = 'Checking connection…';
    return;
  }
  if (st.state === 'connected') {
    bar.classList.add('connected');
    text.textContent = `Connected to SwiftDownload ${st.version || ''}`.trim();
    return;
  }
  bar.classList.add('problem');
  text.textContent = st.message || 'SwiftDownload is not reachable.';
  $('reconnect').hidden = false;
}

function title(item) {
  // Streams are named after the page they play on (the manifest file name means little).
  if (item.method !== 'direct' && !item.title && data && data.title) return data.title;
  return item.title || item.fileName || C.fileNameFromUrl(item.url) || item.url;
}

function meta(item) {
  return [
    (item.format || '').toUpperCase(),
    item.resolution,
    item.size ? C.humanSize(item.size) : '',
    METHOD[item.method] || '',
    (() => {
      try {
        return new URL(item.url).hostname;
      } catch (e) {
        return '';
      }
    })()
  ]
    .filter(Boolean)
    .join(' · ');
}

function rate(bps) {
  return bps >= 1e6 ? `${(bps / 1e6).toFixed(1)} Mbps` : `${Math.round(bps / 1e3)} kbps`;
}

async function download(item, selection, button) {
  if (button) button.disabled = true;
  const r = await send({ type: 'download', id: item.id, selection });
  if (button) {
    button.disabled = false;
    button.textContent = r && r.ok ? 'Sent ✓' : 'Failed';
  }
  if (!r || !r.ok) showNotice((r && r.error) || 'SwiftDownload could not be reached.', true);
  else if (openFormats === item.id) {
    openFormats = null;
    render();
  }
}

async function formats(item, box) {
  box.replaceChildren(el('span', { className: 'muted small', textContent: 'Reading available formats…' }));
  const r = await send({ type: 'inspect', id: item.id });
  box.replaceChildren();
  if (!r || !r.ok) {
    box.append(el('span', { className: 'error small', textContent: (r && r.error) || 'The stream could not be read.' }));
    if (r && r.offline) void refreshStatus();
    return;
  }
  const m = r.media;
  if (!m || !m.supported) {
    box.append(el('span', { className: 'error small', textContent: (m && m.reason) || 'This stream cannot be downloaded.' }));
    return;
  }
  let estimates = false;
  const choice = (label, sub, selection) => {
    const b = el('button', { className: 'choice', type: 'button' }, [label, sub ? el('span', { className: 'sub', textContent: sub }) : null]);
    b.addEventListener('click', () => void download(item, selection, null));
    box.append(b);
  };
  for (const v of m.variants.filter((x) => x.kind !== 'audio')) {
    estimates = estimates || !!v.estimatedBytes;
    const sub = [v.bandwidth ? rate(v.bandwidth) : '', v.estimatedBytes ? `≈ ${C.humanSize(v.estimatedBytes)}` : '', v.kind === 'video' ? 'separate audio' : ''].filter(Boolean).join(' · ');
    choice(v.resolution ? `${v.resolution.split('x')[1]}p` : 'Video', sub, { video: v.id });
  }
  const audios = m.audioTracks.length ? m.audioTracks : m.variants.filter((x) => x.kind === 'audio');
  for (const a of audios) choice(`Audio only${a.label || a.language ? ` (${a.label || a.language})` : ''}`, a.bandwidth ? rate(a.bandwidth) : '', { video: 'none', audio: a.id });
  if (!box.childElementCount) choice('Download stream', '', {});
  if (estimates) box.append(el('span', { className: 'muted small', textContent: 'Sizes marked ≈ are estimates from the stream bitrate.' }));
}

function showNotice(text, isError) {
  const n = $('notice');
  n.hidden = !text;
  n.replaceChildren(text ? el('span', { className: isError ? 'error' : '', textContent: text }) : '');
}

function render() {
  if (!data) return;
  const s = data.settings || C.DEFAULTS;
  const notices = [];
  if (!s.detect) notices.push('Media detection is turned off. Turn it on in Options.');
  else if (data.excluded) notices.push('Detection is turned off for this site (excluded in Options).');
  if (data.adapter && data.adapter.unsupported) notices.push(data.adapter.limitations);
  if (!C.isHttp(data.pageUrl)) notices.push('Media cannot be detected on browser pages.');
  showNotice(notices.join(' '), false);
  $('site').textContent = data.adapter && data.adapter.id !== 'generic' ? `${data.adapter.name} rules` : '';

  const present = new Set(data.items.map((i) => i.category));
  if (filter !== 'all' && !present.has(filter)) filter = 'all';
  $('filters').replaceChildren(
    ...FILTERS.filter(([k]) => k === 'all' || present.has(k)).map(([k, label]) => {
      const b = el('button', { className: 'chip', type: 'button', textContent: label });
      b.setAttribute('aria-pressed', String(filter === k));
      b.addEventListener('click', () => {
        filter = k;
        render();
      });
      return b;
    })
  );
  $('filters').hidden = present.size < 2;

  const items = data.items.filter((i) => filter === 'all' || i.category === filter);
  $('count').textContent = data.items.length ? `(${data.items.length})` : '';
  if (!items.length) {
    const msg = data.excluded || !s.detect ? '' : 'No downloadable media found on this page yet. Start playing a video, or choose more file types in Options.';
    $('list').replaceChildren(el('div', { className: 'empty muted' }, msg));
    return;
  }
  $('list').replaceChildren(
    ...items.map((item) => {
      const btn = el('button', { type: 'button', textContent: item.method === 'direct' ? 'Download' : openFormats === item.id ? 'Close' : 'Formats' });
      const row = el('div', { className: 'item' }, [
        el('span', { className: 'icon', textContent: ICONS[item.category] || ICONS.other }),
        el('div', {}, [el('div', { className: 'title', title: item.url, textContent: title(item) }), el('div', { className: 'meta', textContent: meta(item) })]),
        btn
      ]);
      if (item.method === 'direct') btn.addEventListener('click', () => void download(item, {}, btn));
      else {
        btn.addEventListener('click', () => {
          openFormats = openFormats === item.id ? null : item.id;
          render();
        });
        if (openFormats === item.id) {
          const box = el('div', { className: 'formats' });
          row.append(box);
          void formats(item, box);
        }
      }
      return row;
    })
  );
}

async function load() {
  data = await send({ type: 'tab-media' });
  if (data && data.items) render();
}

async function refreshStatus() {
  renderStatus({ state: 'unknown' });
  renderStatus(await send({ type: 'ping' }));
}

async function init() {
  // popup.html?tab=<id> shows another tab's media (used when the popup is opened as a page).
  const forced = Number(new URLSearchParams(location.search).get('tab'));
  if (Number.isInteger(forced) && forced > 0) tabId = forced;
  else {
    const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
    tabId = tab ? tab.id : -1;
  }
  const s = await ext.storage.local.get({ intercept: true });
  $('intercept').checked = s.intercept;
  $('intercept').addEventListener('change', () => ext.storage.local.set({ intercept: $('intercept').checked }));
  $('options').addEventListener('click', () => ext.runtime.openOptionsPage());
  $('reconnect').addEventListener('click', async () => {
    await refreshStatus();
    await load();
  });
  renderStatus(await send({ type: 'status' }));
  void refreshStatus();
  await load();
  // Firefox grants website access only when asked; without it nothing can be detected.
  const ALL = { origins: ['<all_urls>'] };
  if (!(await ext.permissions.contains(ALL).catch(() => true))) {
    const b = el('button', { type: 'button', textContent: 'Allow access to websites' });
    b.addEventListener('click', async () => {
      if (await ext.permissions.request(ALL).catch(() => false)) {
        b.remove();
        ext.runtime.reload();
      }
    });
    $('notice').hidden = false;
    $('notice').replaceChildren(el('div', { textContent: 'SwiftDownload needs access to websites to detect media. ' }), b);
  }
  // Live updates while the popup is open (new media found, worker restarted).
  ext.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes.tabs && openFormats === null) void load();
    if (area === 'session' && changes.appStatus) renderStatus(changes.appStatus.newValue);
  });
}

void init();
