# ConvZal

ConvZal converts video and extracts audio entirely on your own device. The web build uses WebCodecs, Mediabunny, and a local FFmpeg core for audio; the Windows build wraps the same app in a Tauri shell (no bundled FFmpeg, so it uses the machine's own encoders). Video can be encoded as H.265/HEVC, H.264/AVC, AV1, or VP9 and muxed into an MP4, MKV, MOV, or WebM container, and audio can be extracted to an **MP3** or an **M4A** (AAC). Files are processed locally and are not uploaded.

**Live:** <https://bipin223.github.io/ConvZal/> — the browser version, nothing to install. Every push to `main` builds and deploys it through `.github/workflows/deploy.yml`.

## Controls

- **What to keep** — *Video* keeps picture and sound; *Audio only* drops the video and writes the soundtrack as **MP3** (plays in every player and car stereo) or **AAC in an `.m4a`** (a little smaller at the same bitrate). MP3 is the default.
- **Rate control** — a CRF quality slider (0–51, where a higher number means a smaller file), a whole-file **Target size** budget (10/20/50 MB presets), or — in the desktop build — a fixed bitrate. Quick chips set the usual CRF 32 / 23 / 18 points.
- **Lossless** — a switch that encodes bit-exactly (H.265 `lossless=1`, H.264 `-qp 0`, VP9/AV1 lossless). Files are very large; it is off by default.
- **Encoding effort** — Fast / Balanced / Thorough maps onto each encoder's own preset. WebCodecs exposes no such knob, so the control only does something in the desktop build and says so.
- **Use the GPU** — asks WebCodecs for a hardware encoder first and falls back to software when the device has none. Never used for lossless.
- **Save to** — the folder picker chooses the output location where the browser supports it; otherwise the result is downloaded.

## Phones and playback

In the browser, video is encoded with the device's own WebCodecs encoder. There is deliberately **no WebAssembly video fallback**: the bundled FFmpeg core ships x264/x265 built as `[32 bit][noasm]` that reports *"using cpu capabilities: none!"* and runs a single thread. Measured on a 4-second 1080p clip it did not encode a single frame in 106 seconds, so the app used to sit at 0% forever. It is not a slow path, it is a dead path, and it has been removed.

That means a codec the device cannot encode in hardware (usually H.265, AV1 and VP9 on Windows) cannot be produced in the browser at all. ConvZal says so instead of hanging: if the default H.265 has no hardware encoder it moves to H.264 automatically, the panel explains exactly why, and offers a one-click **Switch to H.264**. Choosing H.265 anyway is refused immediately with the same explanation. The **desktop app** bundles native FFmpeg and does H.265 and AV1 at full speed, so that is where to go for them.

Audio-only extraction always uses the FFmpeg core, because its MP3 and AAC encoders are quick and dependable.

Whatever the path, the result is **checked before it is shown**: ConvZal reads the produced file back (container, video codec, audio track, duration) and refuses to present it if it is empty, truncated, or in a different codec than the one requested. Sizes are shown as a change against the original ("31% smaller", "about the same size") so a conversion can never be mistaken for "nothing happened". Cancel is available on every path, in the browser as well as the desktop app.

When the device exposes the Web Share API, the result card also offers **Save to device** so the file can be saved straight into Photos / Files instead of relying on a blob download.

The empty drop zone is a real `<label>` bound to a visually-hidden file input, so a tap opens the operating system's picker even on browsers that ignore a scripted `.click()` on a `display: none` input. Below 800px the two panes stack and the page scrolls normally — no fixed-height grid, which used to collapse the upload pane to zero height on a phone.

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend enabling type-aware lint rules by installing `oxlint-tsgolint` and editing `.oxlintrc.json`:

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["react", "typescript", "oxc"],
  "options": {
    "typeAware": true
  },
  "rules": {
    "react/rules-of-hooks": "error",
    "react/only-export-components": ["warn", { "allowConstantExport": true }]
  }
}
```

See the [Oxlint rules documentation](https://oxc.rs/docs/guide/usage/linter/rules) for the full list of rules and categories.

## GitHub Pages deployment

The workflow in `.github/workflows/deploy.yml` deploys automatically whenever `main` receives a push.

1. Push this project to a GitHub repository.
2. Open **Settings > Pages**.
3. Set **Source** to **GitHub Actions**.
4. Push to `main`, then open the Pages URL shown in the workflow or Pages settings.

The Vite base path is set automatically from the repository name during the GitHub Actions build.

## Local development

The dev server is pinned to port **5199** with `strictPort` enabled, so run:

```powershell
npm run dev
```

and open **http://localhost:5199/**. Override the port with `VITE_PORT` if needed.

The port deliberately does not use Vite's default 5173. Browsers scope service workers, HTTP cache, `localStorage`, and IndexedDB to an origin (scheme + host + port), so two projects sharing a port share that origin — a service worker or cached bundle left behind by another project's dev server on 5173 can then serve content for this app. `strictPort` also means the server exits with an error instead of silently drifting to 5174, which is the usual way projects end up sharing a port.

## Layout

The interface is deliberately built to fit on a single screen. The shell is a viewport-tall flex column, the workspace flexes to fill the space it is given, and the settings column scrolls on its own when the window is short instead of pushing the footer off screen. From 1024×768 up to 1920×1080 nothing is cut off — the footer stays visible above the fold.

The source pane holds the drop zone and the destination row; the settings pane holds rate control, effort, GPU, codec/container, resolution/framerate and audio. Below 800px wide the card stacks into one column; below 620px the built-in file browser moves its shortcuts above the list.

## Windows build (Tauri)

`desktop-tauri/` wraps the same built web app in a Tauri 2 shell. It has no bundled FFmpeg:
encoding uses the machine's WebCodecs encoders, so it does H.264/AV1/VP9 everywhere and H.265
only where the GPU exposes an HEVC encoder.

```powershell
npm run build
cd desktop-tauri
npm install
npx tauri build
```

The exe lands at `desktop-tauri/src-tauri/target/release/convzal.exe` and the NSIS installer at
`desktop-tauri/src-tauri/target/release/bundle/nsis/ConvZal_0.1.0_x64-setup.exe` (~2.1 MB,
8.8 MB installed). Building needs Rust (MSVC toolchain) and the Visual Studio C++ build tools;
WebView2 is already present on Windows 10/11.

The default Vite base is **relative** (`./`) so `dist/index.html` loads from the app's own
asset scheme; the Pages workflow sets an absolute `VITE_BASE_PATH` for the site, which is what
a subfolder deployment needs.

### Target size and the expected-size estimate

**Target size** turns a whole-file budget into a bitrate and, because the browser encoder
ignores bitrate (measured: 500 kbps and 1500 kbps both produced ~54 Mbps), into a pixel count.
It measures a six-second sample, encodes at the width that should fit, re-encodes smaller when
the result overshoots, and never plans above 85% of the source size. Measured: 408.7 MB →
19.98 MB (45 s), 299.9 MB → 19.93 MB (59 s), 299.9 MB → 9.92 MB (68 s), all real H.264 files.

In **Quality (CRF)** mode the panel shows an expected size measured from a short mid-clip
sample: 113.3 MB predicted against 111.4 MB actual on an 84-second 1080p60 clip (1.7% off).
The measurement is skipped in the Tauri shell because WebView2 stalls on a trimmed conversion;
Target size shows its budget in both builds. **Bitrate** mode is hidden in the browser/Tauri
build for the same reason — the number would not do anything there.


## Browser support

Encoding depends on the device and browser exposing the requested codec through WebCodecs. Support varies by operating system, hardware, browser version, and installed codec support. The app checks support before conversion and reports which encoder it uses.

When WebCodecs cannot encode the requested codec it is refused immediately with that explanation and a one-click **Use H.264** — there is no silent fallback and nothing is uploaded.