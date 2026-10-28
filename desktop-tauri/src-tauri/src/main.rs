// ConvZal for Windows, Tauri shell.
//
// The UI is the same web app, but when an FFmpeg binary is available on this PC it is used
// for the actual encoding: real x265/AV1/VP9, odd containers and audio extraction, instead
// of whatever the WebView's WebCodecs happens to expose.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

static CHILDREN: OnceLock<Mutex<HashMap<String, u32>>> = OnceLock::new();
static CANCELLED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn children() -> &'static Mutex<HashMap<String, u32>> {
    CHILDREN.get_or_init(|| Mutex::new(HashMap::new()))
}
fn cancelled() -> &'static Mutex<HashSet<String>> {
    CANCELLED.get_or_init(|| Mutex::new(HashSet::new()))
}

/* ------------------------------------------------------------------ ffmpeg discovery */

fn walk_for_ffmpeg(dir: &Path, depth: u32) -> Option<String> {
    if depth > 5 {
        return None;
    }
    let entries = std::fs::read_dir(dir).ok()?;
    let mut dirs = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            dirs.push(path);
        } else if path
            .file_name()
            .map(|name| name.to_string_lossy().eq_ignore_ascii_case("ffmpeg.exe"))
            .unwrap_or(false)
        {
            return Some(path.to_string_lossy().to_string());
        }
    }
    for dir in dirs {
        if let Some(found) = walk_for_ffmpeg(&dir, depth + 1) {
            return Some(found);
        }
    }
    None
}

/// PATH first, then the usual WinGet/Program Files locations, then a shallow disk scan of the
/// WinGet package folders. Cached for the life of the process.
fn ffmpeg_dir() -> Option<PathBuf> {
    let local = std::env::var("LOCALAPPDATA").ok()?;
    Some(PathBuf::from(local).join("ConvZal").join("ffmpeg"))
}

fn downloaded_ffmpeg() -> Option<String> {
    let path = ffmpeg_dir()?.join("ffmpeg.exe");
    if path.exists() { Some(path.to_string_lossy().to_string()) } else { None }
}

fn prefs_path() -> Option<PathBuf> {
    let roaming = std::env::var("APPDATA").ok()?;
    Some(PathBuf::from(roaming).join("ConvZal").join("engine.json"))
}

fn load_prefs() -> Value {
    prefs_path()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_else(|| json!({}))
}

fn save_prefs(prefs: &Value) {
    if let Some(path) = prefs_path() {
        if let Some(parent) = path.parent() { let _ = std::fs::create_dir_all(parent); }
        let _ = std::fs::write(path, serde_json::to_string_pretty(prefs).unwrap_or_default());
    }
}

fn find_ffmpeg() -> Option<String> {
    if let Some(path) = downloaded_ffmpeg() {
        return Some(path);
    }
    {
            if let Ok(out) = Command::new("where").arg("ffmpeg").output() {
                if out.status.success() {
                    if let Some(line) = String::from_utf8_lossy(&out.stdout).lines().next() {
                        let path = line.trim();
                        if !path.is_empty() && Path::new(path).exists() {
                            return Some(path.to_string());
                        }
                    }
                }
            }

            if let Ok(local) = std::env::var("LOCALAPPDATA") {
                let root = PathBuf::from(local).join("Microsoft").join("WinGet").join("Packages");
                if let Ok(entries) = std::fs::read_dir(&root) {
                    for entry in entries.flatten() {
                        let name = entry.file_name().to_string_lossy().to_lowercase();
                        if name.contains("ffmpeg") {
                            if let Some(found) = walk_for_ffmpeg(&entry.path(), 0) {
                                return Some(found);
                            }
                        }
                    }
                }
            }

            for candidate in [
                "C:/ffmpeg/bin/ffmpeg.exe",
                "C:/Program Files/ffmpeg/bin/ffmpeg.exe",
                "C:/Program Files (x86)/ffmpeg/bin/ffmpeg.exe",
            ] {
                if Path::new(candidate).exists() {
                    return Some(candidate.to_string());
                }
            }
            None
    }
}

