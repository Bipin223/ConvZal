const { app, BrowserWindow, ipcMain, session } = require('electron')
const { spawn } = require('node:child_process')
const fs = require('node:fs/promises')
const fsSync = require('node:fs')
const path = require('node:path')

const CODECS = {
  hevc: { encoders: ['libx265'] },
  avc: { encoders: ['libx264'] },
  av1: { encoders: ['libsvtav1', 'libaom-av1'] },
  vp9: { encoders: ['libvpx-vp9'] },
}

const CONTAINERS = { mp4: 'mp4', mkv: 'mkv', mov: 'mov', webm: 'webm' }

// Keeps the file written to disk named like the download the renderer offers (`*-h264.mp4`, not `*-avc.mp4`).
const CODEC_SLUGS = { hevc: 'hevc', avc: 'h264', av1: 'av1', vp9: 'vp9' }

// Containers and codecs must stay mutually valid, so anything unsupported falls back.
const CONTAINERS_BY_CODEC = {
  hevc: ['mp4', 'mkv', 'mov'],
  avc: ['mp4', 'mkv', 'mov'],
  av1: ['mp4', 'mkv', 'webm'],
  vp9: ['mkv', 'webm'],
}

const ENCODER_TUNING = {
  libx265: ['-preset', 'medium'],
  libx264: ['-preset', 'fast', '-profile:v', 'high'],
  libsvtav1: ['-preset', '8'],
  'libaom-av1': ['-cpu-used', '6', '-row-mt', '1'],
  'libvpx-vp9': ['-deadline', 'good', '-cpu-used', '2', '-row-mt', '1'],
}

function getFfmpegPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'ffmpeg', 'ffmpeg.exe')
  }
  return process.env.FFMPEG_PATH || 'ffmpeg'
}

function safeStem(filePath) {
  return path.basename(filePath).replace(/\.[^/.]+$/, '').replace(/[^a-z0-9_-]/gi, '_')
}

function resolveFormat(options) {
  const codec = CODECS[options.codec] ? options.codec : 'hevc'
  const container = CONTAINERS_BY_CODEC[codec].includes(options.container)
    ? options.container
    : CONTAINERS_BY_CODEC[codec][0]
  return { codec, container }
}

function getOutputPath(inputPath, codec, extension) {
  const slug = CODEC_SLUGS[codec] ?? codec
  return path.join(app.getPath('downloads'), `${safeStem(inputPath)}-${slug}.${extension}`)
}

// Odd frame sizes and 10-bit / 4:4:4 sources are the classic cause of HEVC files that a
// player shows as one frozen frame, so every encode is forced to even dimensions and 8-bit 4:2:0.
function buildScaleArgs(resolution) {
  const filters = resolution && resolution !== 'source' ? [`scale=${resolution}:-2`] : []
  filters.push('scale=trunc(iw/2)*2:trunc(ih/2)*2')
  return ['-vf', filters.join(',')]
}

function buildArgs(options, outputPath) {
  const isIsobmff = options.container === 'mp4' || options.container === 'mov'
  const args = ['-y', '-fflags', '+genpts', '-i', options.inputPath, '-map', '0:v:0', '-map', '0:a?']
  if (options.includeSubtitles) args.push('-map', '0:s?')
  args.push('-c:v', options.encoder)
  if (options.rateControl === 'bitrate') args.push('-b:v', `${options.videoBitrate}k`)
  else args.push('-crf', String(options.crf))
  args.push(...(ENCODER_TUNING[options.encoder] || []))
  args.push('-pix_fmt', 'yuv420p')
  // `hev1` boxes are rejected or mis-seeked by many players; `hvc1` is the compatible tag.
  if (options.codec === 'hevc' && isIsobmff) args.push('-tag:v', 'hvc1')
  args.push('-c:a', options.container === 'webm' ? 'libopus' : 'aac', '-b:a', `${options.audioBitrate}k`)
  if (options.includeSubtitles) args.push('-c:s', 'copy')
  args.push(...buildScaleArgs(options.resolution))
  if (options.frameRate && options.frameRate !== 'source') args.push('-r', String(options.frameRate), '-fps_mode', 'cfr')
  args.push('-max_muxing_queue_size', '1024')
  if (isIsobmff) args.push('-movflags', '+faststart')
  args.push('-progress', 'pipe:1', outputPath)
  return args
}

// Ordered fallback list: the requested codec first (with and without subtitle copy, because
// `-c:s copy` fails on some inputs), then a universal H.264/MP4 safety net.
function buildPlans(codec, container) {
  const plans = []
  const seen = new Set()
  const add = (nextCodec, nextContainer, nextEncoder, includeSubtitles) => {
    const key = `${nextEncoder}|${nextContainer}|${includeSubtitles}`
    if (seen.has(key)) return
    seen.add(key)
    plans.push({ codec: nextCodec, container: nextContainer, encoder: nextEncoder, includeSubtitles })
  }
  const keepSubtitles = container !== 'webm'
  for (const encoder of CODECS[codec].encoders) add(codec, container, encoder, keepSubtitles)
  for (const encoder of CODECS[codec].encoders) add(codec, container, encoder, false)
  if (codec !== 'avc' || container !== 'mp4') add('avc', 'mp4', 'libx264', false)
  return plans
}

function runFfmpeg(args, onProgress) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(getFfmpegPath(), args, { windowsHide: true })
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
    ffmpeg.on('error', (error) => reject(new Error(`Could not start FFmpeg: ${error.message}`)))
    ffmpeg.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(stderr.split('\n').filter(Boolean).slice(-3).join(' ') || `FFmpeg exited with code ${code}`))
    })
  })
}

async function convertVideo(event, options) {
  const requested = resolveFormat(options)
  const reportProgress = (seconds) => {
    if (!event.sender.isDestroyed()) event.sender.send('native-convert-progress', seconds)
  }
  let lastError
  for (const plan of buildPlans(requested.codec, requested.container)) {
    const outputPath = getOutputPath(options.inputPath, plan.codec, CONTAINERS[plan.container])
    await fs.rm(outputPath, { force: true })
    try {
      await runFfmpeg(
        buildArgs({
          ...options,
          codec: plan.codec,
          container: plan.container,
          encoder: plan.encoder,
          includeSubtitles: plan.includeSubtitles,
        }, outputPath),
        reportProgress,
      )
      if (fsSync.existsSync(outputPath)) return { outputPath, codec: plan.codec, container: plan.container }
      lastError = new Error('FFmpeg finished without writing an output file')
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error('FFmpeg could not convert this file')
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 980,
    minWidth: 960,
    minHeight: 720,
    backgroundColor: '#12101a',
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
  ipcMain.handle('native-convert', (event, options) => convertVideo(event, options))
  ipcMain.handle('read-output', async (_event, outputPath) => fs.readFile(outputPath))
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
