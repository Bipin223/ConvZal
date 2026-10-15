# ConvZal

ConvZal converts video and extracts audio entirely on your own device. The browser version uses WebCodecs, Mediabunny, and a local FFmpeg fallback; the Windows desktop version bundles a native FFmpeg sidecar for reliable encoding without browser codec restrictions. Video can be encoded as H.265/HEVC, H.264/AVC, AV1, or VP9 and muxed into an MP4, MKV, MOV, or WebM container, and audio can be extracted to an **M4A** (AAC). Files are processed locally and are not uploaded.

## Controls

- **What to keep** — *Video* keeps picture and sound; *Audio only (M4A)* drops the video and writes the soundtrack as AAC in an `.m4a` (plays on phones, cars and editors).
- **Rate control** — either a CRF quality slider (0–51, where a higher number means a smaller file) or a target bitrate. Quick chips set the usual CRF 32 / 23 / 18 points.
- **Lossless** — a switch that encodes bit-exactly (H.265 `lossless=1`, H.264 `-qp 0`, VP9/AV1 lossless). Files are very large; it is off by default.
- **Encoding effort** — Fast / Balanced / Thorough maps onto each encoder's own preset (`libx265` `faster`→`slow`, SVT-AV1 10→6, and so on), which is the single biggest speed lever.
- **Use the GPU** — on the desktop build, attempts NVENC / QuickSync / AMF first and silently falls back to the CPU encoder when no GPU answers. Never used for lossless.
- **Save to** — the built-in folder browser (with breadcrumbs, an Up button, drive list and shortcuts) or the Windows folder dialog chooses the output location. The desktop result card adds **Show in folder**, **Play**, and **Save a copy**.

Two long-standing freeze causes are handled explicitly: the decoder `-progress` pipe is always drained (an unread pipe used to deadlock FFmpeg), and the first *real* video stream is mapped with `0:V:0` so a cover-art / attached-picture track can no longer produce a one-frame file.

## Phones and playback

In the browser every codec (H.265/HEVC, H.264/AVC, AV1, VP9) stays selectable. When the device has a WebCodecs encoder for the chosen codec it is used — that is the fast path — and when it does not, ConvZal falls back to its bundled software FFmpeg. The panel says which codecs will use the software encoder, because a software H.265 encode of a phone clip takes minutes rather than seconds. The **desktop app** always uses native FFmpeg, so it is the fastest option for H.265 and AV1.

Whatever the path, the result is **checked before it is shown**: ConvZal reads the produced file back (container, video codec, audio track, duration) and refuses to present it if it is empty, truncated, or in a different codec than the one requested. Sizes are shown as a change against the original ("31% smaller", "about the same size") so a conversion can never be mistaken for "nothing happened".

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

The installer is created at `dist/ConvZal-0.0.0-Setup.exe`. The generated `desktop/ffmpeg/ffmpeg.exe` file is ignored by Git because it is a large build artifact; run `npm run prepare:ffmpeg` again on another Windows build machine.

## Browser support

Encoding depends on the device and browser exposing the requested codec through WebCodecs. Support varies by operating system, hardware, browser version, and installed codec support. The app checks support before conversion and reports which encoder it uses.

When WebCodecs cannot encode the requested codec, the app falls back to a bundled FFmpeg WebAssembly encoder (downloaded on first use) rather than a real-time MediaRecorder capture — the recorder ran at 1× speed and often produced files that players showed as a single frozen frame. The app keeps the strict local-processing model and does not upload files.