fn download_ffmpeg(app: &AppHandle) -> Result<String, String> {
    let dir = ffmpeg_dir().ok_or("No LOCALAPPDATA")?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let zip_path = dir.join("ffmpeg-download.zip");
    let primary = std::env::var("CONVZAL_FFMPEG_URL").unwrap_or_else(|_| {
        "https://github.com/Bipin223/ConvZal/releases/download/ffmpeg-8.0/ffmpeg-win64.zip".into()
    });
    let fallback = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip".to_string();

    let response = ureq::get(&primary).call().or_else(|_| ureq::get(&fallback).call()).map_err(|e| format!("Download failed: {e}"))?;
    let total: u64 = response.header("Content-Length").and_then(|v| v.parse().ok()).unwrap_or(0);
    let mut reader = response.into_reader();
    let mut file = std::fs::File::create(&zip_path).map_err(|e| e.to_string())?;
    let mut chunk = [0u8; 65536];
    let mut received: u64 = 0;
    loop {
        let read = reader.read(&mut chunk).map_err(|e| e.to_string())?;
        if read == 0 { break; }
        use std::io::Write;
        file.write_all(&chunk[..read]).map_err(|e| e.to_string())?;
        received += read as u64;
        let _ = app.emit("ffmpeg-download", json!({ "received": received, "total": total }));
    }
    drop(file);

    let archive_file = std::fs::File::open(&zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(archive_file).map_err(|e| format!("Bad archive: {e}"))?;
    let mut found = false;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|e| e.to_string())?;
        let name = entry.name().to_lowercase();
        if name.ends_with("/bin/ffmpeg.exe") || name == "ffmpeg.exe" {
            let target = dir.join("ffmpeg.exe");
            let mut out = std::fs::File::create(&target).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
            found = true;
            break;
        }
    }
    let _ = std::fs::remove_file(&zip_path);
    if !found { return Err("The archive did not contain ffmpeg.exe".into()); }

    let mut prefs = load_prefs();
    prefs["prompted"] = json!(true);
    prefs["engine"] = json!("downloaded");
    save_prefs(&prefs);
    let path = dir.join("ffmpeg.exe").to_string_lossy().to_string();
    Ok(ffmpeg_version(&path))
}

#[tauri::command]
fn engine_state() -> Value {
    let prefs = load_prefs();
    match find_ffmpeg() {
        Some(path) => json!({
            "found": true,
            "path": path,
            "version": ffmpeg_version(&path),
            "downloaded": downloaded_ffmpeg().is_some(),
            "prompted": prefs["prompted"].as_bool().unwrap_or(false),
        }),
        None => json!({
            "found": false,
            "prompted": prefs["prompted"].as_bool().unwrap_or(false),
            "engine": prefs["engine"].clone(),
        }),
    }
}

/// First run: if FFmpeg is missing and the user has not been asked yet, offer the download.
#[tauri::command]
async fn first_run_ffmpeg(app: AppHandle) -> Value {
    if find_ffmpeg().is_some() {
        return json!({ "found": true });
    }
    let prefs = load_prefs();
    if prefs["prompted"].as_bool().unwrap_or(false) {
        return json!({ "found": false, "action": "skipped" });
    }
    let answer = app
        .dialog()
        .message("FFmpeg was not found on this PC.\n\nDownload it now (~100 MB)? H.265/HEVC, AV1 and odd containers need it. Choose No to continue with the browser engine.")
        .title("ConvZal needs FFmpeg")
        .buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancelCustom("Download".into(), "Continue without".into()))
        .blocking_show();
    if answer {
        let handle = app.clone();
        std::thread::spawn(move || {
            let result = download_ffmpeg(&handle);
            let _ = handle.emit("ffmpeg-download-done", json!({
                "ok": result.is_ok(),
                "version": result.clone().unwrap_or_default(),
                "error": result.err().unwrap_or_default(),
            }));
        });
        json!({ "found": false, "action": "downloading" })
    } else {
        let mut prefs = load_prefs();
        prefs["prompted"] = json!(true);
        prefs["engine"] = json!("none");
        save_prefs(&prefs);
        json!({ "found": false, "action": "declined" })
    }
}

fn ffmpeg_version(ffmpeg: &str) -> String {
    Command::new(ffmpeg)
        .arg("-version")
        .output()
        .ok()
        .and_then(|out| String::from_utf8_lossy(&out.stdout).lines().next().map(|l| l.to_string()))
        .unwrap_or_default()
}

/// Names of the video encoders this FFmpeg build actually has.
fn video_encoders() -> Vec<String> {
        let Some(ffmpeg) = find_ffmpeg() else {
            return Vec::new();
        };
        let Ok(out) = Command::new(&ffmpeg).args(["-hide_banner", "-encoders"]).output() else {
            return Vec::new();
        };
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter_map(|line| {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() >= 2 && parts[0].starts_with('V') {
                    Some(parts[1].to_string())
                } else {
                    None
                }
            })
            .collect()
}

