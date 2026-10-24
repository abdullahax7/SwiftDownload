# Changelog

## 1.2.2

- Downloads started from the Media page now open the download list, selected and scrolled into view, so you can see their progress.
- New downloads that arrive while the Media page is open are shown the same way.

## 1.2.1

- Updates are now required: SwiftDownload can't be used until a new version is installed (no skipping, also after a restart or offline).
- While an update is pending, downloads pause and new ones are refused; downloads from the browser stay in the browser.
- If the update can't be downloaded it is retried every minute, with a link to download it from GitHub.

## 1.2.0

- Automatic updates: SwiftDownload now updates itself from GitHub (signed and verified).
- Toolbar fits the window; the filter and search box are no longer cut off.
- Extension pages are readable in dark mode.
- Credit line: Created with love by Webxoo.com.

## 1.1.0

**New: browser media detection**
- The extension finds video, audio, images, documents, archives and programs on any page, from network responses and from the page itself (players, links, images, Open Graph and JSON-LD), including content that loads later.
- Toolbar popup listing the page's media, with format, size, quality and download method; filters by type.
- Download button on video and audio players, with a quality menu for streams.
- Right-click **Download with SwiftDownload** on links, images, video and audio.
- New Options: file types to detect, excluded websites, player button, image button, list in the app.
- Clear status when the app isn't running, and a **Reconnect** button.
- New **Media** view in the app with filters and a format/quality picker.

**New: HLS and MPEG-DASH streams**
- Downloaded natively: choose the quality and audio track; segments download in parallel and resume after pauses, crashes and restarts.
- Separate video and audio are combined with FFmpeg when it's installed (optional).
- DRM-protected, live and unsupported streams are detected and reported clearly.
- Cookies are only sent to the server the stream came from.

**Improvements**
- Stream downloads show segment progress, and their size is marked as an estimate until finished.
- Toolbar fits the window: the filter and search box are no longer cut off.
- Extension pages are readable in dark mode.

## 1.0.0
- Segmented, resumable downloads; queue and scheduler; speed limits; categories; torrents and magnet links; browser download takeover.
