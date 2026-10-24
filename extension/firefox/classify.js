/*
 * SwiftDownload: resource classification shared by the background script, the content script
 * and the popup. Decides from the URL, MIME type and Content-Disposition what a resource is
 * (video, audio, image, document, archive, other), how it would be downloaded (direct file,
 * HLS or DASH stream) and whether it is only a piece of a stream that must not be offered on
 * its own. Pure functions only; no browser APIs.
 */
(function (root) {
  const EXT = {
    video: ['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v', 'mpeg', 'mpg', 'mpe', '3gp', '3g2', 'ogv', 'flv', 'f4v', 'ts', 'm2ts', 'mts', 'wmv', 'asf', 'qt', 'rm', 'rmvb', 'vob', 'divx'],
    audio: ['mp3', 'm4a', 'm4b', 'aac', 'wav', 'flac', 'ogg', 'oga', 'opus', 'wma', 'aif', 'aiff', 'aifc', 'weba', 'mka', 'ape', 'amr', 'mid', 'midi', 'ra'],
    image: ['jpg', 'jpeg', 'jpe', 'jfif', 'png', 'webp', 'gif', 'avif', 'svg', 'bmp', 'tif', 'tiff', 'ico', 'heic', 'heif'],
    document: ['pdf', 'txt', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'rtf', 'odt', 'ods', 'odp', 'epub', 'mobi', 'azw3', 'djvu', 'xps'],
    archive: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'tbz2', 'xz', 'txz', 'zst', 'iso', 'img', 'cab', 'lz', 'lzma', 'arj', 'ace', 'lzh', 'dmg', 'r00', 'r01'],
    other: ['exe', 'msi', 'msix', 'msixbundle', 'appx', 'msu', 'apk', 'aab', 'xapk', 'deb', 'rpm', 'appimage', 'pkg', 'jar', 'ttf', 'otf', 'woff', 'woff2', 'torrent', 'bin', 'sea', 'sit', 'sitx']
  };
  const CATEGORIES = ['video', 'audio', 'image', 'document', 'archive', 'other'];
  const EXT_CATEGORY = {};
  for (const c of CATEGORIES) for (const e of EXT[c]) EXT_CATEGORY[e] = c;

  const HLS_MIME = ['application/vnd.apple.mpegurl', 'application/x-mpegurl', 'audio/mpegurl', 'audio/x-mpegurl', 'video/mpegurl', 'video/x-mpegurl'];
  const DASH_MIME = ['application/dash+xml', 'video/vnd.mpeg.dash.mpd'];
  const MIME_EXT = {
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/x-matroska': 'mkv',
    'video/quicktime': 'mov',
    'video/x-msvideo': 'avi',
    'video/x-flv': 'flv',
    'video/3gpp': '3gp',
    'video/ogg': 'ogv',
    'video/mpeg': 'mpg',
    'video/x-ms-wmv': 'wmv',
    'video/mp2t': 'ts',
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/mp4': 'm4a',
    'audio/x-m4a': 'm4a',
    'audio/aac': 'aac',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/wave': 'wav',
    'audio/flac': 'flac',
    'audio/x-flac': 'flac',
    'audio/ogg': 'ogg',
    'audio/opus': 'opus',
    'audio/webm': 'weba',
    'audio/x-ms-wma': 'wma',
    'audio/aiff': 'aiff',
    'audio/x-aiff': 'aiff',
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/avif': 'avif',
    'image/svg+xml': 'svg',
    'image/bmp': 'bmp',
    'image/tiff': 'tiff',
    'image/x-icon': 'ico',
    'image/vnd.microsoft.icon': 'ico',
    'application/pdf': 'pdf',
    'text/plain': 'txt',
    'text/csv': 'csv',
    'application/rtf': 'rtf',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.ms-powerpoint': 'ppt',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'application/epub+zip': 'epub',
    'application/zip': 'zip',
    'application/x-zip-compressed': 'zip',
    'application/vnd.rar': 'rar',
    'application/x-rar-compressed': 'rar',
    'application/x-7z-compressed': '7z',
    'application/x-tar': 'tar',
    'application/gzip': 'gz',
    'application/x-gzip': 'gz',
    'application/x-bzip2': 'bz2',
    'application/x-xz': 'xz',
    'application/zstd': 'zst',
    'application/x-iso9660-image': 'iso',
    'application/x-msdownload': 'exe',
    'application/vnd.microsoft.portable-executable': 'exe',
    'application/x-msi': 'msi',
    'application/x-ms-installer': 'msi',
    'application/vnd.android.package-archive': 'apk',
    'application/x-debian-package': 'deb',
    'application/x-rpm': 'rpm',
    'application/x-bittorrent': 'torrent',
    'font/ttf': 'ttf',
    'font/otf': 'otf',
    'font/woff': 'woff',
    'font/woff2': 'woff2'
  };
  const SEGMENT_EXT = ['m4s', 'm4f', 'cmfv', 'cmfa', 'cmft', 'mp4a', 'm4i'];
  // "seg-12.mp4", "chunk_3", "frag/4", "segment12", "/range/0-1000".
  const SEGMENT_RE = /(?:^|[/_.-])(?:seg|segment|chunk|frag|fragment)[-_/]?\d+(?:[._/-]|$)|\/range\/\d+-\d+|[?&](?:range|bytestart|byterange)=/i;

  const DEFAULT_EXTENSIONS =
    '3gp 7z aac ace aif apk arj asf avi bin bz2 cab dmg doc docx exe flac flv gz gzip img iso jar lzh m4a m4v mkv mov mp3 mp4 mpeg mpg msi msix msu ogg ogv pdf pkg ppt pptx qt r00 r01 ra rar rm rmvb rpm sea sit sitx tar tgz tif tiff torrent wav webm wma wmv xls xlsx xz z zip zst deb appimage epub';

  /** Extension settings (chrome.storage.local) and their defaults. */
  const DEFAULTS = {
    // Download interception (existing behaviour): captureAll = every browser download.
    intercept: true,
    captureAll: true,
    extensions: DEFAULT_EXTENSIONS,
    minSizeMB: 0,
    sendCookies: false,
    magnets: true,
    // Media detection.
    detect: true,
    detectTypes: ['video', 'audio', 'document', 'archive'],
    excludedSites: '',
    floatingButton: true,
    imageIndicator: false,
    reportToApp: true
  };

  /** Direct media smaller than this found in network traffic is UI sound/preview noise. */
  const MIN_NETWORK_MEDIA_BYTES = 100 * 1024;

  function baseMime(mime) {
    return String(mime || '')
      .split(';')[0]
      .trim()
      .toLowerCase();
  }

  function pathOf(url) {
    try {
      return new URL(url).pathname;
    } catch (e) {
      return '';
    }
  }

  function extOf(nameOrPath) {
    const last = String(nameOrPath || '')
      .split(/[?#]/)[0]
      .split('/')
      .pop();
    const m = /\.([a-z0-9]{1,12})$/i.exec(last || '');
    return m ? m[1].toLowerCase() : '';
  }

  function decodeSafe(s) {
    try {
      return decodeURIComponent(s);
    } catch (e) {
      return s;
    }
  }

  /** File name from a Content-Disposition header (RFC 6266 / 5987), or null. */
  function parseDisposition(header) {
    if (!header) return null;
    const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
    if (star) {
      const value = star[2].trim().replace(/^"|"$/g, '');
      const charset = star[1].trim().toLowerCase();
      if (charset === 'utf-8' || charset === '') return sanitizeName(decodeSafe(value));
      if (charset === 'iso-8859-1') return sanitizeName(unescape(value));
    }
    const quoted = /filename\s*=\s*"((?:\\.|[^"\\])*)"/i.exec(header);
    // Only \" is unescaped: browsers treat other backslashes as path separators.
    if (quoted) return sanitizeName(quoted[1].replace(/\\"/g, '"'));
    const plain = /filename\s*=\s*([^;]+)/i.exec(header);
    if (plain) return sanitizeName(plain[1].trim());
    return null;
  }

  function isAttachment(header) {
    return /^\s*attachment\b/i.test(header || '');
  }

  /** Single safe file name (no path, no control or reserved characters). */
  function sanitizeName(name) {
    const n = String(name || '')
      .split(/[\\/]/)
      .pop()
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f<>:"|?*\u202a-\u202e\u2066-\u2069]/g, '_')
      .replace(/^[.\s]+|[.\s]+$/g, '')
      .slice(0, 240);
    return n || null;
  }

  function fileNameFromUrl(url) {
    const last = pathOf(url).split('/').filter(Boolean).pop();
    return last ? sanitizeName(decodeSafe(last)) : null;
  }

  function isHttp(url) {
    return /^https?:\/\//i.test(String(url || ''));
  }

  function categoryOf(ext, mime) {
    const m = baseMime(mime);
    if (HLS_MIME.includes(m) || DASH_MIME.includes(m)) return 'video';
    if (m.startsWith('video/')) return 'video';
    if (m.startsWith('audio/')) return 'audio';
    if (m.startsWith('image/')) return 'image';
    if (MIME_EXT[m]) return EXT_CATEGORY[MIME_EXT[m]] || null;
    if (SEGMENT_EXT.includes(ext)) return 'video';
    return EXT_CATEGORY[ext] || null;
  }

  function methodOf(url, mime) {
    const m = baseMime(mime);
    const ext = extOf(pathOf(url));
    if (HLS_MIME.includes(m) || ext === 'm3u8') return 'hls';
    if (DASH_MIME.includes(m) || ext === 'mpd') return 'dash';
    return 'direct';
  }

  /**
   * True for pieces of a stream (fMP4/TS segments, byte-range chunks) that are not useful on
   * their own: the manifest is offered instead.
   */
  function isSegment(url, mime, contentRange) {
    const m = baseMime(mime);
    const path = pathOf(url);
    const ext = extOf(path);
    if (SEGMENT_EXT.includes(ext) || m === 'video/iso.segment' || m === 'video/mp2t' || ext === 'ts') return true;
    if (SEGMENT_RE.test(path) || SEGMENT_RE.test(String(url).split('#')[0].replace(/^[^?]*/, ''))) return true;
    // A range response that is not the start of the file and has no known total size.
    if (contentRange && /bytes\s+\d+-\d+\/\*/i.test(contentRange)) return true;
    return false;
  }

  /** Total size from Content-Range ("bytes 0-99/1234") or Content-Length. */
  function sizeOf(contentLength, contentRange) {
    const cr = /\/(\d+)\s*$/.exec(contentRange || '');
    if (cr) return Number(cr[1]);
    const n = Number(contentLength);
    return Number.isFinite(n) && n > 0 && !contentRange ? n : null;
  }

  /**
   * Classifies a resource. Returns null when it is not something to offer.
   * @param {{url:string, mime?:string, disposition?:string, contentRange?:string, contentLength?:string|number}} r
   */
  function classify(r) {
    const url = String(r.url || '');
    if (!isHttp(url) || url.length > 8192) return null;
    const mime = baseMime(r.mime);
    const fromDisposition = parseDisposition(r.disposition);
    const fileName = fromDisposition || fileNameFromUrl(url);
    const ext = extOf(fromDisposition || pathOf(url)) || MIME_EXT[mime] || '';
    const method = methodOf(url, mime);
    const category = method === 'direct' ? categoryOf(ext, mime) : 'video';
    if (!category) return null;
    const segment = method === 'direct' && !isAttachment(r.disposition) && isSegment(url, mime, r.contentRange);
    const format = method === 'hls' ? 'm3u8' : method === 'dash' ? 'mpd' : ext || MIME_EXT[mime] || '';
    return {
      url,
      category,
      method,
      format,
      mime: mime || null,
      fileName,
      // For a manifest, Content-Length is the playlist file, not the media.
      size: method === 'direct' ? sizeOf(r.contentLength, r.contentRange) : null,
      segment,
      attachment: isAttachment(r.disposition)
    };
  }

  /**
   * Like classify(), for a URL taken from a <video>/<audio>/<img> element: the element says
   * what an extension-less address is (e.g. <video src="/stream?id=1">).
   */
  function classifyElementSource(url, mime, elementCategory) {
    const r = classify({ url, mime });
    if (r || !['video', 'audio', 'image'].includes(elementCategory) || !isHttp(url) || String(url).length > 8192) return r;
    return { url: String(url), category: elementCategory, method: methodOf(url, mime), format: '', mime: baseMime(mime) || null, fileName: fileNameFromUrl(url), size: null, segment: false, attachment: false };
  }

  function normalizeUrl(url) {
    return String(url || '').split('#')[0];
  }

  /** Short stable id (FNV-1a) for a URL. */
  function idOf(url) {
    let h = 0x811c9dc5;
    const s = normalizeUrl(url);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0') + s.length.toString(16);
  }

  /** Host names from the "excluded sites" setting (one per line, or separated by spaces/commas). */
  function parseSites(text) {
    return String(text || '')
      .toLowerCase()
      .split(/[\s,;]+/)
      .map((s) =>
        s
          .replace(/^[a-z]+:\/\//, '')
          .replace(/[/:].*$/, '')
          .replace(/^\*\./, '')
          .replace(/^www\./, '')
      )
      .filter((s) => /^[a-z0-9.-]+$/.test(s) && s.includes('.'));
  }

  function isExcluded(hostname, sitesText) {
    const host = String(hostname || '')
      .toLowerCase()
      .replace(/^www\./, '');
    if (!host) return false;
    return parseSites(sitesText).some((s) => host === s || host.endsWith('.' + s));
  }

  function wants(settings, category, method) {
    const types = Array.isArray(settings.detectTypes) ? settings.detectTypes : DEFAULTS.detectTypes;
    if (method && method !== 'direct') return types.includes('video') || types.includes('audio');
    return types.includes(category);
  }

  function humanSize(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return '';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let v = bytes;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
  }

  root.SwiftClassify = {
    EXT,
    CATEGORIES,
    DEFAULTS,
    DEFAULT_EXTENSIONS,
    MIN_NETWORK_MEDIA_BYTES,
    baseMime,
    extOf,
    parseDisposition,
    isAttachment,
    sanitizeName,
    fileNameFromUrl,
    isHttp,
    categoryOf,
    methodOf,
    isSegment,
    sizeOf,
    classify,
    classifyElementSource,
    normalizeUrl,
    idOf,
    parseSites,
    isExcluded,
    wants,
    humanSize
  };
})(globalThis);