/* ------------------------------------------------------------------------- conversion */

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Options {
    request_id: Option<String>,
    input_path: String,
    codec: String,
    container: String,
    audio_only: Option<bool>,
    mode: Option<String>,
    rate_control: Option<String>,
    crf: Option<f64>,
    video_bitrate: Option<f64>,
    audio_bitrate: Option<f64>,
    resolution: Option<String>,
    frame_rate: Option<String>,
    speed: Option<String>,
    hardware: Option<bool>,
    output_dir: Option<String>,
}

fn human(bytes: u64) -> String {
    let units = ["B", "KB", "MB", "GB", "TB"];
    let mut value = bytes as f64;
    let mut index = 0;
    while value >= 1024.0 && index < units.len() - 1 {
        value /= 1024.0;
        index += 1;
    }
    if index == 0 {
        format!("{value:.0} {}", units[index])
    } else {
        format!("{value:.1} {}", units[index])
    }
}

fn slug(codec: &str) -> &'static str {
    match codec {
        "avc" => "h264",
        "av1" => "av1",
        "vp9" => "vp9",
        _ => "hevc",
    }
}

fn extension(container: &str) -> &'static str {
    match container {
        "mkv" => "mkv",
        "mov" => "mov",
        "webm" => "webm",
        "m4a" => "m4a",
        _ => "mp4",
    }
}

fn output_path(input: &str, dir: Option<&str>, codec: &str, container: &str) -> String {
    let source = Path::new(input);
    let stem = source
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "output".into());
    let safe: String = stem
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    let base = match dir {
        Some(d) if !d.trim().is_empty() => PathBuf::from(d),
        _ => source.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| PathBuf::from(".")),
    };
    base.join(format!("{safe}-{}.{}", slug(codec), extension(container)))
        .to_string_lossy()
        .to_string()
}

fn sw_preset(encoder: &str, speed: &str) -> Option<&'static str> {
    match (encoder, speed) {
        ("libx265", "fast") => Some("faster"),
        ("libx265", "quality") => Some("slow"),
        ("libx265", _) => Some("medium"),
        ("libx264", "fast") => Some("veryfast"),
        ("libx264", "quality") => Some("slow"),
        ("libx264", _) => Some("medium"),
        ("libsvtav1", "fast") => Some("10"),
        ("libsvtav1", "quality") => Some("6"),
        ("libsvtav1", _) => Some("8"),
        ("libaom-av1", "fast") => Some("4"),
        ("libaom-av1", "quality") => Some("0"),
        ("libaom-av1", _) => Some("2"),
        ("libvpx-vp9", "fast") => Some("4"),
        ("libvpx-vp9", "quality") => Some("1"),
        ("libvpx-vp9", _) => Some("2"),
        _ => None,
    }
}

fn hw_preset(encoder: &str, speed: &str) -> Option<&'static str> {
    match (encoder, speed) {
        ("hevc_qsv" | "h264_qsv" | "av1_qsv", "fast") => Some("veryfast"),
        ("hevc_qsv" | "h264_qsv" | "av1_qsv", "quality") => Some("slow"),
        ("hevc_qsv" | "h264_qsv" | "av1_qsv", _) => Some("medium"),
        ("hevc_nvenc" | "h264_nvenc" | "av1_nvenc", "fast") => Some("p4"),
        ("hevc_nvenc" | "h264_nvenc" | "av1_nvenc", "quality") => Some("p7"),
        ("hevc_nvenc" | "h264_nvenc" | "av1_nvenc", _) => Some("p5"),
        ("hevc_amf" | "h264_amf", "fast") => Some("speed"),
        ("hevc_amf" | "h264_amf", "quality") => Some("quality"),
        ("hevc_amf" | "h264_amf", _) => Some("balanced"),
        _ => None,
    }
}

fn is_hardware(encoder: &str) -> bool {
    encoder.ends_with("_qsv") || encoder.ends_with("_nvenc") || encoder.ends_with("_amf")
}

