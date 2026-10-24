/*
 * SwiftDownload page scanner (content script, every frame of http/https pages).
 *
 * - Finds downloadable resources in the page: <video>/<audio>/<source>, <img>/srcset, links to
 *   files, Open Graph / Twitter media tags and JSON-LD VideoObject/AudioObject. New elements
 *   (single-page apps, lazy players) are picked up through a debounced MutationObserver.
 *   Only resource addresses and titles are sent to the extension's background script.
 * - Shows a small download button over video/audio players that have a usable source (a
 *   direct file, or an HLS/DASH stream the page loaded), and optionally over large images.
 *   The UI lives in a closed shadow root in its own fixed layer, so it cannot affect the page
 *   layout or styles, and it sits in the top-right corner, away from player controls.
 */
(() => {
  if (globalThis.__swiftDownloadDetector) return;
  globalThis.__swiftDownloadDetector = true;
  if (!/^https?:$/.test(location.protocol)) return;
  const ext = globalThis.browser ?? globalThis.chrome;
  const C = globalThis.SwiftClassify;
  const A = globalThis.SwiftAdapters;
  if (!C || !A || !ext || !ext.runtime) return;

  const isTop = window === window.top;
  const topHost = (() => {
    if (isTop) return location.hostname;
    const ao = location.ancestorOrigins;
    if (ao && ao.length) {
      try {
        return new URL(ao[ao.length - 1]).hostname;
      } catch (e) {
        // fall through
      }
    }
    return location.hostname;
  })();
  const adapter = A.forUrl(isTop ? location.href : `https://${topHost}/`);

  let s = { ...C.DEFAULTS };
  let active = false;
  let alive = true;

  function send(msg) {
    if (!alive) return Promise.resolve(null);
    try {
      return Promise.resolve(ext.runtime.sendMessage(msg)).catch((e) => {
        if (/context invalidated|Receiving end does not exist/i.test(String(e && e.message))) stop();
        return null;
      });
    } catch (e) {
      stop(); // the extension was reloaded or removed
      return Promise.resolve(null);
    }
  }

  function computeActive() {
    return !!s.detect && !C.isExcluded(topHost, s.excludedSites) && !C.isExcluded(location.hostname, s.excludedSites);
  }

  // ----------------------------------------------------------------------------- scanning

  const reported = new Set();
  let scanTimer = null;
  let lastScan = 0;
  let players = [];

  function scheduleScan(delay = 800) {
    if (!active || scanTimer) return;
    const wait = Math.max(delay, 1500 - (Date.now() - lastScan));
    scanTimer = setTimeout(() => {
      scanTimer = null;
      try {
        scan();
      } catch (e) {
        // never break the page
      }
    }, wait);
  }

  function abs(u) {
    try {
      return new URL(u, document.baseURI).href;
    } catch (e) {
      return null;
    }
  }

  /** Highest-resolution candidate of a srcset. */
  function largestSrcset(srcset) {
    let best = null;
    let bestScore = 0;
    for (const part of String(srcset || '').split(/,\s+/)) {
      const [url, desc = '1x'] = part.trim().split(/\s+/);
      const n = parseFloat(desc) || 1;
      const score = desc.endsWith('w') ? n : n * 1000;
      if (url && score > bestScore) {
        best = url;
        bestScore = score;
      }
    }
    return best;
  }

  function pageTitle() {
    const info = adapter.pageInfo ? adapter.pageInfo(document) : null;
    const og = document.querySelector('meta[property="og:title"]');
    return ((info && info.title) || (og && og.content) || document.title || '').trim().slice(0, 300);
  }

  function mediaTitle(el) {
    return (el.getAttribute('title') || el.getAttribute('aria-label') || pageTitle() || '').trim().slice(0, 300) || null;
  }

  function scan() {
    if (!active || !document.documentElement) return;
    lastScan = Date.now();
    const out = [];
    const push = (url, info = {}) => {
      if (out.length >= 150 || !url) return;
      const u = abs(url);
      if (!u || !C.isHttp(u)) return;
      const key = C.normalizeUrl(u);
      if (reported.has(key)) return;
      const r = C.classifyElementSource(u, info.mime, info.category);
      if (!r || r.segment) return;
      if (!C.wants(s, r.category, r.method)) return;
      reported.add(key);
      out.push({ url: u, mime: info.mime || null, category: r.category, title: info.title || null, fileName: info.fileName || null, resolution: info.resolution || null, duration: info.duration || null });
    };

    players = Array.from(document.querySelectorAll('video, audio')).slice(0, 50);
    for (const el of players) {
      const cat = el.tagName === 'VIDEO' ? 'video' : 'audio';
      const info = {
        category: cat,
        title: mediaTitle(el),
        resolution: cat === 'video' && el.videoWidth ? `${el.videoWidth}x${el.videoHeight}` : null,
        duration: Number.isFinite(el.duration) && el.duration > 0 ? Math.round(el.duration) : null
      };
      for (const src of [el.currentSrc, el.getAttribute('src')]) if (src) push(src, info);
      for (const so of el.querySelectorAll('source[src]')) push(so.getAttribute('src'), { ...info, mime: so.getAttribute('type') || null });
    }

    let links = 0;
    for (const a of document.querySelectorAll('a[href]')) {
      if (++links > 3000) break;
      const href = a.getAttribute('href') || '';
      if (!href || href.startsWith('#') || /^(javascript|mailto|tel|data|blob):/i.test(href)) continue;
      const text = (a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 200);
      push(href, { fileName: a.getAttribute('download') || null, title: text || null });
    }

    if (C.wants(s, 'image')) {
      let n = 0;
      for (const img of document.images) {
        if (++n > 400) break;
        if (img.naturalWidth < 100 || img.naturalHeight < 100) continue;
        push(largestSrcset(img.srcset) || img.currentSrc || img.src, { category: 'image', title: (img.alt || '').trim().slice(0, 200) || null, resolution: `${img.naturalWidth}x${img.naturalHeight}` });
      }
      for (const so of document.querySelectorAll('picture source[srcset]')) push(largestSrcset(so.getAttribute('srcset')), { category: 'image', mime: so.getAttribute('type') || null });
    }

    for (const m of document.querySelectorAll('meta[property^="og:video"], meta[property^="og:audio"], meta[name="twitter:player:stream"], meta[property="og:image"], meta[property="og:image:url"], meta[itemprop="contentUrl"]')) {
      const p = (m.getAttribute('property') || m.getAttribute('name') || m.getAttribute('itemprop') || '').toLowerCase();
      if (/:(type|width|height|alt)$/.test(p)) continue;
      const typeMeta = document.querySelector(`meta[property="${p.replace(/:(url|secure_url)$/, '')}:type"]`);
      // No element category here: og:video often points to an embed page, not a file.
      push(m.getAttribute('content'), { mime: typeMeta ? typeMeta.getAttribute('content') : null, title: pageTitle() });
    }

    const walk = (node, depth) => {
      if (!node || typeof node !== 'object' || depth > 6) return;
      if (Array.isArray(node)) return node.slice(0, 50).forEach((n) => walk(n, depth + 1));
      const type = [].concat(node['@type'] || []).join(' ');
      if (typeof node.contentUrl === 'string' && /Video|Audio|Media/i.test(type)) push(node.contentUrl, { title: typeof node.name === 'string' ? node.name : null, category: /Audio/i.test(type) ? 'audio' : 'video', mime: typeof node.encodingFormat === 'string' ? node.encodingFormat : null });
      for (const k of Object.keys(node).slice(0, 50)) if (typeof node[k] === 'object') walk(node[k], depth + 1);
    };
    for (const sc of Array.from(document.querySelectorAll('script[type="application/ld+json"]')).slice(0, 10)) {
      const text = sc.textContent || '';
      if (text.length > 200_000) continue;
      try {
        walk(JSON.parse(text), 0);
      } catch (e) {
        // invalid JSON-LD
      }
    }

    if (out.length) {
      void send({ type: 'page-media', items: out, pageTitle: isTop ? pageTitle() : undefined }).then((r) => {
        if (!r || !r.ok) for (const i of out) reported.delete(C.normalizeUrl(i.url));
      });
    }
  }

  const observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'attributes' || r.addedNodes.length) {
        scheduleScan();
        return;
      }
    }
  });

  function onMediaEvent() {
    scheduleScan(300);
  }

  // ------------------------------------------------------------------------ floating button

  let uiHost = null;
  let shadow = null;
  let btn = null;
  let imgBtn = null;
  let menu = null;
  let current = null;
  let currentImg = null;
  let hideTimer = null;
  let menuOpen = false;
  const sourceCache = new WeakMap();

  const ICON =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11"/><path d="m6.5 10 5.5 5.5 5.5-5.5"/><path d="M5 20h14"/></svg>';
  const CSS = `
    :host { all: initial; }
    .btn { position: fixed; display: none; align-items: center; justify-content: center; box-sizing: border-box;
      width: 34px; height: 34px; padding: 0; border-radius: 9px; border: 1px solid rgba(255,255,255,.28);
      background: rgba(17,24,39,.78); color: #fff; cursor: pointer; pointer-events: auto;
      box-shadow: 0 2px 10px rgba(0,0,0,.35); transition: background .12s, transform .12s; }
    .btn:hover, .btn:focus-visible { background: #2563eb; outline: none; transform: scale(1.06); }
    .btn.ok { background: #16a34a; }
    .btn.small { width: 28px; height: 28px; border-radius: 7px; }
    .menu { position: fixed; display: none; pointer-events: auto; box-sizing: border-box; min-width: 250px; max-width: 360px;
      max-height: 340px; overflow: auto; padding: 4px; border-radius: 10px; background: #fff; color: #111827;
      border: 1px solid rgba(0,0,0,.12); box-shadow: 0 10px 30px rgba(0,0,0,.28);
      font: 13px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif; }
    .menu .head { padding: 7px 10px 5px; font-weight: 600; font-size: 12px; color: #374151; }
    .menu button { display: block; width: 100%; box-sizing: border-box; text-align: left; padding: 7px 10px; border: 0;
      border-radius: 7px; background: none; color: inherit; font: inherit; cursor: pointer; }
    .menu button:hover, .menu button:focus-visible { background: #eff6ff; outline: none; }
    .menu .sub { display: block; color: #6b7280; font-size: 11.5px; }
    .menu .note { padding: 8px 10px; color: #4b5563; font-size: 12px; }
    .menu .err { color: #b91c1c; }
    @media (prefers-color-scheme: dark) {
      .menu { background: #1f2937; color: #f3f4f6; border-color: rgba(255,255,255,.12); }
      .menu .head { color: #d1d5db; } .menu .sub, .menu .note { color: #9ca3af; }
      .menu button:hover, .menu button:focus-visible { background: #374151; } .menu .err { color: #fca5a5; }
    }`;

  function ensureUi() {
    if (uiHost) return;
    uiHost = document.createElement('swiftdownload-ui');
    uiHost.style.cssText = 'all:initial;position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
    shadow = uiHost.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `<style>${CSS}</style><button class="btn" type="button" title="Download with SwiftDownload" aria-label="Download with SwiftDownload">${ICON}</button><button class="btn small img" type="button" title="Download image with SwiftDownload" aria-label="Download image with SwiftDownload">${ICON}</button><div class="menu" role="menu"></div>`;
    [btn, imgBtn] = shadow.querySelectorAll('.btn');
    menu = shadow.querySelector('.menu');
    btn.addEventListener('click', onPlayerButton);
    imgBtn.addEventListener('click', onImageButton);
    for (const b of [btn, imgBtn]) {
      b.addEventListener('mouseenter', () => clearTimeout(hideTimer));
      b.addEventListener('mouseleave', () => scheduleHide());
    }
    menu.addEventListener('mouseenter', () => clearTimeout(hideTimer));
    attachUi();
  }

  function attachUi() {
    if (!uiHost) return;
    const fs = document.fullscreenElement;
    const parent = fs && !/^(VIDEO|AUDIO|IMG|CANVAS)$/.test(fs.tagName) ? fs : document.documentElement;
    if (uiHost.parentNode !== parent) parent.appendChild(uiHost);
  }

  function visibleRect(el) {
    if (!el.isConnected) return null;
    const r = el.getBoundingClientRect();
    const minH = el.tagName === 'AUDIO' ? 24 : 90;
    if (r.width < 160 || r.height < minH || r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return null;
    return r;
  }

  function playerAt(x, y) {
    for (const el of players) {
      const r = visibleRect(el);
      if (r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return el;
    }
    return null;
  }

  /** Download options for a player: its direct file, or the streams this tab loaded. */
  async function sourcesFor(el, fresh) {
    const cached = sourceCache.get(el);
    if (cached && !fresh && Date.now() - cached.at < 4000) return cached.options;
    const options = [];
    const src = el.currentSrc || el.getAttribute('src') || '';
    if (C.isHttp(src)) {
      const r = C.classifyElementSource(abs(src), null, el.tagName === 'AUDIO' ? 'audio' : 'video');
      if (r && !r.segment && r.method === 'direct') options.push({ kind: 'direct', url: r.url, label: `${(r.format || 'media').toUpperCase()} file`, sub: r.fileName || '' });
      if (r && r.method !== 'direct') options.push({ kind: 'stream-url', url: r.url, label: `${r.method.toUpperCase()} stream`, sub: '' });
    }
    if (!options.length) {
      const resp = await send({ type: 'player-sources' });
      for (const st of (resp && resp.streams) || []) options.push({ kind: 'stream', item: st, label: `${st.method === 'hls' ? 'HLS' : 'DASH'} stream`, sub: st.title || C.fileNameFromUrl(st.url) || '' });
    }
    sourceCache.set(el, { at: Date.now(), options });
    return options;
  }

  function place(button, rect, inset) {
    button.style.left = `${Math.round(Math.min(innerWidth - 40, Math.max(4, rect.right - button.offsetWidth - inset)))}px`;
    button.style.top = `${Math.round(Math.max(4, rect.top + inset))}px`;
  }

  async function showFor(el) {
    if (el === current && btn && btn.style.display === 'flex') return;
    const options = await sourcesFor(el, false);
    if (!options.length || !active) return;
    ensureUi();
    attachUi();
    current = el;
    btn.style.display = 'flex';
    btn.classList.remove('ok');
    reposition();
  }

  function reposition() {
    if (current && btn && btn.style.display === 'flex') {
      const r = visibleRect(current);
      if (!r) return hideNow();
      place(btn, r, 10);
    }
    if (currentImg && imgBtn && imgBtn.style.display === 'flex') {
      const r = currentImg.getBoundingClientRect();
      imgBtn.style.left = `${Math.round(Math.max(4, r.left + 8))}px`;
      imgBtn.style.top = `${Math.round(Math.max(4, r.top + 8))}px`;
    }
  }

  function scheduleHide() {
    if (menuOpen) return;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hideNow, 900);
  }

  function hideNow() {
    if (menuOpen) return;
    if (btn) btn.style.display = 'none';
    if (imgBtn) imgBtn.style.display = 'none';
    current = null;
    currentImg = null;
  }

  function closeMenu() {
    menuOpen = false;
    if (menu) {
      menu.style.display = 'none';
      menu.textContent = '';
    }
    scheduleHide();
  }

  function openMenu(anchor) {
    menuOpen = true;
    menu.textContent = '';
    menu.style.display = 'block';
    const r = anchor.getBoundingClientRect();
    menu.style.top = `${Math.round(Math.min(r.bottom + 6, innerHeight - 120))}px`;
    menu.style.left = `${Math.round(Math.max(4, Math.min(r.right - 260, innerWidth - 270)))}px`;
  }

  function menuHead(text) {
    const d = document.createElement('div');
    d.className = 'head';
    d.textContent = text;
    menu.appendChild(d);
  }

  function menuNote(text, error, retry) {
    const d = document.createElement('div');
    d.className = error ? 'note err' : 'note';
    d.textContent = text;
    menu.appendChild(d);
    if (retry) menuItem('Try again', '', retry);
  }

  function menuItem(label, sub, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.textContent = label;
    if (sub) {
      const s2 = document.createElement('span');
      s2.className = 'sub';
      s2.textContent = sub;
      b.appendChild(s2);
    }
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick();
    });
    menu.appendChild(b);
  }

  function done(resp) {
    if (resp && resp.ok) {
      closeMenu();
      if (btn) {
        btn.classList.add('ok');
        setTimeout(() => btn && btn.classList.remove('ok'), 2000);
      }
      return;
    }
    if (!menuOpen) openMenu(btn);
    menu.textContent = '';
    menuNote((resp && resp.error) || 'SwiftDownload could not be reached.', true);
  }

  function rate(bps) {
    return bps >= 1e6 ? `${(bps / 1e6).toFixed(1)} Mbps` : `${Math.round(bps / 1e3)} kbps`;
  }

  async function showFormats(item) {
    menu.textContent = '';
    menuNote('Reading available formats…');
    const resp = await send({ type: 'inspect', id: item.id });
    if (!menuOpen) return;
    menu.textContent = '';
    if (!resp || !resp.ok) return menuNote((resp && resp.error) || 'The stream could not be read.', true, () => void showFormats(item));
    const m = resp.media;
    if (!m || !m.supported) return menuNote((m && m.reason) || 'This stream cannot be downloaded.', true);
    const title = item.title || pageTitle() || 'Stream';
    menuHead(`${title.slice(0, 60)}${m.durationSec ? ` · ${Math.floor(m.durationSec / 60)}:${String(Math.round(m.durationSec % 60)).padStart(2, '0')}` : ''}`);
    let estimates = false;
    for (const v of m.variants.filter((x) => x.kind !== 'audio')) {
      const sub = [v.bandwidth ? rate(v.bandwidth) : '', v.estimatedBytes ? `≈ ${C.humanSize(v.estimatedBytes)}` : '', v.kind === 'video' ? 'video + separate audio' : ''].filter(Boolean).join(' · ');
      estimates = estimates || !!v.estimatedBytes;
      menuItem(v.resolution ? `${v.resolution.split('x')[1]}p (${v.resolution})` : 'Video', sub, () => void send({ type: 'download', id: item.id, selection: { video: v.id } }).then(done));
    }
    const audios = m.audioTracks.length ? m.audioTracks : m.variants.filter((x) => x.kind === 'audio');
    for (const a of audios) {
      menuItem(`Audio only${a.label || a.language ? ` · ${a.label || a.language}` : ''}`, a.bandwidth ? rate(a.bandwidth) : '', () => void send({ type: 'download', id: item.id, selection: { video: 'none', audio: a.id } }).then(done));
    }
    if (!m.variants.length && !audios.length) menuItem('Download stream', '', () => void send({ type: 'download', id: item.id, selection: {} }).then(done));
    if (estimates) menuNote('Sizes marked ≈ are estimates from the stream bitrate.');
  }

  async function onPlayerButton(e) {
    e.preventDefault();
    e.stopPropagation();
    const el = current;
    if (!el) return;
    if (menuOpen) return closeMenu();
    const options = await sourcesFor(el, true);
    openMenu(btn);
    if (!options.length) return menuNote('No downloadable source was found for this player. It may be protected (DRM) or not supported.', true);
    if (options.length === 1 && options[0].kind === 'direct') {
      closeMenu();
      return done(await send({ type: 'download-url', url: options[0].url, title: mediaTitle(el) }));
    }
    if (options.length === 1 && options[0].kind === 'stream') return showFormats(options[0].item);
    menuHead('Choose what to download');
    for (const o of options) {
      if (o.kind === 'stream') menuItem(o.label, o.sub, () => void showFormats(o.item));
      else if (o.kind === 'direct') menuItem(o.label, o.sub, () => void send({ type: 'download-url', url: o.url, title: mediaTitle(el) }).then(done));
      else menuItem(o.label, 'Open the toolbar popup to choose a format', () => void send({ type: 'download-url', url: o.url }).then(done));
    }
  }

  function onImageButton(e) {
    e.preventDefault();
    e.stopPropagation();
    const img = currentImg;
    if (!img) return;
    const url = abs(largestSrcset(img.srcset) || img.currentSrc || img.src);
    void send({ type: 'download-url', url, title: img.alt || null }).then((r) => {
      if (r && r.ok) {
        imgBtn.classList.add('ok');
        setTimeout(() => imgBtn && imgBtn.classList.remove('ok'), 2000);
      }
    });
  }

  let lastMove = 0;
  function onMouseMove(e) {
    if (!active || menuOpen) return;
    const now = performance.now();
    if (now - lastMove < 100) return;
    lastMove = now;
    if (!s.floatingButton || adapter.floatingButton === false || !players.length) return;
    const el = playerAt(e.clientX, e.clientY);
    if (el) {
      clearTimeout(hideTimer);
      void showFor(el);
    } else if (current) scheduleHide();
  }

  function onMouseOver(e) {
    if (!active || !s.imageIndicator || menuOpen) return;
    const t = e.target;
    if (!(t instanceof HTMLImageElement) || t.naturalWidth < 150 || t.naturalHeight < 150) return;
    const r = t.getBoundingClientRect();
    if (r.width < 120 || r.height < 120) return;
    const url = abs(largestSrcset(t.srcset) || t.currentSrc || t.src);
    if (!url || !C.isHttp(url)) return;
    ensureUi();
    attachUi();
    clearTimeout(hideTimer);
    currentImg = t;
    imgBtn.style.display = 'flex';
    reposition();
  }

  function onMouseOut(e) {
    if (currentImg && e.target === currentImg) scheduleHide();
  }

  function onPointerDown(e) {
    if (menuOpen && uiHost && !e.composedPath().includes(uiHost)) closeMenu();
  }

  function onKey(e) {
    if (menuOpen && e.key === 'Escape') closeMenu();
  }

  let rafPending = false;
  function onViewportChange() {
    if (rafPending || (!current && !currentImg)) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      reposition();
    });
  }

  // ---------------------------------------------------------------------------- lifecycle

  const listeners = [
    [document, 'mousemove', onMouseMove, { passive: true, capture: true }],
    [document, 'mouseover', onMouseOver, { passive: true, capture: true }],
    [document, 'mouseout', onMouseOut, { passive: true, capture: true }],
    [document, 'pointerdown', onPointerDown, { capture: true }],
    [document, 'keydown', onKey, { capture: true }],
    [document, 'loadedmetadata', onMediaEvent, { capture: true }],
    [document, 'play', onMediaEvent, { capture: true }],
    [document, 'fullscreenchange', attachUi, false],
    [window, 'scroll', onViewportChange, { passive: true, capture: true }],
    [window, 'resize', onViewportChange, { passive: true }]
  ];

  function start() {
    if (active || !alive) return;
    active = true;
    for (const [t, ev, fn, opt] of listeners) t.addEventListener(ev, fn, opt);
    if (document.documentElement) observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'href', 'srcset'] });
    scheduleScan(document.readyState === 'complete' ? 200 : 1200);
  }

  function pause() {
    if (!active) return;
    active = false;
    observer.disconnect();
    for (const [t, ev, fn, opt] of listeners) t.removeEventListener(ev, fn, opt);
    clearTimeout(scanTimer);
    scanTimer = null;
    menuOpen = false;
    hideNow();
  }

  function stop() {
    alive = false;
    pause();
    if (uiHost) uiHost.remove();
  }

  function apply() {
    if (computeActive()) start();
    else pause();
  }

  ext.storage.local.get(C.DEFAULTS).then(
    (v) => {
      s = { ...C.DEFAULTS, ...v };
      apply();
    },
    () => undefined
  );
  ext.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const [k, v] of Object.entries(changes)) s[k] = v.newValue === undefined ? C.DEFAULTS[k] : v.newValue;
    if (changes.detectTypes) reported.clear();
    apply();
    if (active) scheduleScan(200);
  });
})();
