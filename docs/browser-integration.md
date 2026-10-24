# SwiftDownload browser integration

The SwiftDownload extension (Chrome, Edge, Brave, other Chromium browsers, and Firefox 128+)
detects downloadable media and files while you browse and hands downloads to the SwiftDownload
desktop app. It talks to the app only through **Native Messaging**: no local web server, no
remote code.

## What it does

| Feature | Where |
| --- | --- |
| Takes over browser downloads (all files, or only chosen extensions) | automatic; toggle in the popup |
| Opens magnet links in SwiftDownload | automatic |
| **Download with SwiftDownload** on links, images, video and audio | right-click menu |
| Lists media and files found on the current page, with format, size, quality and method | toolbar popup |
| Download button on video/audio players, with a quality menu for streams | hover over a player |
| Optional download button on large images | Options → *Show a download button when pointing at large images* |
| Detected media also listed in the desktop app | toolbar → **Media** |

Detection uses network responses (MIME type, `Content-Disposition`, size; headers only, never
bodies) and the page itself (`<video>`, `<audio>`, `<source>`, `<img>`/`srcset`, links to files,
Open Graph and JSON-LD media), including content added later by single-page apps.

Each item is classified as one of:

* **Direct file**: downloaded with SwiftDownload's segmented, resumable engine.
* **HLS stream** (`.m3u8`) or **DASH stream** (`.mpd`): SwiftDownload reads the manifest,
  shows the real qualities and audio tracks, downloads the segments in parallel and joins them.
* Pieces of a stream (TS/fMP4 segments, byte-range chunks) are never offered on their own.
* Pages that only embed a player without a usable source get no download button.

## Install

1. Install and start SwiftDownload. It registers its Native Messaging host for the current
   Windows user automatically (installed builds), or click **Options → Browser → Register**.
2. In SwiftDownload: **Options → Browser → Install in Google Chrome** (or Edge / Brave / Firefox).
   The browser's extensions page opens and the extension folder path is copied to the clipboard.
3. Chromium browsers: enable **Developer mode** → **Load unpacked** → paste the folder path
   (`…\SwiftDownload\browser-extension\chromium`).
   Firefox: **This Firefox** → **Load Temporary Add-on…** → choose `browser-extension\firefox\manifest.json`.
4. Click the SwiftDownload toolbar icon: it should say *Connected to SwiftDownload 1.1.0*.

The Chromium extension has a fixed ID (`oiadbikjnbiogckchndacidcaoinhihl`, from the `key` in its
manifest); the Native Messaging host only accepts that ID (and `swiftdownload@swiftdownload.app` in
Firefox).

### Native Messaging registration (Windows)

Registration is per user (no administrator rights) and is removed by the uninstaller.

| Registry key (HKCU) | Default value |
| --- | --- |
| `Software\Google\Chrome\NativeMessagingHosts\com.swiftdownload.host` | `%APPDATA%\com.swiftdownload.tauri\native-messaging\com.swiftdownload.host.chromium.json` |
| `Software\Microsoft\Edge\NativeMessagingHosts\com.swiftdownload.host` | same |
| `Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.swiftdownload.host` | same |
| `Software\Chromium\NativeMessagingHosts\com.swiftdownload.host` | same |
| `Software\Mozilla\NativeMessagingHosts\com.swiftdownload.host` | `…\com.swiftdownload.host.firefox.json` |

The manifest points to `swiftdownload-host.exe` next to `SwiftDownload.exe` and lists the allowed
extension. To register by hand (for example for a portable copy you moved), start SwiftDownload and
click **Options → Browser → Register**; to remove, click **Unregister**.

## Permissions (and why)

| Permission | Used for |
| --- | --- |
| `nativeMessaging` | talking to SwiftDownload |
| `downloads`, `downloads.ui` | taking over downloads; hiding the browser's download bubble while it does |
| `webRequest` + access to all sites | reading response headers (type, size, file name) to recognise media and streams |
| `contextMenus` | *Download with SwiftDownload* |
| `storage` | settings; the per-tab list of detected media (session storage, cleared when the browser closes) |
| `cookies` (optional, off by default) | only if you enable *Send the site's cookies*: needed for downloads that require you to be signed in |

The content script runs only on `http`/`https` pages, never on browser pages, and its UI is a
closed Shadow DOM in its own layer, so it does not change the page's layout or styles.

## Settings (extension Options)

* Take over browser downloads (all types, or a list of extensions; minimum size)
* Open magnet links in SwiftDownload
* Detect media on pages, and which types: video and streams, audio, images, documents, archives,
  programs/fonts/other
* Player download button; image download button
* List detected media in SwiftDownload's Media detector
* **Excluded sites**: no detection and no download takeover on these hosts (and their subdomains)
* Send cookies with downloads (asks for the `cookies` permission)

In the desktop app, **Options → Media** turns the Media detector on/off, sets parallel segment
downloads for streams (1–16) and the FFmpeg location.

## Privacy and security

* The extension sends media/download URLs, the page URL and title, file names and the browser's
  User-Agent to SwiftDownload on this computer, nothing anywhere else. Cookies are sent only when
  you enabled that option, only those the browser would send to that URL.