fn candidates(codec: &str, hardware: bool) -> Vec<String> {
    let available = video_encoders();
    let software = match codec {
        "avc" => "libx264",
        "av1" => "libsvtav1",
        "vp9" => "libvpx-vp9",
        _ => "libx265",
    };
    let hardware_list: &[&str] = match codec {
        "hevc" => &["hevc_qsv", "hevc_nvenc", "hevc_amf"],
        "avc" => &["h264_qsv", "h264_nvenc", "h264_amf"],
        "av1" => &["av1_qsv", "av1_nvenc"],
        _ => &[],
    };
    let mut list: Vec<String> = Vec::new();
    if hardware {
        for encoder in hardware_list {
            if available.iter().any(|name| name == encoder) {
                list.push((*encoder).to_string());
            }
        }
    }
    if available.iter().any(|name| name == software) {
        list.push(software.to_string());
    } else if software == "libsvtav1" && available.iter().any(|n| n == "libaom-av1") {
        list.push("libaom-av1".to_string());
    }
    list
}

fn build_args(options: &Options, encoder: &str, output: &str) -> Vec<String> {
    let speed = options.speed.clone().unwrap_or_else(|| "balanced".into());
    let container = options.container.as_str();
    let audio_only = options.audio_only.unwrap_or(false);
    let lossless = options.mode.as_deref() == Some("lossless");
    let bitrate_mode = options.rate_control.as_deref() == Some("bitrate");
    let crf = options.crf.unwrap_or(23.0);
    let mut args: Vec<String> = vec![
        "-y".into(),
        "-nostdin".into(),
        "-fflags".into(),
        "+genpts".into(),
        "-i".into(),
        options.input_path.clone(),
    ];

    if audio_only {
        args.extend([
            "-map".into(), "0:a:0".into(),
            "-vn".into(),
            "-c:a".into(), "aac".into(),
            "-b:a".into(), format!("{}k", options.audio_bitrate.unwrap_or(192.0)),
            "-movflags".into(), "+faststart".into(),
            "-progress".into(), "pipe:1".into(),
            output.into(),
        ]);
        return args;
    }

    args.extend(["-map".into(), "0:V:0".into(), "-map".into(), "0:a?".into()]);
    args.extend(["-c:v".into(), encoder.into()]);

    let hardware = is_hardware(encoder);
    let preset = if hardware { hw_preset(encoder, &speed) } else { sw_preset(encoder, &speed) };
    if let Some(preset) = preset {
        if encoder.ends_with("_amf") {
            args.extend(["-quality".into(), preset.into()]);
        } else {
            args.extend(["-preset".into(), preset.into()]);
        }
    }

    if lossless {
        match encoder {
            "libx265" => args.extend(["-x265-params".into(), "lossless=1".into()]),
            "libx264" => args.extend(["-qp".into(), "0".into()]),
            "libsvtav1" => args.extend(["-crf".into(), "0".into()]),
            "libaom-av1" | "libvpx-vp9" => args.extend(["-lossless".into(), "1".into()]),
            _ => {}
        }
    } else if bitrate_mode {
        let kbps = options.video_bitrate.unwrap_or(8000.0).max(64.0);
        if hardware {
            if encoder.ends_with("_qsv") {
                args.extend(["-b:v".into(), format!("{kbps}k")]);
            } else if encoder.ends_with("_nvenc") {
                args.extend(["-rc".into(), "vbr".into(), "-b:v".into(), format!("{kbps}k")]);
            } else {
                args.extend(["-rc".into(), "vbr_peak".into(), "-b:v".into(), format!("{kbps}k")]);
            }
        } else {
            args.extend(["-b:v".into(), format!("{kbps}k")]);
        }
    } else if hardware {
        if encoder.ends_with("_nvenc") {
            args.extend(["-rc".into(), "vbr".into(), "-cq".into(), format!("{crf:.0}"), "-b:v".into(), "0".into()]);
        } else if encoder.ends_with("_qsv") {
            args.extend(["-global_quality".into(), format!("{crf:.0}"), "-look_ahead".into(), "1".into()]);
        } else {
            args.extend([
                "-rc".into(), "cqp".into(),
                "-qp_i".into(), format!("{crf:.0}"),
                "-qp_p".into(), format!("{crf:.0}"),
                "-qp_b".into(), format!("{crf:.0}"),
            ]);
        }
    } else if encoder == "libvpx-vp9" || encoder == "libaom-av1" {
        args.extend(["-crf".into(), format!("{crf:.0}"), "-b:v".into(), "0".into()]);
    } else {
        args.extend(["-crf".into(), format!("{crf:.0}")]);
    }

    args.extend(["-pix_fmt".into(), "yuv420p".into()]);
    if options.codec == "hevc" && (container == "mp4" || container == "mov") {
        args.extend(["-tag:v".into(), "hvc1".into()]);
    }

    let audio_codec = if container == "webm" { "libopus" } else { "aac" };
    args.extend([
        "-c:a".into(), audio_codec.into(),
        "-b:a".into(), format!("{}k", options.audio_bitrate.unwrap_or(192.0)),
    ]);

    let mut filters: Vec<String> = Vec::new();
    if let Some(width) = options.resolution.as_deref().filter(|r| *r != "source") {
        filters.push(format!("scale={width}:-2"));
    }
    filters.push("scale=trunc(iw/2)*2:trunc(ih/2)*2".into());
    args.extend(["-vf".into(), filters.join(",")]);
    if let Some(fps) = options.frame_rate.as_deref().filter(|r| *r != "source") {
        args.extend(["-r".into(), fps.into(), "-fps_mode".into(), "cfr".into()]);
    }

    args.extend(["-max_muxing_queue_size".into(), "1024".into()]);
    if container == "mp4" || container == "mov" {
        args.extend(["-movflags".into(), "+faststart".into()]);
    }
    args.extend(["-progress".into(), "pipe:1".into(), output.into()]);
    args
}

