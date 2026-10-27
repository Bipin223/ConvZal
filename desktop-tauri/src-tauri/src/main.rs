// ConvZal for Windows, Tauri shell.
//
// This build embeds the same web app that runs on GitHub Pages, so encoding uses the
// device's own WebCodecs encoders. The Electron build (../release) is the one that also
// carries the native FFmpeg sidecar and the phone-sharing server.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running ConvZal");
}
