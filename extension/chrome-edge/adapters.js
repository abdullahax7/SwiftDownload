/*
 * SwiftDownload: website adapters. The generic detector (network responses + page scanning)
 * works on any site; an adapter only adds site-specific knowledge: which network requests are
 * pieces of a player's stream rather than files, page metadata, and what cannot be downloaded.
 * Adapters never change the global classification rules.
 *
 * Each adapter declares: id, name, match(hostname), detection (methods used), capabilities,
 * limitations (shown to the user), permissions (beyond the extension's own) and optionally
 * filterNetwork(url) → false to ignore a request, floatingButton: false, pageInfo(document).
 */
(function (root) {
  const generic = {
    id: 'generic',
    name: 'Any website',
    match: () => true,
    detection: ['network responses (MIME type, Content-Disposition, size)', 'page elements (video, audio, source, img, links, Open Graph and JSON-LD metadata)', 'browser downloads'],
    capabilities: { direct: true, hls: true, dash: true, images: true, documents: true },
    limitations:
      'Only media the page loads from a direct file link or an unencrypted HLS/DASH stream can be downloaded. DRM-protected (Widevine, PlayReady, FairPlay) and live streams are not supported.',
    permissions: [],
    floatingButton: true
  };

  const youtube = {
    id: 'youtube',
    name: 'YouTube',
    match: (host) => /(^|\.)youtube\.com$|(^|\.)youtube-nocookie\.com$|^youtu\.be$/.test(host),
    detection: ['page metadata (title)'],
    capabilities: { direct: false, hls: false, dash: false, images: true, documents: true },
    limitations:
      "YouTube's Terms of Service do not allow downloading videos other than through YouTube's own features (such as YouTube Premium offline downloads), and its video streams are delivered in protected pieces. SwiftDownload does not download YouTube videos.",
    permissions: [],
    floatingButton: false,
    // The player fetches the video in byte-range pieces from googlevideo.com; none is a file.
    filterNetwork: (url) => !/^https:\/\/[^/]*\.googlevideo\.com\/videoplayback/i.test(url),
    pageInfo(doc) {
      const og = doc.querySelector('meta[property="og:title"]');
      const title = (og && og.content) || doc.title.replace(/\s*-\s*YouTube\s*$/, '');
      return { title: title || null, unsupported: true };
    }
  };

  const adapters = [youtube];

  function hostOf(url) {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch (e) {
      return '';
    }
  }

  function forUrl(url) {
    const host = hostOf(url);
    return adapters.find((a) => a.match(host)) || generic;
  }

  /** Should a network request seen on `pageUrl` be considered at all? */
  function allowNetwork(pageUrl, requestUrl) {
    const a = forUrl(pageUrl);
    if (a.filterNetwork && !a.filterNetwork(requestUrl)) return false;
    // googlevideo pieces can also appear on pages embedding a YouTube player.
    return youtube.filterNetwork(requestUrl);
  }

  /** Plain description for the popup (no functions). */
  function describe(url) {
    const a = forUrl(url);
    return { id: a.id, name: a.name, limitations: a.limitations, capabilities: a.capabilities, detection: a.detection, unsupported: a.capabilities.direct === false };
  }

  root.SwiftAdapters = { generic, all: [generic, ...adapters], forUrl, allowNetwork, describe, hostOf };
})(globalThis);