fn run_conversion(app: &AppHandle, options: Options) -> Result<Value, String> {
    let Some(ffmpeg) = find_ffmpeg() else {
        return Err("FFmpeg was not found on this PC. Install it or add it to PATH.".into());
    };
    let request_id = options.request_id.clone().unwrap_or_else(|| format!("req-{}", std::process::id()));
    let output = output_path(
        &options.input_path,
        options.output_dir.as_deref(),
        &options.codec,
        &options.container,
    );
    let _ = std::fs::remove_file(&output);

    let encoders = if options.audio_only.unwrap_or(false) {
        vec!["aac".to_string()]
    } else {
        candidates(&options.codec, options.hardware.unwrap_or(false))
    };
    if encoders.is_empty() {
        return Err(format!("This FFmpeg build has no {} encoder.", options.codec));
    }

    let mut last_error = String::new();
    for encoder in &encoders {
        let args = build_args(&options, encoder, &output);
        let mut child = Command::new(&ffmpeg)
            .args(&args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("Could not start FFmpeg: {error}"))?;

        if let Some(pid) = Some(child.id()) {
            children().lock().unwrap().insert(request_id.clone(), pid);
        }

        let stderr_handle = child.stderr.take();
        let stderr_thread = stderr_handle.map(|mut stderr| {
            std::thread::spawn(move || {
                let mut text = String::new();
                let _ = stderr.read_to_string(&mut text);
                text
            })
        });

        if let Some(stdout) = child.stdout.take() {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Some((key, value)) = line.split_once('=') {
                    if key == "out_time_us" || key == "out_time_ms" {
                        if let Ok(micros) = value.trim().parse::<f64>() {
                            let _ = app.emit(
                                "convert-progress",
                                json!({ "requestId": request_id, "seconds": micros / 1_000_000.0 }),
                            );
                        }
                    }
                }
            }
        }

        let status = child.wait().map_err(|error| format!("FFmpeg failed: {error}"))?;
        children().lock().unwrap().remove(&request_id);
        let stderr = stderr_thread.and_then(|handle| handle.join().ok()).unwrap_or_default();

        if cancelled().lock().unwrap().remove(&request_id) {
            let _ = std::fs::remove_file(&output);
            return Err("Conversion cancelled".into());
        }
        if status.success() {
            if let Ok(meta) = std::fs::metadata(&output) {
                if meta.len() > 0 {
                    return Ok(json!({
                        "outputPath": output,
                        "codec": options.codec,
                        "container": options.container,
                        "encoder": encoder,
                        "size": meta.len(),
                        "sizeLabel": human(meta.len()),
                    }));
                }
            }
        }
        last_error = stderr.lines().filter(|l| !l.trim().is_empty()).rev().take(3).collect::<Vec<_>>().join(" ");
        let _ = std::fs::remove_file(&output);
    }

    Err(if last_error.is_empty() {
        "FFmpeg could not finish this file".into()
    } else {
        last_error
    })
}