* Every message is validated three times: by the extension, by the host (`swiftdownload-host.exe`
  only knows `ping`, `add`, `detected`, `inspect`; unknown types and oversized values are dropped),
  and by the app (URL scheme and length, header characters, rendition ids, batch sizes).
* The host reaches the app over a per-user named pipe (remote clients rejected) and must present a
  random token regenerated at every app start. Nothing received can run a program or choose a file
  path; downloads go to the folder configured in SwiftDownload.
* Session data (Cookie, User-Agent) from the browser is encrypted with Windows DPAPI when stored
  with a download, kept in memory only for detected media, never shown in the UI, logs or
  diagnostics, and for streams only sent to the host the manifest came from (never to other CDNs).
* Detected media URLs are kept in memory only; the UI shows them without query strings.

## Streams and FFmpeg

HLS and DASH streams are downloaded natively: segments in parallel with retries, resumable after a
pause, a crash or a restart (finished segments are kept in `<file>.swdstream`), then joined on disk
without loading the video into memory. FFmpeg is needed only to:

* combine separate video and audio tracks (most DASH and many HLS streams): the result is MP4
  (or WebM/MKV when the codecs require it), copied without re-encoding;
* turn MPEG-TS streams into MP4 (without FFmpeg they are saved as playable `.ts` files);
* download HLS streams with AES-128 (clear-key) encryption.

SwiftDownload does not bundle FFmpeg (licence and installer size). Install it and set the path in
**Options → Media**, put it on `PATH`, or, if you distribute SwiftDownload, ship an **LGPL** build
as `ffmpeg\ffmpeg.exe` next to `SwiftDownload.exe`; it is found automatically. Builds with
`--enable-gpl` or `--enable-nonfree` change the licence terms of what you distribute. If you bundle
FFmpeg, include its licence text and offer its source as the LGPL requires.

## Website support and limitations

* **Generic detection works on any site** that loads media from a file URL or an unencrypted
  HLS/DASH stream. Whether you may download something is up to the site's terms and copyright law.
* **DRM is never bypassed.** Streams protected by Widevine, PlayReady, FairPlay or SAMPLE-AES
  (most paid streaming services) are reported as *Not supported*.
* **Live streams** are not supported (only complete, on-demand streams). Multi-period DASH (often
  used for inserted ads) is reported as not supported.
* **YouTube is not supported.** YouTube's Terms of Service do not allow downloading except through
  YouTube's own features, and its streams are delivered in protected pieces. The YouTube adapter
  shows this in the popup, hides the player button there and ignores YouTube's video requests
  (also in embedded players).
* Signed or session-bound links expire. If a download fails with *The stream server refused access*
  or *no longer available*, reload the page and download again.
* Media inside cross-origin frames is found when the frame is an `http(s)` page (the content script
  runs in all frames); `blob:` players are matched to the streams the tab loaded.

Site rules live in the extension's `adapters.js`. Each declares its detection methods,
capabilities, limitations and extra permissions; the global detection rules are not changed by
adapters.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Popup: *SwiftDownload is not running* | Start SwiftDownload, click **Reconnect**. No browser restart needed. |
| Popup: *not connected to this browser* | SwiftDownload → Options → Browser → **Register**, then **Reconnect**. |
| Nothing detected | Start playing the video (many players load media only then). Check that the site is not excluded and the type is selected in Options. In Firefox, click *Allow access to websites* in the popup. |
| No button on a player | The player has no usable source (DRM, YouTube, or not loaded yet). Use the popup or right-click instead. |
| *needs FFmpeg* | Install FFmpeg (see above) or pick a quality that includes audio. |
| Download goes to the browser instead | SwiftDownload was not reachable; the browser keeps the download so nothing is lost. |
| Extension updated but old behaviour | Reload it on the browser's extensions page. |

Logs: SwiftDownload → Options → Storage → Logs → *Open*. To report a problem, use **Options → Storage → Diagnostic report → Export…** (passwords, cookies, sign-in headers and link details are removed) and email it to [contact@webxoo.com](mailto:contact@webxoo.com).

## Message protocol (developers)

Extension → host: Native Messaging (32-bit length + JSON). Host → app: one JSON line on
`\\.\pipe\swiftdownload-tauri-<user>-<hash>` with the token from `host-token`.

| `type` | Fields | Reply |
| --- | --- | --- |
| `ping` | | `{ ok, version, features }` |
| `add` | `url`, `referrer`, `filename`, `userAgent`, `cookie`, `kind` (`hls`/`dash`), `video`, `audio`, `title` | `{ ok }`; starts the app if needed |
| `detected` | `items[≤50]` (`url`, `method`, `category`, `mime`, `size`, `title`, `fileName`, `pageUrl`, `pageTitle`, `resolution`, `format`, `duration`, `cookie`), `userAgent` | `{ ok, accepted }` |
| `inspect` | `url`, `referrer`, `userAgent`, `cookie` | `{ ok, media: { variants, audioTracks, durationSec, drm, live, encrypted, supported, reason } }` |

Errors carry `code`: `NOT_RUNNING`, `NOT_INSTALLED`, `INVALID`.

---

Created with ❤️ by [Webxoo.com](https://webxoo.com)

Bugs, help or updates: [contact@webxoo.com](mailto:contact@webxoo.com)
