const { app, BrowserWindow, ipcMain, session, dialog, shell } = require('electron')
const { spawn } = require('node:child_process')
const fs = require('node:fs/promises')
const fsSync = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/* ==========================================================================
   Codec / container matrix
   ========================================================================== */

const CODECS = {
  hevc: { encoders: ['libx265'] },
  avc: { encoders: ['libx264'] },
  av1: { encoders: ['libsvtav1', 'libaom-av1'] },
  vp9: { encoders: ['libvpx-vp9'] },
}

const CONTAINERS = { mp4: 'mp4', mkv: 'mkv', mov: 'mov', webm: 'webm', m4a: 'm4a' }

// Keeps the file written to disk named like the download the renderer offers (`*-h264.mp4`, not `*-avc.mp4`).
const CODEC_SLUGS = { hevc: 'hevc', avc: 'h264', av1: 'av1', vp9: 'vp9', aac: 'audio' }

// Containers and codecs must stay mutually valid, so anything unsupported falls back.
const CONTAINERS_BY_CODEC = {
  hevc: ['mp4', 'mkv', 'mov'],
  avc: ['mp4', 'mkv', 'mov'],
  av1: ['mp4', 'mkv', 'webm'],
  vp9: ['mkv', 'webm'],
}

const SOFTWARE_ENCODER = { hevc: 'libx265', avc: 'libx264', av1: 'libsvtav1', vp9: 'libvpx-vp9' }

// GPU encoders are tried first (when the user opts in and the hardware answers a
// probe), then the software encoder is the guaranteed fallback. Hardware is never
// used for lossless, where only the software encoders give a bit-exact result.
const HARDWARE_ENCODERS = {
  hevc: ['hevc_nvenc', 'hevc_qsv', 'hevc_amf'],
  avc: ['h264_nvenc', 'h264_qsv', 'h264_amf'],
  av1: ['av1_nvenc', 'av1_qsv'],
  vp9: [],
}

// `speed` maps onto whatever knob each encoder actually exposes.
const SOFTWARE_PRESETS = {
  libx265: { fast: 'faster', balanced: 'medium', quality: 'slow' },
  libx264: { fast: 'veryfast', balanced: 'medium', quality: 'slow' },
  libsvtav1: { fast: '10', balanced: '8', quality: '6' },
  'libaom-av1': { fast: '4', balanced: '2', quality: '0' },
  'libvpx-vp9': { fast: '4', balanced: '2', quality: '1' },
}

const HARDWARE_PRESETS = {
  hevc_nvenc: { fast: 'p4', balanced: 'p5', quality: 'p7' },
  h264_nvenc: { fast: 'p4', balanced: 'p5', quality: 'p7' },
  av1_nvenc: { fast: 'p4', balanced: 'p5', quality: 'p7' },
  hevc_qsv: { fast: 'veryfast', balanced: 'medium', quality: 'slow' },
  h264_qsv: { fast: 'veryfast', balanced: 'medium', quality: 'slow' },
  av1_qsv: { fast: 'veryfast', balanced: 'medium', quality: 'slow' },
  hevc_amf: { fast: 'speed', balanced: 'balanced', quality: 'quality' },
  h264_amf: { fast: 'speed', balanced: 'balanced', quality: 'quality' },
}

const SUBTITLE_CAPABLE = new Set(['mp4', 'mkv', 'mov'])

/* ==========================================================================
   Paths
   ========================================================================== */

function getFfmpegPath() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'ffmpeg', 'ffmpeg.exe')
  return process.env.FFMPEG_PATH || 'ffmpeg'
}

