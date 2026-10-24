/*
 * SwiftDownload: opens clicked magnet: links in SwiftDownload instead of the system's
 * torrent handler. Only reads the clicked link; nothing on the page is changed or sent.
 * If SwiftDownload cannot be reached, the link opens the usual way.
 */
(() => {
  const ext = globalThis.browser ?? globalThis.chrome;
  const settings = { intercept: true, magnets: true };
  ext.storage.local.get(settings).then((s) => Object.assign(settings, s), () => undefined);
  ext.storage.onChanged.addListener((changes) => {
    for (const k of Object.keys(settings)) if (changes[k]) settings[k] = changes[k].newValue;
  });

  /** Links we let through after SwiftDownload was unreachable. */
  let fallback = null;

  function magnetLink(event) {
    for (const el of event.composedPath ? event.composedPath() : []) {
      if (el instanceof HTMLAnchorElement || el instanceof SVGAElement) {
        const href = el instanceof SVGAElement ? el.href.baseVal : el.href;
        return /^magnet:\?/i.test(href || '') ? href : null;
      }
    }
    return null;
  }

  function onClick(event) {
    if (!settings.intercept || !settings.magnets || event.defaultPrevented) return;
    if (event.type === 'click' && event.button !== 0) return;
    if (event.type === 'auxclick' && event.button !== 1) return;
    const url = magnetLink(event);
    if (!url || url === fallback) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    ext.runtime.sendMessage({ type: 'magnet', url }).then(
      (resp) => {
        if (resp && resp.ok) return;
        fallback = url;
        window.location.href = url;
      },
      () => {
        fallback = url;
        window.location.href = url;
      }
    );
  }

  // Capture phase, so page scripts that open the link themselves don't run first.
  window.addEventListener('click', onClick, true);
  window.addEventListener('auxclick', onClick, true);
})();
