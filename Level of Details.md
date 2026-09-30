# SENSE RAY — Level of Details

## Purpose

Unpacked browser-extension directory prepared from the supplied source files.

## Accuracy and intention improvements

Implemented as additive layers around the existing webcam motion estimator:

- **Five-point affine calibration:** Use the settings panel (`Tab`) and choose **START 5-POINT CALIBRATION**. Look at each displayed corner/center target and press Space while holding a steady gaze. A least-squares affine map is fitted from the smoothed motion estimate to normalized screen coordinates and applied after smoothing. Calibration is saved under `senseray_calibration_v1` in `chrome.storage.local` and restored on later overlay sessions. Recalibration replaces the saved map.
- **Stable-intention gates:** Blink-triggered clicks now require confidence of at least `MIN_CONFIDENCE` and gaze velocity below 900 px/s. Dwell clicks require the same confidence and velocity below 500 px/s. The existing dwell ring, timers, cooldowns, clamps, and `GAZE_POS` message shape remain in place.
- **Bounds:** Calibrated coordinates still pass through the existing `gx`/`gy` seL4-style clamps.

## Limits and unimplemented roadmap items

The estimator still uses 80×60 X3-XOR motion and does not identify eyes, pupils, or head pose. Calibration compensates for a user's screen mapping but cannot turn arbitrary scene motion into true gaze, and no measured accuracy multiplier is claimed. The five-point calibration is a simple affine model; it is not a polynomial model. The MediaPipe/WebGazer worker pipeline, higher-resolution eye crop, sticky webpage targets have not been added. No neural model or external runtime dependency was introduced.

## Message and backend behavior

The existing `GAZE_POS` payload and background routing are unchanged. `background.js`, `content.js`, `manifest.json`, popup, and overlay resources remain present in this workspace.

## Verification status

The implementation was reviewed against the existing frame-processing and message flow. No runtime webcam session or browser-extension integration run was performed, so real-world accuracy and click behavior still need validation on the target camera and browser.

## LUT update

The post-smoothing calibration assertion point is explicitly marked in `processFrame()`. The calibrated coordinates are clamped there, and that final ray feeds the LUT, dwell/click decisions, reticle, and normalized `GAZE_POS` payload.

LUT verification now counts only consecutive frames with confidence at or above `MIN_CONFIDENCE` and calibrated-ray velocity below 500 px/s. A low-confidence or fast-moving frame resets the active cell's pending dwell count; previously verified flags and hit totals are retained. This prevents intermittent/noisy samples from completing a zone's dwell requirement.

The supplied articulated hand/finger equations are not wired into gaze or LUT processing: this project has no hand landmark or joint-angle estimator to provide their inputs. They would require a separate hand-tracking source and intention path.

## Exposure, math, profiles, and reticle controls

- **Frame exposure analysis:** The camera frame histogram reports mean luminance, P5/P95, and clipped black/white pixel count. A P5–P95 contrast stretch, smoothed with the FIIR alpha, can be blended into grayscale before the X3-XOR calculation. The HUD labels this as frame luminance. It is not an iris detector, infrared sensor reading, depth estimate, or hardware camera exposure control.
- **3× XOR presets:** Responsive, balanced, and precision presets set the XOR bit mask, motion threshold, and minimum changed-pixel count. The existing three-frame XOR and centroid flow remain intact.
- **MNIST rings and math table:** The reticle's orbital ring count is adjustable from 1 to 12. The settings panel shows a live math/assertion table for histogram, XOR settings, motion centroid, smoothing, affine coefficients, bounds, frame-luma settings, LUT state, and finger assertions.
- **Saved profiles:** Enter a name and choose **SAVE CURRENT** to persist estimator parameters, exposure settings, XOR/MNIST selections, ring count, gaze calibration, hand reference points, and the LUT in `chrome.storage.local` (with a local-storage fallback). Select a saved profile and choose **LOAD SELECTED** to restore it.
- **Finger assertion points:** The settings panel captures open-hand and closed-fist reference angles, then checks incoming MCP/PIP/DIP samples against open-to-closed interpolation. No hand tracker is bundled. An external provider must dispatch a `sense-ray-hand-pose` `CustomEvent` on the overlay window with `detail.angles` containing `thumb`, `index`, `middle`, `ring`, and `pinky`, each with numeric `mcp`, `pip`, and `dip` values in degrees. Captured points are included when saving a named profile. Finger assertions do not drive gaze or clicks.

The manifest description now identifies webcam motion and frame-histogram exposure rather than claiming IR eye tracking. No real iris, depth, or hand landmark model was added, and no measured accuracy change is available. The browser camera path was not exercised in this workspace.

## Manifest and Content Security Policy fixes

Removed the unsupported `videoCapture` manifest permission; camera access continues through the overlay's `getUserMedia()` request and browser permission prompt. Moved the popup's OPEN/CLOSE button listeners into `popup/popup.js` and load that file as an external script, complying with Manifest V3's extension-page script policy. The overlay already loads `index.js` externally. No inline script blocks remain in the popup or overlay HTML.

## CSP fix test results

- Bun parsed `index.js`, `background.js`, `content.js`, and `popup/popup.js` successfully.
- Manifest JSON parsed, all declared local manifest targets exist, and `videoCapture` is absent.
- Popup and overlay HTML passed an inline-script scan; their referenced external scripts resolve to existing files.
- A popup smoke test confirmed OPEN and CLOSE dispatch `OPEN_OVERLAY` and `CLOSE_OVERLAY` messages respectively.
- Browser extension reload, CSP console behavior in Chrome, and camera permission flow were not tested because Chrome is unavailable in this environment.

## Brawler Ray Sense popup and content customization

- Rebuilt the popup as a status panel with Brawler, Sense, Precision, and Phantom preset cards plus overlay open/close controls.
- Added shared preset definitions in `ray-presets.js`. A preset updates the overlay motion profile, visual theme, MNIST glyph set/rings, and the page cursor style.
- Added overlay controls for page cursor color, size, glow, opacity, and visibility duration. Named custom profiles save and restore these values along with the existing gaze settings.
- `background.js` persists the selected preset and cursor style, sends the configuration to the overlay, and forwards it to the active page. `content.js` restores the style for later page loads and updates the live ray without changing the `GAZE_POS` payload.
- Preset selection and custom style changes are bounded and validated before being applied to the content cursor.

### Popup and ray customization verification

- Bun syntax checks passed for `index.js`, `background.js`, `content.js`, `popup/popup.js`, and `ray-presets.js`.
- Static checks passed for manifest JSON and local file references. Popup/overlay pages use external scripts, and the unsupported `videoCapture` permission is absent.
- Popup smoke checks passed for preset selection and OPEN/CLOSE message dispatch.
- Background VM checks passed for preset persistence/broadcast, preset-vs-custom update behavior, and cursor setting bounds.
- Content VM checks passed for live cursor styling with the Brawler and Precision presets.
- Chrome UI rendering, extension reload, and webcam behavior were not exercised because Chrome is unavailable in this environment.

## CSP follow-up

- The popup and overlay contain no inline JavaScript. The overlay's remaining inline CSS was moved to `overlay/overlay.css` and linked externally.
- `content.js` does not create script elements or execute page scripts, so this extension has no inline-script injection path into `http://localhost` pages.
- A `script-src` violation reported for `http://localhost` / `http://127.0.0.1` must be fixed at the page or development server serving that origin. Its source/configuration is not present in this extension workspace, so the blocked script cannot be identified or moved here.
- Reload the unpacked extension after updating it. If the localhost error remains, capture the violating page URL and console stack (or provide that page's source) to locate its inline bootstrap script.