#[tauri::command]
async fn convert_video(app: AppHandle, options: Options) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || run_conversion(&app, options))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
fn cancel_convert(request_id: String) -> bool {
    if let Some(pid) = children().lock().unwrap().get(&request_id).copied() {
        cancelled().lock().unwrap().insert(request_id);
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output();
        return true;
    }
    false
}

/* --------------------------------------------------------------------- files & probing */

fn probe_media_impl(path: String) -> Value {
    let Some(ffmpeg) = find_ffmpeg() else {
        return json!({ "ok": false });
    };
    let Ok(out) = Command::new(&ffmpeg).args(["-hide_banner", "-i", &path]).output() else {
        return json!({ "ok": false });
    };
    let text = String::from_utf8_lossy(&out.stderr);
    let mut duration = 0.0;
    if let Some(pos) = text.find("Duration: ") {
        let stamp = &text[pos + 10..];
        if let Some(end) = stamp.find(',') {
            let parts: Vec<&str> = stamp[..end].trim().split(':').collect();
            if parts.len() == 3 {
                let hours: f64 = parts[0].parse().unwrap_or(0.0);
                let minutes: f64 = parts[1].parse().unwrap_or(0.0);
                let seconds: f64 = parts[2].parse().unwrap_or(0.0);
                duration = hours * 3600.0 + minutes * 60.0 + seconds;
            }
        }
    }
    let mut width = 0;
    let mut height = 0;
    let mut fps = 0.0;
    let mut has_audio = false;
    for line in text.lines() {
        if line.contains("Video:") {
            if let Some((w, h)) = line.split_whitespace().find_map(|token| {
                let mut parts = token.split('x');
                let w = parts.next()?.parse::<u32>().ok()?;
                let h = parts.next()?.trim_end_matches(',').parse::<u32>().ok()?;
                if w > 100 && h > 100 { Some((w, h)) } else { None }
            }) {
                width = w;
                height = h;
            }
            if let Some(index) = line.find(" fps") {
                let before = &line[..index];
                let number: String = before
                    .chars()
                    .rev()
                    .take_while(|c| c.is_ascii_digit() || *c == '.')
                    .collect::<String>()
                    .chars()
                    .rev()
                    .collect();
                fps = number.parse().unwrap_or(0.0);
            }
        }
        if line.contains("Audio:") {
            has_audio = true;
        }
    }
    json!({ "ok": width > 0 || has_audio, "duration": duration, "width": width, "height": height, "fps": fps, "hasAudio": has_audio })
}

#[tauri::command]
fn probe_media(path: String) -> Value {
    probe_media_impl(path)
}

#[tauri::command]
fn ffmpeg_info() -> Value {
    match find_ffmpeg() {
        Some(path) => json!({ "found": true, "path": path, "version": ffmpeg_version(&path) }),
        None => json!({ "found": false }),
    }
}

#[tauri::command]
fn stat_path(path: String) -> Value {
    match std::fs::metadata(&path) {
        Ok(meta) => json!({ "ok": true, "size": meta.len(), "sizeLabel": human(meta.len()) }),
        Err(error) => json!({ "ok": false, "error": error.to_string() }),
    }
}

const VIDEO_EXTENSIONS: &[&str] = &[
    "mp4", "m4v", "mkv", "mov", "webm", "avi", "wmv", "flv", "ts", "m2ts", "mts", "mpg",
    "mpeg", "3gp", "3g2", "ogv", "vob", "rm", "rmvb", "divx", "asf", "f4v",
];
const AUDIO_EXTENSIONS: &[&str] = &["mp3", "m4a", "aac", "flac", "wav", "ogg", "opus", "wma", "aiff"];

fn shortcuts() -> Vec<Value> {
    let mut list = Vec::new();
    for (label, key) in [
        ("Home", "USERPROFILE"),
        ("Desktop", "USERPROFILE"),
        ("Videos", "USERPROFILE"),
        ("Downloads", "USERPROFILE"),
        ("Pictures", "USERPROFILE"),
        ("Documents", "USERPROFILE"),
        ("Music", "USERPROFILE"),
    ] {
        let Ok(base) = std::env::var(key) else { continue };
        let path = match label {
            "Home" => PathBuf::from(&base),
            other => PathBuf::from(&base).join(other),
        };
        if path.exists() {
            list.push(json!({ "label": label, "path": path.to_string_lossy() }));
        }
    }
    list
}

