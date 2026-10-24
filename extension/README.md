# SwiftDownload browser extension

| Folder | Browser |
| --- | --- |
| [`chrome-edge`](chrome-edge) | Google Chrome, Microsoft Edge, Brave and other Chromium browsers (Manifest V3, Chrome 115+) |
| [`firefox`](firefox) | Firefox 128+ (Manifest V3) |

The extension needs the **SwiftDownload desktop app** (see the [main README](../README.md)); it talks only to the app on your computer through Native Messaging.

**Install (Chrome / Edge / Brave):** open `chrome://extensions` → turn on **Developer mode** → **Load unpacked** → choose the `chrome-edge` folder.

**Install (Firefox):** open `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → choose `firefox/manifest.json`, then click the toolbar icon → **Allow access to websites**.

Permissions, settings and troubleshooting: [docs/browser-integration.md](../docs/browser-integration.md).

Created with ❤️ by [Webxoo.com](https://webxoo.com)

Bugs, help or updates: [contact@webxoo.com](mailto:contact@webxoo.com)
