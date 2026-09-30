# SENSE RAY — Remaining TODO

## Fixed in this pass
- [x] `videoCapture` permission missing from `manifest.json` → camera `getUserMedia` failed silently. Added.
- [x] Overlay never handled `SITE_MODE` → site grid never activated. Listener added in `index.js`.
- [x] `content.js` ignored `GAZE_POS` → no visible ray on the page. Now draws glow cursor + optional click.
- [x] **Critical wiring bug**: `background.js` used `chrome.tabs.sendMessage(overlayTabId, …)` to talk to the overlay.
  The overlay is an *extension page* (no content script), so those messages never arrived in `index.js`.
  ACKs and SITE_MODE now go through `chrome.runtime.sendMessage` (extension-wide); only real pages use `tabs.sendMessage`.
- [x] On OPEN_OVERLAY, background now proactively QUERY_SITE on the active tab so overlay enters site mode immediately.

## Message map (wired end-to-end)
```
popup ──OPEN_OVERLAY / CLOSE_OVERLAY──► background
                                          │
overlay/index.js ──GAZE_POS / GAZE_PING──► background
       ▲                                  │
       └──GAZE_ACK (runtime)──────────────┤
                                          ├──GAZE_POS (tabs)──► content.js  (draws on-page ray)
content.js ──SITE_INFO───────────────────► background
       ▲                                  │
overlay/index.js ◄──SITE_MODE (runtime)───┘
```

## Still open / limitations
- [ ] True IR hardware path is simulated (webcam grayscale + X3-XOR-Diff).
- [ ] Gaze is motion-centroid, not a trained eye model — limited under low light / glasses.
- [ ] Overlay starts with cover (`showCover = true`); press SPACE / click / 1–7 to enter reticle.
- [ ] `activateGridCell` selectors for Instagram/YouTube may need tuning per site redesigns.
- [ ] No dedicated options page; settings live in the TAB panel inside the overlay.
- [ ] After extension reload, Chrome may re-prompt for camera on the overlay window.

## How to test
1. Load unpacked: this folder.
2. Toolbar icon → OPEN OVERLAY → allow camera.
3. Press SPACE to dismiss cover → 8-layer MNIST reticle should appear and track.
4. Browse any page → green glow ray cursor tracks on the page.
5. Instagram / YouTube → overlay HUD shows SITE mode + grid after content reports hostname.