#[tauri::command]
fn list_directory(path: String, include_non_video: Option<bool>) -> Value {
    let include = include_non_video.unwrap_or(false);
    let mut roots = Vec::new();
    for letter in b'A'..=b'Z' {
        let root = format!("{}:\\", letter as char);
        if Path::new(&root).exists() {
            roots.push(root);
        }
    }
    if path.trim().is_empty() {
        return json!({ "ok": true, "path": "", "parent": null, "roots": roots, "shortcuts": shortcuts(), "entries": [] });
    }

    let dir = PathBuf::from(&path);
    let parent = dir.parent().map(|p| p.to_string_lossy().to_string());
    let mut entries: Vec<Value> = Vec::new();
    if let Ok(read) = std::fs::read_dir(&dir) {
        for entry in read.flatten() {
            let entry_path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('$') || name == "System Volume Information" {
                continue;
            }
            if entry_path.is_dir() {
                entries.push(json!({ "name": name, "path": entry_path.to_string_lossy(), "type": "directory" }));
                continue;
            }
            let ext = entry_path
                .extension()
                .map(|e| e.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            let is_video = VIDEO_EXTENSIONS.contains(&ext.as_str());
            let is_audio = AUDIO_EXTENSIONS.contains(&ext.as_str());
            if !include && !is_video && !is_audio {
                continue;
            }
            let size = std::fs::metadata(&entry_path).map(|m| m.len()).unwrap_or(0);
            entries.push(json!({
                "name": name,
                "path": entry_path.to_string_lossy(),
                "type": if is_video { "video" } else if is_audio { "audio" } else { "file" },
                "size": size,
                "sizeLabel": human(size),
            }));
        }
    }
    entries.sort_by(|a, b| {
        let a_dir = a["type"] == "directory";
        let b_dir = b["type"] == "directory";
        b_dir.cmp(&a_dir).then_with(|| {
            a["name"].as_str().unwrap_or("").to_lowercase().cmp(&b["name"].as_str().unwrap_or("").to_lowercase())
        })
    });
    json!({ "ok": true, "path": path, "parent": parent, "roots": roots, "shortcuts": shortcuts(), "entries": entries })
}

#[tauri::command]
fn pick_file(app: AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .add_filter(
            "Video",
            &["mp4", "m4v", "mkv", "mov", "webm", "avi", "wmv", "flv", "ts", "m2ts", "mts", "mpg", "mpeg", "3gp", "ogv"],
        )
        .add_filter("All files", &["*"])
        .blocking_pick_file()
        .and_then(|path| path.into_path().ok())
        .map(|path| path.to_string_lossy().to_string())
}

#[tauri::command]
fn pick_folder(app: AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .blocking_pick_folder()
        .and_then(|path| path.into_path().ok())
        .map(|path| path.to_string_lossy().to_string())
}

#[tauri::command]
fn save_as(app: AppHandle, source: String, suggested_name: Option<String>) -> Option<String> {
    let name = suggested_name.unwrap_or_else(|| {
        Path::new(&source)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "converted.mp4".into())
    });
    let target = app
        .dialog()
        .file()
        .set_file_name(name)
        .blocking_save_file()
        .and_then(|path| path.into_path().ok())?;
    std::fs::copy(&source, &target).ok()?;
    Some(target.to_string_lossy().to_string())
}

#[tauri::command]
fn read_output(path: String) -> Vec<u8> {
    std::fs::read(path).unwrap_or_default()
}

#[tauri::command]
fn open_path(path: String) -> String {
    let _ = Command::new("explorer").arg(&path).spawn();
    String::new()
}

#[tauri::command]
fn show_item(path: String) -> bool {
    Command::new("explorer")
        .arg(format!("/select,{path}"))
        .spawn()
        .is_ok()
}

#[tauri::command]
fn app_info() -> Value {
    json!({
        "platform": std::env::consts::OS,
        "home": std::env::var("USERPROFILE").unwrap_or_default(),
        "bundled": cfg!(not(debug_assertions)),
        "share": false,
    })
}

/* --------------------------------------------------------------------------------- app */

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            app_info,
            ffmpeg_info,
            engine_state,
            first_run_ffmpeg,
            convert_video,
            cancel_convert,
            probe_media,
            stat_path,
            list_directory,
            pick_file,
            pick_folder,
            save_as,
            read_output,
            open_path,
            show_item,
        ])
        .setup(|app| {
            // Give the window a sane minimum and open it centred on the work area.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
            let _ = app;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running ConvZal");
}
