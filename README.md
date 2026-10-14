# Local Encode

The browser version uses WebCodecs, Mediabunny, and local FFmpeg fallbacks. The Windows desktop version bundles a native FFmpeg sidecar for reliable encoding without browser codec restrictions. Video can be encoded as H.265/HEVC, H.264/AVC, AV1, or VP9 and muxed into an MP4, MKV, MOV, or WebM container. Files are processed locally and are not uploaded.

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

The interface is deliberately built to fit on a single screen. The shell is exactly one viewport tall (`100dvh`) with `overflow: hidden`, the workspace flexes to fill whatever space is left, and the settings panel compacts itself when the window is short (`max-height` queries). From 1024×768 up to 1920×1080 nothing is cut off and no page scrollbar appears — the footer stays visible above the fold.

Two deliberate degradations keep content reachable on smaller viewports: below 760px wide the shell stops forcing a fixed height so the page scrolls normally, and below 660px tall the panel hides the two rows (`Format` and the quality caption) that only repeat what the Codec, Container, and Compression controls already show.

## Windows desktop build

The Electron desktop build uses the native FFmpeg executable installed on the machine and packages it into the installer.

```powershell
npm run desktop:dev
npm run desktop:package
```

The installer is created at `dist/Local-Encode-0.0.0-Setup.exe`. The generated `desktop/ffmpeg/ffmpeg.exe` file is ignored by Git because it is a large build artifact; run `npm run prepare:ffmpeg` again on another Windows build machine.

## Browser support

Encoding depends on the device and browser exposing the requested codec through WebCodecs. Support varies by operating system, hardware, browser version, and installed codec support. The app checks support before conversion and reports which encoder it uses.

When WebCodecs cannot encode the requested codec, the app falls back to a MediaRecorder capture (H.264 MP4 or VP9 WebM) and then to a bundled FFmpeg WebAssembly encoder. The app keeps the strict local-processing model and does not upload files.