function safeStem(filePath) {
  return path.basename(filePath).replace(/\.[^/.]+$/, '').replace(/[^a-z0-9_-]/gi, '_')
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${(bytes / 1024 ** exponent).toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`
}

function resolveFormat(options) {
  const codec = CODECS[options.codec] ? options.codec : 'hevc'
  const container = CONTAINERS_BY_CODEC[codec].includes(options.container)
    ? options.container
    : CONTAINERS_BY_CODEC[codec][0]
  return { codec, container }
}

// Writes next to the source by default, and never overwrites either the source
// itself or a previous conversion of a different codec.
function resolveOutputPath(inputPath, outputDir, codec, extension) {
  const slug = CODEC_SLUGS[codec] ?? codec
  const stem = safeStem(inputPath)
  const directory = outputDir && String(outputDir).trim() ? outputDir : path.dirname(inputPath)

  let candidate = path.join(directory, `${stem}-${slug}.${extension}`)
  if (path.resolve(candidate) === path.resolve(inputPath)) {
    candidate = path.join(directory, `${stem}-${slug}-out.${extension}`)
  }
  return candidate
}

/* ==========================================================================
   FFmpeg arg builders
   ========================================================================== */

// Odd frame sizes and 10-bit / 4:4:4 sources are the classic cause of HEVC files that a
// player shows as one frozen frame, so every encode is forced to even dimensions and 8-bit 4:2:0.
function buildScaleArgs(resolution) {
  const filters = []
  if (resolution && resolution !== 'source') filters.push(`scale=${resolution}:-2`)
  filters.push('scale=trunc(iw/2)*2:trunc(ih/2)*2')
  return ['-vf', filters.join(',')]
}

function buildVideoArgs(codec, encoder, options) {
  const isHardware = Boolean(HARDWARE_PRESETS[encoder])
  const args = ['-c:v', encoder]
  const preset = isHardware
    ? HARDWARE_PRESETS[encoder][options.speed]
    : SOFTWARE_PRESETS[encoder]?.[options.speed]
  const mode = options.mode === 'lossless' ? 'lossless' : options.rateControl

  if (isHardware) {
    if (preset) args.push('-preset', preset)
    if (mode === 'bitrate') {
      args.push('-rc', 'vbr', '-b:v', `${options.videoBitrate}k`)
    } else if (encoder.endsWith('_nvenc')) {
      args.push('-rc', 'vbr', '-cq', String(options.crf), '-b:v', '0')
    } else if (encoder.endsWith('_qsv')) {
      args.push('-global_quality', String(options.crf), '-look_ahead', '1')
    } else if (encoder.endsWith('_amf')) {
      args.push('-rc', 'cqp', '-qp_i', String(options.crf), '-qp_p', String(options.crf), '-qp_b', String(options.crf))
    }
    return args
  }

  switch (encoder) {
    case 'libx265':
      if (preset) args.push('-preset', preset)
      if (mode === 'lossless') args.push('-x265-params', 'lossless=1')
      else if (mode === 'bitrate') args.push('-b:v', `${options.videoBitrate}k`)
      else args.push('-crf', String(options.crf))
      break
    case 'libx264':
      if (preset) args.push('-preset', preset)
      args.push('-profile:v', 'high')
      if (mode === 'lossless') args.push('-qp', '0')
      else if (mode === 'bitrate') args.push('-b:v', `${options.videoBitrate}k`)
      else args.push('-crf', String(options.crf))
      break
    case 'libsvtav1':
      if (preset) args.push('-preset', preset)
      if (mode === 'lossless') args.push('-crf', '0')
      else if (mode === 'bitrate') args.push('-b:v', `${options.videoBitrate}k`)
      else args.push('-crf', String(options.crf))
      break
    case 'libaom-av1':
      args.push('-cpu-used', preset || '6', '-row-mt', '1')
      if (mode === 'lossless') args.push('-lossless', '1')
      else if (mode === 'bitrate') args.push('-b:v', `${options.videoBitrate}k`)
      else args.push('-crf', String(options.crf), '-b:v', '0')
      break
    case 'libvpx-vp9':
      args.push('-deadline', options.speed === 'fast' ? 'realtime' : 'good', '-cpu-used', preset || '2', '-row-mt', '1')
      if (mode === 'lossless') args.push('-lossless', '1')
      else if (mode === 'bitrate') args.push('-b:v', `${options.videoBitrate}k`)
      // VP9 ignores -crf unless the bitrate target is explicitly lifted.
      else args.push('-crf', String(options.crf), '-b:v', '0')
      break
    default:
      break
  }
  return args
}

function buildArgs(options, codec, container, encoder) {
  const isIsobmff = container === 'mp4' || container === 'mov'
  // `0:V:0` selects the first *real* video stream: a cover-art / attached-picture stream
  // ordered first would otherwise be mapped and the whole output would be one frozen frame.
  const args = ['-y', '-nostdin', '-fflags', '+genpts', '-i', options.inputPath, '-map', '0:V:0', '-map', '0:a?']
  if (options.includeSubtitles) args.push('-map', '0:s?')
  args.push(...buildVideoArgs(codec, encoder, options))
  args.push('-pix_fmt', 'yuv420p')
  // `hev1` boxes are rejected or mis-seeked by many players; `hvc1` is the compatible tag.
  if (codec === 'hevc' && isIsobmff) args.push('-tag:v', 'hvc1')
  args.push('-c:a', container === 'webm' ? 'libopus' : 'aac', '-b:a', `${options.audioBitrate}k`)
  if (options.includeSubtitles) args.push('-c:s', 'copy')
  args.push(...buildScaleArgs(options.resolution))
  if (options.frameRate && options.frameRate !== 'source') args.push('-r', String(options.frameRate), '-fps_mode', 'cfr')
  // Zero interleave delay keeps the muxer from holding packets until a full queue builds up.
  args.push('-max_muxing_queue_size', '1024', '-max_interleave_delta', '0')
  if (isIsobmff) args.push('-movflags', '+faststart')
  args.push('-progress', 'pipe:1', options.outputPath)
  return args
}

// Audio-only path: pull the first real audio stream out to AAC and drop the video.
// `-map 0:a:0` also skips any attached-picture stream that might be ordered first.
function buildAudioArgs(options) {
  return [
    '-y', '-nostdin', '-i', options.inputPath,
    '-map', '0:a:0', '-vn',
    '-c:a', 'aac', '-b:a', `${options.audioBitrate}k`,
    '-movflags', '+faststart',
    '-progress', 'pipe:1', options.outputPath,
  ]
}

/* ==========================================================================
   Hardware probing
   ========================================================================== */

let hardwareCache = null

function ffmpegSupportsEncoder(encoder) {
  return new Promise((resolve) => {
    const probe = spawn(getFfmpegPath(), [
      '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
      '-i', 'nullsrc=s=128x128:d=0.2', '-frames:v', '1', '-pix_fmt', 'yuv420p',
      '-c:v', encoder, '-f', 'null', '-',
    ], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] })
    let settled = false
    const timer = setTimeout(() => { try { probe.kill() } catch { /* gone */ } done(false) }, 15000)
    function done(ok) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      probe.removeAllListeners()
      resolve(ok)
    }
    probe.on('error', () => done(false))
    probe.on('close', (code) => done(code === 0))
  })
}

async function detectHardware() {
  if (hardwareCache) return hardwareCache
  const candidates = new Set()
  for (const list of Object.values(HARDWARE_ENCODERS)) for (const encoder of list) candidates.add(encoder)
  const result = {}
  await Promise.all([...candidates].map(async (encoder) => { result[encoder] = await ffmpegSupportsEncoder(encoder) }))
  hardwareCache = result
  return result
}

function encoderCandidates(codec, hardware, detected) {
  const software = SOFTWARE_ENCODER[codec]
  if (!hardware) return [software]
  const gpu = (HARDWARE_ENCODERS[codec] || []).filter((encoder) => detected[encoder])
  return gpu.length ? [...gpu, software] : [software]
}

/* ==========================================================================
   Plan building
   ========================================================================== */

// Ordered fallback list: the requested codec first (with and without subtitle copy, because
// `-c:s copy` fails on some inputs), then a universal H.264/MP4 safety net.
function buildPlans(options, detected) {
  const requested = resolveFormat(options)
  const plans = []
  const seen = new Set()
  const add = (codec, container, encoder, includeSubtitles) => {
    const key = `${encoder}|${container}|${includeSubtitles}`
    if (seen.has(key)) return
    seen.add(key)
    plans.push({ codec, container, encoder, includeSubtitles })
  }

  const keepSubtitles = SUBTITLE_CAPABLE.has(requested.container)
  const lossless = options.mode === 'lossless'
  for (const encoder of encoderCandidates(requested.codec, options.hardware && !lossless, detected)) {
    add(requested.codec, requested.container, encoder, keepSubtitles)
  }
  for (const encoder of encoderCandidates(requested.codec, false, detected)) {
    add(requested.codec, requested.container, encoder, false)
  }
  if (requested.codec !== 'avc' || requested.container !== 'mp4') add('avc', 'mp4', 'libx264', false)
  return plans
}

/* ==========================================================================
   Running FFmpeg
   ========================================================================== */

const activeConversions = new Map()

function runFfmpeg(args, requestId, onProgress) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(getFfmpegPath(), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let cancelled = false
    if (requestId) activeConversions.set(requestId, Object.assign(ffmpeg, {
      __cancel: () => { cancelled = true; try { ffmpeg.kill('SIGKILL') } catch { /* gone */ } },
    }))

    let stderr = ''
    let stdoutBuffer = ''

    // FFmpeg writes `-progress` data to stdout and that pipe must always be drained. Once
    // the OS buffer fills up, FFmpeg blocks forever waiting for a reader and the encode
    // looks frozen - this was the HEVC hang.
    ffmpeg.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString()
      const lines = stdoutBuffer.split(/\r?\n/)
      stdoutBuffer = lines.pop() || ''
      for (const line of lines) {
        const [key, value] = line.split('=')
        if (key !== 'out_time_us' && key !== 'out_time_ms') continue
        const seconds = Number(value) / 1e6
        if (Number.isFinite(seconds)) onProgress(seconds)
      }
    })
    ffmpeg.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
      if (stderr.length > 32000) stderr = stderr.slice(-32000)
    })
    ffmpeg.on('error', (error) => {
      if (requestId) activeConversions.delete(requestId)
      reject(new Error(`Could not start FFmpeg: ${error.message}`))
    })
    ffmpeg.on('close', (code) => {
      if (requestId) activeConversions.delete(requestId)
      if (cancelled) { reject(Object.assign(new Error('Conversion cancelled'), { cancelled: true })); return }
      if (code === 0) resolve()
      else reject(new Error(stderr.split('\n').filter(Boolean).slice(-3).join(' ') || `FFmpeg exited with code ${code}`))
    })

    if (requestId) {
      const cancel = () => { cancelled = true; try { ffmpeg.kill('SIGKILL') } catch { /* gone */ } }
      activeConversions.set(requestId, Object.assign(ffmpeg, { __cancel: cancel }))
    }
  })
}

function cancelConversion(requestId) {
  const child = activeConversions.get(requestId)
  if (!child) return false
  if (typeof child.__cancel === 'function') child.__cancel()
  else { try { child.kill('SIGKILL') } catch { /* gone */ } }
  return true
}

/* ==========================================================================
   Conversion
   ========================================================================== */

async function convertVideo(event, options) {
  const requestId = options.requestId || `req-${Date.now()}`
  const requested = resolveFormat(options)
  const reportProgress = (seconds) => {
    if (!requestId) return
    if (!event.sender.isDestroyed()) event.sender.send('native-convert-progress', { requestId, seconds })
  }

  const detected = options.hardware ? await detectHardware() : {}
  const plans = buildPlans({ ...options, ...requested }, detected)

  // Write beside the source (or in the chosen folder) when possible, otherwise fall
  // back to the Downloads folder rather than failing on a read-only location.
  let baseDir = options.outputDir && String(options.outputDir).trim() ? options.outputDir : path.dirname(options.inputPath)
  try {
    await fs.access(baseDir, fsSync.constants.W_OK)
  } catch {
    baseDir = app.getPath('downloads')
  }

  // Audio-only is a single encoder (AAC in an `.m4a`), so it skips the plan chain.
  if (options.audioOnly) {
    const outputPath = resolveOutputPath(options.inputPath, baseDir, 'aac', CONTAINERS.m4a)
    await fs.rm(outputPath, { force: true }).catch(() => {})
    await fs.mkdir(path.dirname(outputPath), { recursive: true }).catch(() => {})
    await runFfmpeg(buildAudioArgs({ ...options, outputPath }), requestId, reportProgress)
    const stats = await fs.stat(outputPath).catch(() => null)
    if (!stats || stats.size === 0) throw new Error('FFmpeg finished without writing an audio file')
    return { outputPath, codec: 'aac', container: 'm4a', encoder: 'aac', size: stats.size, sizeLabel: formatBytes(stats.size) }
  }

  let lastError
  for (const plan of plans) {
    const outputPath = resolveOutputPath(options.inputPath, baseDir, plan.codec, CONTAINERS[plan.container])
    await fs.rm(outputPath, { force: true }).catch(() => {})
    await fs.mkdir(path.dirname(outputPath), { recursive: true }).catch(() => {})
    try {
      await runFfmpeg(
        buildArgs(
          { ...options, ...requested, outputPath },
          plan.codec,
          plan.container,
          plan.encoder,
        ),
        requestId,
        reportProgress,
      )
      const stats = await fs.stat(outputPath).catch(() => null)
      if (stats && stats.size > 0) {
        return {
          outputPath,
          codec: plan.codec,
          container: plan.container,
          encoder: plan.encoder,
          size: stats.size,
          sizeLabel: formatBytes(stats.size),
        }
      }
      lastError = new Error('FFmpeg finished without writing an output file')
    } catch (error) {
      if (error && error.cancelled) throw error
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error('FFmpeg could not convert this file')
}

/* ==========================================================================
   Media probing
   ========================================================================== */

// `ffmpeg -i <file>` prints the stream table to stderr and exits with code 1 on
// success, which is the cheapest way to read duration/resolution for a path the
// renderer cannot open as a File (a folder-browser pick, for instance).
function probeMediaFile(filePath) {
  return new Promise((resolve) => {
    let stderr = ''
    let child
    try {
      child = spawn(getFfmpegPath(), ['-hide_banner', '-i', filePath], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    } catch {
      resolve({ ok: false })
      return
    }
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
      if (stderr.length > 128000) stderr = stderr.slice(-128000)
    })
    child.on('error', () => resolve({ ok: false }))
    child.on('close', () => {
      const durationMatch = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
      const duration = durationMatch
        ? Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + parseFloat(durationMatch[3])
        : 0
      const videoLine = stderr.split('\n').find((line) => /Stream #\d+:\d+.*Video:/.test(line))
      let width = 0
      let height = 0
      let fps = 0
      if (videoLine) {
        const dimensions = videoLine.match(/(\d{2,5})x(\d{2,5})/)
        if (dimensions) { width = Number(dimensions[1]); height = Number(dimensions[2]) }
        const frameRate = videoLine.match(/([\d.]+)\s*fps/)
        if (frameRate) fps = parseFloat(frameRate[1])
      }
      const hasAudio = /Stream #\d+:\d+.*Audio:/.test(stderr)
      // Audio-only sources (`.m4a`, `.mp3`) have no video line but are still valid input.
      resolve({ ok: videoLine !== undefined || hasAudio, duration, width, height, fps, hasAudio })
    })
  })
}

/* ==========================================================================
   Filesystem browser
   ========================================================================== */

const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.m4v', '.mkv', '.mov', '.webm', '.avi', '.wmv', '.flv', '.ts', '.m2ts', '.mts',
  '.mpg', '.mpeg', '.3gp', '.3g2', '.ogv', '.vob', '.rm', '.rmvb', '.divx', '.asf', '.f4v',
])

const AUDIO_EXTENSIONS = new Set(['.mp3', '.m4a', '.aac', '.flac', '.wav', '.ogg', '.opus', '.wma', '.aiff'])

function listDrives() {
  const drives = []
  for (let code = 65; code <= 90; code += 1) {
    const letter = String.fromCharCode(code)
    const root = `${letter}:\\`
    try { if (fsSync.existsSync(root)) drives.push(root) } catch { /* not present */ }
  }
  return drives
}

function quickLinks() {
  const known = [
    ['Home', 'home'], ['Desktop', 'desktop'], ['Videos', 'videos'],
    ['Downloads', 'downloads'], ['Pictures', 'pictures'], ['Documents', 'documents'], ['Music', 'music'],
  ]
  const links = []
  for (const [label, key] of known) {
    try {
      const target = app.getPath(key)
      if (target && fsSync.existsSync(target)) links.push({ label, path: target })
    } catch { /* path unavailable */ }
  }
  return links
}

async function listDirectory(targetPath, includeNonVideo) {
  if (!targetPath) {
    return {
      path: '',
      parent: null,
      roots: listDrives(),
      shortcuts: quickLinks(),
      entries: [],
    }
  }

  const resolved = path.resolve(targetPath)
  const entries = await fs.readdir(resolved, { withFileTypes: true })
  const mapped = []
  for (const entry of entries) {
    if (entry.name.startsWith('$') || entry.name === 'System Volume Information') continue
    const full = path.join(resolved, entry.name)
    if (entry.isDirectory()) {
      mapped.push({ name: entry.name, path: full, type: 'directory' })
      continue
    }
    const extension = path.extname(entry.name).toLowerCase()
    const isVideo = VIDEO_EXTENSIONS.has(extension)
    const isAudio = AUDIO_EXTENSIONS.has(extension)
    if (!includeNonVideo && !isVideo && !isAudio) continue
    let size = 0
    try { size = (await fs.stat(full)).size } catch { size = 0 }
    mapped.push({ name: entry.name, path: full, type: isVideo ? 'video' : isAudio ? 'audio' : 'file', size, sizeLabel: formatBytes(size) })
  }

  mapped.sort((a, b) => {
    if (a.type === 'directory' && b.type !== 'directory') return -1
    if (b.type === 'directory' && a.type !== 'directory') return 1
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  })

  const parsed = path.parse(resolved)
  const parent = resolved === parsed.root ? null : path.dirname(resolved)
  const driveRoots = listDrives()

  return {
    path: resolved,
    parent,
    root: parsed.root,
    roots: resolved === parsed.root ? driveRoots : [],
    shortcuts: quickLinks(),
    entries: mapped.slice(0, 4000),
  }
}

/* ==========================================================================
   IPC
   ========================================================================== */

function registerIpc() {
  ipcMain.handle('native-convert', (event, options) => convertVideo(event, options))
  ipcMain.handle('native-convert-cancel', (_event, requestId) => cancelConversion(requestId))
  ipcMain.handle('read-output', async (_event, outputPath) => fs.readFile(outputPath))

  ipcMain.handle('fs:list', async (_event, targetPath, includeNonVideo) => {
    try {
      return { ok: true, ...(await listDirectory(targetPath, Boolean(includeNonVideo))) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('fs:pick-file', async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const options = {
      title: 'Choose a video',
      properties: ['openFile'],
      filters: [
        { name: 'Video', extensions: ['mp4', 'm4v', 'mkv', 'mov', 'webm', 'avi', 'wmv', 'flv', 'ts', 'm2ts', 'mts', 'mpg', 'mpeg', '3gp', 'ogv'] },
        { name: 'All files', extensions: ['*'] },
      ],
    }
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('fs:pick-folder', async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const options = {
      title: 'Choose an output folder',
      properties: ['openDirectory', 'createDirectory'],
    }
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('media:probe', (_event, targetPath) => probeMediaFile(targetPath))

  ipcMain.handle('fs:stat', async (_event, targetPath) => {
    try {
      const stats = await fs.stat(targetPath)
      return { ok: true, size: stats.size, sizeLabel: formatBytes(stats.size) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('shell:open-path', async (_event, targetPath) => shell.openPath(targetPath))
  ipcMain.handle('shell:show-item', (_event, targetPath) => { shell.showItemInFolder(targetPath); return true })

  ipcMain.handle('fs:save-as', async (event, sourcePath, suggestedName) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const options = {
      title: 'Save a copy',
      defaultPath: path.join(path.dirname(sourcePath), suggestedName || path.basename(sourcePath)),
    }
    const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null
    await fs.copyFile(sourcePath, result.filePath)
    return result.filePath
  })

  ipcMain.handle('app:info', () => ({
    platform: process.platform,
    home: os.homedir(),
    bundled: app.isPackaged,
  }))
}

/* ==========================================================================
   Window
   ========================================================================== */

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 980,
    minWidth: 960,
    minHeight: 720,
    backgroundColor: '#0d0a15',
    title: 'ConvZal',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  const devUrl = process.env.ELECTRON_START_URL
  if (devUrl) window.loadURL(devUrl)
  else window.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  registerIpc()
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
