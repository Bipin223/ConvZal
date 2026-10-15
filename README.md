# ConvZal

ConvZal converts video and extracts audio entirely on your own device. The browser version uses WebCodecs, Mediabunny, and a local FFmpeg core for audio; the Windows desktop version bundles a native FFmpeg sidecar for reliable encoding without browser codec restrictions, and can hand that same engine to a phone on the local Wi-Fi. Video can be encoded as H.265/HEVC, H.264/AVC, AV1, or VP9 and muxed into an MP4, MKV, MOV, or WebM container, and audio can be extracted to an **M4A** (AAC). Files are processed locally and are not uploaded.

**Live:** <https://bipin223.github.io/ConvZal/> — the browser version, nothing to install. Every push to `main` builds and deploys it through `.github/workflows/deploy.yml`.

## Controls

- **What to keep** — *Video* keeps picture and sound; *Audio only (M4A)* drops the video and writes the soundtrack as AAC in an `.m4a` (plays on phones, cars and editors).
- **Rate control** — either a CRF quality slider (0–51, where a higher number means a smaller file) or a target bitrate. Quick chips set the usual CRF 32 / 23 / 18 points.
- **Lossless** — a switch that encodes bit-exactly (H.265 `lossless=1`, H.264 `-qp 0`, VP9/AV1 lossless). Files are very large; it is off by default.
- **Encoding effort** — Fast / Balanced / Thorough maps onto each encoder's own preset (`libx265` `faster`→`slow`, SVT-AV1 10→6, and so on), which is the single biggest speed lever.
- **Use the GPU** - on the desktop build, attempts NVENC / QuickSync / AMF first and silently falls back to the CPU encoder when no GPU answers. Never used for lossless.
- **Use it from your phone** - desktop only: serves this converter to the local Wi-Fi so a phone can send a video and download the converted file. See *From your phone* below.
- **Save to** — the built-in folder browser (with breadcrumbs, an Up button, drive list and shortcuts) or the Windows folder dialog chooses the output location. The desktop result card adds **Show in folder**, **Play**, and **Save a copy**.

Two long-standing freeze causes are handled explicitly: the decoder `-progress` pipe is always drained (an unread pipe used to deadlock FFmpeg), and the first *real* video stream is mapped with `0:V:0` so a cover-art / attached-picture track can no longer produce a one-frame file.

## Phones and playback

In the browser, video is encoded with the device's own WebCodecs encoder. There is deliberately **no WebAssembly video fallback**: the bundled FFmpeg core ships x264/x265 built as `[32 bit][noasm]` that reports *"using cpu capabilities: none!"* and runs a single thread. Measured on a 4-second 1080p clip it did not encode a single frame in 106 seconds, so the app used to sit at 0% forever. It is not a slow path, it is a dead path, and it has been removed.

That means a codec the device cannot encode in hardware (usually H.265, AV1 and VP9 on Windows) cannot be produced in the browser at all. ConvZal says so instead of hanging: if the default H.265 has no hardware encoder it moves to H.264 automatically, the panel explains exactly why, and offers a one-click **Switch to H.264**. Choosing H.265 anyway is refused immediately with the same explanation. The **desktop app** bundles native FFmpeg and does H.265 and AV1 at full speed, so that is where to go for them.

Audio-only extraction always uses the FFmpeg core, because AAC encoding there is quick and dependable.

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

## Windows desktop build

The Electron desktop build uses the native FFmpeg executable installed on the machine and packages it into the installer.

```powershell
npm run desktop:dev
npm run desktop:package
```

The installer is created at `release/ConvZal-0.0.0-Setup.exe`, and `release/win-unpacked/ConvZal.exe` is the same build without the installer around it - handy for a quick run. electron-builder writes to `release/` on purpose: `dist/` belongs to Vite, and `npm run build` empties it, which used to delete an installer sitting there. The generated `desktop/ffmpeg/ffmpeg.exe` file is ignored by Git because it is a large build artifact; run `npm run prepare:ffmpeg` again on another Windows build machine.

The default Vite base is **relative** (`./`) so `dist/index.html` loads over `file://` inside the packaged app — an absolute `/assets/...` URL points at the drive root there and the window comes up blank. The Pages workflow sets an absolute `VITE_BASE_PATH` for the site, which is what a subfolder deployment needs.

## From your phone (desktop app)

The desktop app can hand its engine to the rest of the Wi-Fi. Switch on **Use it from your phone** in the source pane, scan the QR code with the phone (or type the address), pick a video on the phone and convert: the phone uploads over the local network, this PC encodes with the same native FFmpeg pipeline, and the phone downloads the result.

- The server exists only while the switch is on. Switching it off closes the socket and deletes the temp folder; quitting the app does the same.
- The switch is **remembered**: leave sharing on and it resumes by itself the next time the app opens, so the phone only needs the address once. ConvZal never installs a startup item - if the app is not running, the page simply does not answer.
- This is the only free route to H.265 from a phone: the coding happens on the PC, so the browser's hardware-only HEVC limitation does not apply.
- The body of the request *is* the file — it streams to a temp file and the result streams back, so phone memory is not a limit and there is no multipart parser in the path. Progress is polled, so a phone that sleeps mid-encode still finds the finished job.
- Cancel works mid-encode, a failed or cancelled attempt is deleted rather than left half-written, and a finished file stays downloadable for an hour.
- Nothing is uploaded anywhere: the bytes cross the local network and nothing else. If Windows Firewall asks the first time, allow ConvZal on private networks.

## Browser support

Encoding depends on the device and browser exposing the requested codec through WebCodecs. Support varies by operating system, hardware, browser version, and installed codec support. The app checks support before conversion and reports which encoder it uses.

When WebCodecs cannot encode the requested codec it is refused immediately with that explanation and a one-click **Switch to H.264** (see *Phones and playback*) — there is no silent fallback and nothing is uploaded. A phone that wants H.265 should use the desktop app's sharing mode below.
