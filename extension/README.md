# SwiftDownload browser extension

| Download | Browser |
| --- | --- |
| [`SwiftDownload-extension-chrome-edge.zip`](https://github.com/abdullahax7/SwiftDownload/raw/main/downloads/SwiftDownload-extension-chrome-edge.zip) | Google Chrome, Microsoft Edge, Brave and other Chromium browsers (Manifest V3, Chrome 115+) |
| [`SwiftDownload-extension-firefox.zip`](https://github.com/abdullahax7/SwiftDownload/raw/main/downloads/SwiftDownload-extension-firefox.zip) | Firefox 128+ (Manifest V3) |

The same files are in the [`chrome-edge`](chrome-edge) and [`firefox`](firefox) folders here.

The extension needs the **SwiftDownload desktop app** (see the [main README](../README.md)); it talks only to the app on your computer through Native Messaging.

**Install (Chrome / Edge / Brave):** unzip `SwiftDownload-extension-chrome-edge.zip`, open `chrome://extensions` → turn on **Developer mode** → **Load unpacked** → choose the unzipped folder.

**Install (Firefox):** open `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → choose `SwiftDownload-extension-firefox.zip`, then click the toolbar icon → **Allow access to websites**.

Permissions, settings and troubleshooting: [docs/browser-integration.md](../docs/browser-integration.md).

Created with ❤️ by [Webxoo.com](https://webxoo.com)

Bugs, help or updates: [contact@webxoo.com](mailto:contact@webxoo.com)
