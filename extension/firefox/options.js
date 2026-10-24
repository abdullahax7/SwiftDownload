const ext = globalThis.browser ?? globalThis.chrome;
const C = globalThis.SwiftClassify;
const DEFAULTS = C.DEFAULTS;
const $ = (id) => document.getElementById(id);
const COOKIES = { permissions: ['cookies'] };
const ALL_SITES = { origins: ['<all_urls>'] };
const TOGGLES = ['intercept', 'magnets', 'detect', 'floatingButton', 'imageIndicator', 'reportToApp'];

function typeBoxes() {
  return Array.from(document.querySelectorAll('input[data-type]'));
}

ext.storage.local.get(DEFAULTS).then((s) => {
  for (const k of TOGGLES) $(k).checked = s[k];
  $('extensions').value = s.extensions;
  $('minSizeMB').value = s.minSizeMB;
  $('sendCookies').checked = s.sendCookies;
  $('captureAll').checked = s.captureAll;
  $('extensions').disabled = s.captureAll;
  $('excludedSites').value = s.excludedSites;
  for (const b of typeBoxes()) b.checked = s.detectTypes.includes(b.dataset.type);
});

// Switches apply immediately; text fields with Save.
for (const k of TOGGLES) $(k).addEventListener('change', () => ext.storage.local.set({ [k]: $(k).checked }));

for (const b of typeBoxes()) {
  b.addEventListener('change', () => ext.storage.local.set({ detectTypes: typeBoxes().filter((x) => x.checked).map((x) => x.dataset.type) }));
}

$('captureAll').addEventListener('change', async () => {
  $('extensions').disabled = $('captureAll').checked;
  await ext.storage.local.set({ captureAll: $('captureAll').checked });
});

$('sendCookies').addEventListener('change', async () => {
  if ($('sendCookies').checked) {
    // Must be requested from a user gesture.
    const granted = await ext.permissions.request({ ...COOKIES, ...ALL_SITES }).catch(() => false);
    if (!granted) $('sendCookies').checked = false;
  } else {
    await ext.permissions.remove(COOKIES).catch(() => undefined);
  }
  await ext.storage.local.set({ sendCookies: $('sendCookies').checked });
});

$('save').addEventListener('click', async () => {
  const extensions = $('extensions')
    .value.toLowerCase()
    .split(/[\s,;]+/)
    .map((x) => x.replace(/^\./, ''))
    .filter((x) => /^[a-z0-9]{1,10}$/.test(x))
    .join(' ');
  const minSizeMB = Math.max(0, Math.floor(Number($('minSizeMB').value) || 0));
  const excludedSites = C.parseSites($('excludedSites').value).join('\n');
  await ext.storage.local.set({ extensions, minSizeMB, excludedSites });
  $('extensions').value = extensions;
  $('excludedSites').value = excludedSites;
  $('saved').textContent = 'Saved';
  setTimeout(() => ($('saved').textContent = ''), 2500);
});

$('reset').addEventListener('click', () => {
  $('extensions').value = DEFAULTS.extensions;
});

$('test').addEventListener('click', async () => {
  $('result').textContent = 'Testing…';
  $('result').className = 'muted';
  const r = await ext.runtime.sendMessage({ type: 'reconnect' });
  const ok = r && r.state === 'connected';
  $('result').textContent = ok ? `Connected to SwiftDownload ${r.version || ''}` : (r && r.message) || 'Not connected';
  $('result').className = ok ? 'ok' : 'error';
});

async function checkAccess() {
  const granted = await ext.permissions.contains(ALL_SITES).catch(() => true);
  $('access').hidden = granted;
}
$('grant').addEventListener('click', async () => {
  if (await ext.permissions.request(ALL_SITES).catch(() => false)) ext.runtime.reload();
});
void checkAccess();
