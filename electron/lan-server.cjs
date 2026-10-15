'use strict'

/* ===========================================================================
   ConvZal — "use it from your phone" server.

   A plain HTTP server that only exists while the desktop app has it switched
   on. It serves one small mobile page; a phone on the same Wi-Fi sends a video
   to it, the PC encodes the file with the very same native FFmpeg engine the
   app uses (hardware encoders first, software fallback), and the phone
   downloads the result. Nothing is uploaded anywhere: the bytes only cross the
   local network.

   Deliberately dependency-free: `node:http`, one temp folder, one file per
   job. Every job is cleaned up, and the whole temp folder goes when the server
   stops.
   =========================================================================== */

const http = require('node:http')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const DEFAULT_PORT = 5180
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024
// A finished file is kept this long so a phone that slept mid-download can still fetch it.
const OUTPUT_TTL_MS = 60 * 60 * 1000
const JOB_TTL_MS = 6 * 60 * 60 * 1000

const QUALITY_PRESETS = { smallest: 32, balanced: 23, quality: 18 }
const CODECS = new Set(['hevc', 'avc', 'av1', 'vp9'])
const MIME_TYPES = {
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
  m4a: 'audio/mp4',
}

/* ---------------------------------------------------------------- helpers */

function json(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body))
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
  })
  res.end(payload)
}

function humanBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${(bytes / 1024 ** exponent).toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`
}

// Downloaded names match what the desktop window writes (`clip-h264.mp4`, not
// `<job-id>-input.mp4`), so a phone download is recognisable in the gallery.
const CODEC_SLUGS = { hevc: 'hevc', avc: 'h264', av1: 'av1', vp9: 'vp9' }

function safeStem(name) {
  return path.basename(String(name)).replace(/\.[^/.]+$/, '').replace(/[^a-z0-9_-]/gi, '_').slice(0, 80) || 'video'
}

// FFmpeg's raw stderr is exactly right in a terminal and useless on a phone, so the
// failures a phone user can actually hit are turned into a sentence they can act on.
function friendlyError(message) {
  const text = String(message || '')
    .replace(/\[[^\]]*@\s*(0x)?[0-9a-f]+\]\s*/gi, '')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (/invalid data found|error opening input|does not contain any stream|moov atom not found|could not find codec parameters/i.test(text)) {
    return 'That file is not a video this PC can read'
  }
  if (/no space left|disk full|not enough space/i.test(text)) return 'That PC ran out of disk space'
  if (/permission denied|access is denied/i.test(text)) return 'That PC could not write the converted file'
  if (!text) return 'The conversion failed'
  return text.length > 200 ? `${text.slice(0, 200)}...` : text
}

// Content-Disposition has to stay ASCII-safe for older Android download managers, so the
// real name travels in the RFC 5987 field with a stripped fallback next to it.
function contentDisposition(name) {
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

// Adapters that never reach a phone are skipped: a virtual switch address would send the
// user to a URL that only resolves inside their own PC.
const VIRTUAL_ADAPTER = /virtual|vEthernet|vmware|virtualbox|hyper-v|loopback|docker|tailscale|zerotier|bluetooth/i

function lanAddresses() {
  const found = []
  const interfaces = os.networkInterfaces()
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      found.push({ name, address: entry.address })
    }
  }
  const score = (entry) => {
    let value = 0
    if (entry.address.startsWith('192.168.')) value += 3
    else if (entry.address.startsWith('10.')) value += 2
    else if (/^172\.(1[6-9]|2\d|3[01])\./.test(entry.address)) value += 2
    else value -= 2
    if (VIRTUAL_ADAPTER.test(entry.name)) value -= 5
    if (/wi-?fi|wlan|wireless|ethernet|eth/i.test(entry.name)) value += 1
    return value
  }
  return found.sort((a, b) => score(b) - score(a) || a.address.localeCompare(b.address))
}

function mimeFor(container) {
  return MIME_TYPES[container] || 'application/octet-stream'
}

/* ------------------------------------------------------------- phone page */

function pageHtml(info) {
  const computer = info.computer.replace(/[<>&"]/g, '')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0d0a15">
<meta name="robots" content="noindex">
<title>ConvZal</title>
<style>
  :root {
    --surface: #0d0a15;
    --card: #171125;
    --card-high: #1f1830;
    --on-surface: #f3eefb;
    --variant: #b6aecb;
    --faint: #8d86a0;
    --outline: rgba(255, 255, 255, .1);
    --accent: #9b4df4;
    --accent-container: #2a1a4d;
    --ok: #4ecb8d;
    --danger: #ff7096;
  }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  body {
    margin: 0; padding: 20px 16px calc(28px + env(safe-area-inset-bottom));
    background: radial-gradient(120% 80% at 50% 0%, #1b1130 0%, var(--surface) 55%);
    color: var(--on-surface); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    min-height: 100vh;
  }
  main { max-width: 460px; margin: 0 auto; display: flex; flex-direction: column; gap: 14px; }
  .badge {
    align-self: flex-start; padding: 4px 10px; border-radius: 999px; letter-spacing: .18em;
    font-size: 10px; font-weight: 700; color: #d9c4ff; background: var(--accent-container);
  }
  h1 { margin: 0; font-size: 22px; line-height: 1.2; letter-spacing: -.01em; }
  .sub { margin: 0; color: var(--variant); font-size: 13px; }
  .sub b { color: var(--on-surface); font-weight: 650; }
  .card { background: var(--card); border: 1px solid var(--outline); border-radius: 18px; padding: 14px; }
  .pick { display: flex; flex-direction: column; align-items: center; gap: 4px; text-align: center; cursor: pointer; }
  .pick strong { font-size: 16px; font-weight: 650; overflow-wrap: anywhere; }
  .pick small { color: var(--faint); font-size: 12px; }
  .pick-cta {
    margin-top: 8px; padding: 10px 18px; border-radius: 12px; font-weight: 650; font-size: 14px;
    color: #fff; background: linear-gradient(180deg, var(--accent), #7c3aed);
  }
  input[type=file] { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  label.field { display: grid; gap: 5px; }
  label.field span { color: var(--faint); font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; }
  select {
    width: 100%; padding: 10px; border-radius: 11px; font: inherit; font-size: 14px;
    color: var(--on-surface); background: var(--card-high); border: 1px solid var(--outline);
    appearance: none;
  }
  button {
    width: 100%; padding: 14px; border: 0; border-radius: 14px; font: inherit; font-size: 16px;
    font-weight: 700; color: #fff; background: linear-gradient(180deg, var(--accent), #7c3aed);
  }
  button:disabled { opacity: .45; }
  button.ghost { background: transparent; border: 1px solid var(--outline); color: var(--variant); font-weight: 600; }
  .bar { height: 8px; border-radius: 999px; background: var(--card-high); overflow: hidden; }
  .bar i { display: block; height: 100%; width: 100%; transform: scaleX(0); transform-origin: left;
    background: linear-gradient(90deg, var(--accent), #c084fc); transition: transform .25s ease-out; }
  .progress { display: flex; flex-direction: column; gap: 8px; }
  .progress p { margin: 0; font-size: 13px; color: var(--variant); }
  .clock { color: var(--faint); font-size: 12px; font-variant-numeric: tabular-nums; }
  .done { display: flex; flex-direction: column; gap: 10px; }
  .done strong { font-size: 16px; }
  .done small { color: var(--variant); font-size: 12.5px; }
  a.download {
    display: block; text-align: center; padding: 14px; border-radius: 14px; text-decoration: none;
    font-weight: 700; color: #072a1a; background: linear-gradient(180deg, #6ee0a8, var(--ok));
  }
  .note { margin: 0; color: var(--faint); font-size: 11.5px; text-align: center; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<main>
  <span class="badge">CONVZAL</span>
  <h1>Video and MP4 converter</h1>
  <p class="sub">Encoded by <b>${computer}</b> over your own Wi-Fi. The file is never uploaded to the internet.</p>

  <label class="card pick" for="file">
    <strong id="pick-title">Choose a video</strong>
    <small id="pick-sub">tap to browse this phone</small>
    <span class="pick-cta">Choose a file</span>
    <input id="file" type="file" accept="video/*,audio/*,.mp4,.mov,.mkv,.webm,.m4a,.3gp">
  </label>

  <div class="card grid">
    <label class="field"><span>Format</span>
      <select id="codec">
        <option value="hevc" selected>H.265 — smallest</option>
        <option value="avc">H.264 — plays anywhere</option>
        <option value="av1">AV1</option>
      </select>
    </label>
    <label class="field"><span>Quality</span>
      <select id="quality">
        <option value="smallest">Smallest</option>
        <option value="balanced" selected>Balanced</option>
        <option value="quality">Best</option>
      </select>
    </label>
    <label class="field"><span>Speed</span>
      <select id="speed">
        <option value="fast">Fastest</option>
        <option value="balanced" selected>Balanced</option>
        <option value="quality">Thorough</option>
      </select>
    </label>
    <label class="field"><span>Audio</span>
      <select id="audio">
        <option value="128">128 kbps</option>
        <option value="192" selected>192 kbps</option>
        <option value="256">256 kbps</option>
      </select>
    </label>
  </div>

  <button id="go" disabled>Convert</button>

  <section class="card progress" id="prog" hidden>
    <div class="bar"><i id="fill"></i></div>
    <p id="stat">…</p>
    <span class="clock" id="clock"></span>
    <button class="ghost" id="cancel">Cancel</button>
  </section>

  <section class="card done" id="result" hidden>
    <strong id="result-title">Done</strong>
    <small id="result-note"></small>
    <a class="download" id="dl" href="#">Download</a>
    <button class="ghost" id="again">Convert another video</button>
  </section>

  <p class="note">Keep this page open until the download starts.</p>
</main>
<script>
  var computer = ${JSON.stringify(computer)}
  var $ = function (id) { return document.getElementById(id) }
  var picked = null
  var jobId = null
  var poller = null
  var clock = null
  var startedAt = 0

  function humanSize(bytes) {
    var units = ['B', 'KB', 'MB', 'GB']
    var value = Number(bytes) || 0
    var index = 0
    while (value >= 1024 && index < units.length - 1) { value = value / 1024; index += 1 }
    return (index === 0 ? value : value.toFixed(1)) + ' ' + units[index]
  }

  function seconds() { return Math.round((Date.now() - startedAt) / 1000) }

  function showClock() { $('clock').textContent = 'Working for ' + seconds() + 's' }

  function setFill(ratio) {
    var value = Math.max(0, Math.min(1, ratio))
    $('fill').style.transform = 'scaleX(' + value + ')'
  }

  function setBusy(busy) {
    $('go').disabled = busy || !picked
    $('prog').hidden = !busy
    if (busy) { startedAt = Date.now(); clock = setInterval(showClock, 500); showClock() }
    else if (clock) { clearInterval(clock); clock = null }
  }

  function fail(message) {
    stopPolling()
    setBusy(false)
    $('prog').hidden = false
    $('cancel').hidden = true
    setFill(0)
    $('stat').textContent = message
    $('clock').textContent = ''
    jobId = null
  }

  function newJobId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID()
    return String(Date.now()) + '-' + Math.random().toString(16).slice(2, 10)
  }

  $('file').addEventListener('change', function (event) {
    var files = event.target.files
    picked = files && files.length ? files[0] : null
    if (!picked) return
    $('pick-title').textContent = picked.name
    $('pick-sub').textContent = humanSize(picked.size) + ' - tap to change'
    $('go').disabled = false
    $('result').hidden = true
    $('prog').hidden = true
  })

  $('go').addEventListener('click', function () {
    if (!picked || jobId) return
    jobId = newJobId()
    $('result').hidden = true
    $('cancel').hidden = false
    setBusy(true)
    $('stat').textContent = 'Sending to ' + computer + '...'
    setFill(0)

    var params = new URLSearchParams()
    params.set('job', jobId)
    params.set('name', picked.name)
    params.set('codec', $('codec').value)
    params.set('quality', $('quality').value)
    params.set('speed', $('speed').value)
    params.set('audio', $('audio').value)
    params.set('size', String(picked.size))

    var request = new XMLHttpRequest()
    request.open('POST', '/convert?' + params.toString())
    request.setRequestHeader('content-type', 'application/octet-stream')
    request.upload.addEventListener('progress', function (progressEvent) {
      if (!progressEvent.lengthComputable) return
      var ratio = progressEvent.loaded / progressEvent.total
      setFill(ratio)
      $('stat').textContent = 'Sending to ' + computer + '... ' + Math.round(ratio * 100) + '%'
    })
    request.addEventListener('load', function () {
      var payload = null
      try { payload = JSON.parse(request.responseText) } catch (error) { payload = null }
      if (!payload || !payload.ok) {
        fail((payload && payload.error) || 'The PC refused that file')
        return
      }
      $('stat').textContent = 'Queued on ' + computer + '...'
      setFill(0)
      poller = setInterval(poll, 800)
      poll()
    })
    request.addEventListener('error', function () { fail('Lost the connection to ' + computer) })
    request.addEventListener('abort', function () { fail('Cancelled') })
    request.send(picked)
  })

  function stopPolling() {
    if (poller) { clearInterval(poller); poller = null }
  }

  function poll() {
    if (!jobId) return
    fetch('/progress?job=' + jobId, { cache: 'no-store' }).then(function (response) {
      return response.json().then(function (job) { return { ok: response.ok, status: response.status, job: job } })
    }).then(function (result) {
      var job = result.job
      if (!result.ok) { fail(job && job.error ? job.error : 'The conversion stopped'); return }
      if (job.phase === 'done') { finish(job); return }
      if (job.phase === 'cancelled') { fail('Cancelled'); return }
      if (job.phase === 'error') { fail(job.message || 'The conversion failed'); return }
      if (job.phase === 'receiving') { $('stat').textContent = 'Receiving the file...'; return }
      setFill((job.percent || 0) / 100)
      $('stat').textContent = 'Encoding on ' + computer + '... ' + (job.percent || 0) + '%'
    }).catch(function () {
      fail('Lost the connection to ' + computer)
    })
  }

  function finish(job) {
    stopPolling()
    setBusy(false)
    setFill(1)
    $('cancel').hidden = true
    $('stat').textContent = 'Done'
    $('clock').textContent = ''
    $('result-title').textContent = job.sizeLabel + ' in ' + seconds() + 's'
    var note = job.codecName + ' - ' + job.containerName
    if (job.change) note = note + ' - ' + job.change
    $('result-note').textContent = note
    var link = $('dl')
    link.href = '/file?job=' + jobId
    link.setAttribute('download', job.name || 'converted.mp4')
    link.textContent = 'Download ' + (job.name || 'converted.mp4')
    $('result').hidden = false
    $('result').scrollIntoView({ behavior: 'smooth', block: 'center' })
    link.click()
    jobId = null
  }

  $('cancel').addEventListener('click', function () {
    var id = jobId
    if (!id) return
    jobId = null
    stopPolling()
    fetch('/cancel?job=' + id, { method: 'POST', cache: 'no-store' }).catch(function () {})
    setBusy(false)
    $('prog').hidden = true
    $('stat').textContent = ''
    $('go').disabled = !picked
  })

  // Second conversion in a row should not mean finding the settings again, and the phone
  // should hand back to the picker instead of leaving the previous result on screen.
  $('again').addEventListener('click', function () {
    $('result').hidden = true
    $('prog').hidden = true
    picked = null
    $('file').value = ''
    $('pick-title').textContent = 'Choose a video'
    $('pick-sub').textContent = 'tap to browse this phone'
    $('go').disabled = true
  })

  var SETTINGS_KEY = 'convzal-phone-settings'

  function settingsFields() { return ['codec', 'quality', 'speed', 'audio'] }

  function loadSettings() {
    var saved = {}
    try { saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') || {} } catch (error) { saved = {} }
    settingsFields().forEach(function (id) {
      var field = $(id)
      if (field && saved[id]) field.value = saved[id]
    })
  }

  function saveSettings() {
    var saved = {}
    settingsFields().forEach(function (id) { saved[id] = $(id).value })
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(saved)) } catch (error) { /* private mode */ }
  }

  loadSettings()
  settingsFields().forEach(function (id) { $(id).addEventListener('change', saveSettings) })
</script>
</body>
</html>
`
}

/* -------------------------------------------------------------- the server */

function createLanServer(handlers) {
  const { convert, cancel, probe, log = () => {} } = handlers
  const jobs = new Map()
  let server = null
  let listeningPort = 0
  let workDir = ''
  let janitor = null

  async function prepare() {
    if (!workDir) {
      workDir = path.join(os.tmpdir(), 'convzal-share')
      await fsp.mkdir(path.join(workDir, 'out'), { recursive: true })
    }
    return workDir
  }

  function state() {
    const addresses = lanAddresses()
    const best = addresses[0]
    return {
      running: Boolean(server),
      port: listeningPort || DEFAULT_PORT,
      url: server && best ? `http://${best.address}:${listeningPort}` : '',
      addresses: addresses.map((entry) => ({ name: entry.name, url: `http://${entry.address}:${listeningPort || DEFAULT_PORT}` })),
      jobCount: jobs.size,
    }
  }

  function publicJob(job) {
    if (!job) return null
    const payload = {
      id: job.id,
      phase: job.phase,
      percent: job.percent || 0,
      message: job.message || '',
      codecName: job.codecName || '',
      containerName: job.containerName || '',
    }
    if (job.phase === 'done') {
      payload.size = job.size
      payload.sizeLabel = job.sizeLabel
      payload.name = job.name
      payload.change = job.change
    }
    return payload
  }

  // The request body *is* the file: no multipart parsing, no buffering in memory beyond
  // the chunk being written. An aborted upload (phone locked, Wi-Fi dropped) deletes the
  // partial file instead of leaving it to be encoded.
  function receiveFile(req, targetPath) {
    return new Promise((resolve, reject) => {
      const out = fs.createWriteStream(targetPath)
      let bytes = 0
      let settled = false
      const fail = (error) => {
        if (settled) return
        settled = true
        out.destroy()
        reject(error)
      }
      req.on('data', (chunk) => {
        bytes += chunk.length
        if (bytes > MAX_UPLOAD_BYTES) {
          fail(Object.assign(new Error('That file is too big for the local server'), { code: 'TOO_BIG' }))
          req.destroy()
        }
      })
      req.on('aborted', () => fail(new Error('The upload was interrupted')))
      req.on('error', (error) => fail(error))
      out.on('error', (error) => fail(error))
      out.on('finish', () => {
        if (settled) return
        settled = true
        resolve(bytes)
      })
      req.pipe(out)
    })
  }

  async function runJob(job, settings) {
    try {
      job.phase = 'converting'
      const info = await probe(job.inputPath)
      job.duration = Number(info && info.duration) || 0
      const result = await convert({
        requestId: `share-${job.id}`,
        inputPath: job.inputPath,
        outputDir: path.join(workDir, 'out'),
        codec: settings.codec,
        container: settings.container,
        audioOnly: false,
        mode: 'crf',
        rateControl: 'crf',
        crf: settings.crf,
        videoBitrate: 0,
        audioBitrate: settings.audioBitrate,
        resolution: 'source',
        frameRate: 'source',
        speed: settings.speed,
        hardware: true,
      }, (seconds) => {
        if (job.duration > 0) job.percent = Math.max(1, Math.min(99, Math.round((seconds / job.duration) * 100)))
      })

      job.outputPath = result.outputPath
      job.size = result.size
      job.sizeLabel = result.sizeLabel || humanBytes(result.size)
      job.name = `${safeStem(job.originalName)}-${CODEC_SLUGS[result.codec] || result.codec}${path.extname(result.outputPath) || '.mp4'}`
      job.codecName = result.codec === 'hevc' ? 'H.265' : result.codec === 'avc' ? 'H.264' : String(result.codec).toUpperCase()
      job.containerName = String(result.container).toUpperCase()
      if (job.originalSize > 0 && result.size > 0) {
        const delta = Math.round(((result.size - job.originalSize) / job.originalSize) * 100)
        job.change = delta === 0 ? 'same size' : `${Math.abs(delta)}% ${delta < 0 ? 'smaller' : 'larger'}`
      }
      job.percent = 100
      job.phase = 'done'
      job.finishedAt = Date.now()
      log(`phone conversion done: ${job.name} (${job.sizeLabel}) via ${result.encoder}`)
    } catch (error) {
      job.phase = error && error.cancelled ? 'cancelled' : 'error'
      job.message = error && error.cancelled ? 'Cancelled' : friendlyError(error && error.message ? error.message : error)
      log(`phone conversion failed: ${job.message}`)
    } finally {
      if (job.inputPath) await fsp.rm(job.inputPath, { force: true }).catch(() => {})
      job.inputPath = ''
    }
  }

  async function handleConvert(req, res, url) {
    const jobId = String(url.searchParams.get('job') || '')
    if (!/^[A-Za-z0-9-]{6,80}$/.test(jobId)) return json(res, 400, { error: 'Invalid job id' })
    if (jobs.has(jobId)) return json(res, 409, { error: 'That job already exists' })

    const requestedCodec = String(url.searchParams.get('codec') || 'hevc')
    const codec = CODECS.has(requestedCodec) ? requestedCodec : 'hevc'
    const quality = String(url.searchParams.get('quality') || 'balanced')
    const speed = ['fast', 'balanced', 'quality'].includes(String(url.searchParams.get('speed')))
      ? String(url.searchParams.get('speed'))
      : 'balanced'
    const audioBitrate = [128, 192, 256].includes(Number(url.searchParams.get('audio')))
      ? Number(url.searchParams.get('audio'))
      : 192
    const originalName = decodeURIComponent(String(url.searchParams.get('name') || 'video.mp4')).slice(0, 180)

    const job = {
      id: jobId,
      phase: 'receiving',
      percent: 0,
      originalName,
      originalSize: Number(url.searchParams.get('size')) || 0,
      startedAt: Date.now(),
    }
    jobs.set(jobId, job)

    const extension = (path.extname(originalName) || '.mp4').toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 8) || '.mp4'
    job.inputPath = path.join(workDir, `${jobId}-input${extension}`)

    try {
      const bytes = await receiveFile(req, job.inputPath)
      if (bytes === 0) throw new Error('That request had no file in it')
      job.originalSize = job.originalSize || bytes
    } catch (error) {
      jobs.delete(jobId)
      await fsp.rm(job.inputPath, { force: true }).catch(() => {})
      return json(res, error && error.code === 'TOO_BIG' ? 413 : 400, { error: error.message })
    }

    // Answer now: the phone is free to poll while the PC encodes.
    json(res, 200, { ok: true, job: jobId })

    const container = codec === 'hevc' ? 'mp4' : codec === 'avc' ? 'mp4' : codec === 'av1' ? 'mp4' : 'mkv'
    void runJob(job, { codec, container, crf: QUALITY_PRESETS[quality] ?? 23, speed, audioBitrate })
  }

  async function handleFile(req, res, url) {
    const job = jobs.get(String(url.searchParams.get('job') || ''))
    if (!job || job.phase !== 'done' || !job.outputPath) return json(res, 404, { error: 'That file is no longer available' })
    const stats = await fsp.stat(job.outputPath).catch(() => null)
    if (!stats || stats.size === 0) return json(res, 404, { error: 'That file is gone' })
    res.writeHead(200, {
      'Content-Type': mimeFor(job.containerName ? job.containerName.toLowerCase() : 'mp4'),
      'Content-Length': stats.size,
      'Content-Disposition': contentDisposition(job.name || path.basename(job.outputPath)),
      'Cache-Control': 'no-store',
    })
    if (req.method === 'HEAD') { res.end(); return }
    const stream = fs.createReadStream(job.outputPath)
    stream.on('error', () => res.destroy())
    res.on('close', () => stream.destroy())
    stream.pipe(res)
    log(`phone download started: ${job.name}`)
  }

  function sweep() {
    const now = Date.now()
    for (const [id, job] of jobs) {
      const finishedAgo = job.finishedAt ? now - job.finishedAt : 0
      if (job.outputPath && job.finishedAt && finishedAgo > OUTPUT_TTL_MS) {
        void fsp.rm(job.outputPath, { force: true }).catch(() => {})
        job.outputPath = ''
      }
      if (now - job.startedAt > JOB_TTL_MS) jobs.delete(id)
    }
  }

  function listener() {
    return http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://localhost')
      Promise.resolve().then(async () => {
        if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
          const payload = Buffer.from(pageHtml({ computer: os.hostname() }))
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': payload.length, 'Cache-Control': 'no-store' })
          res.end(payload)
          return
        }
        if (url.pathname === '/health') return json(res, 200, { ok: true, port: listeningPort })
        if (req.method === 'POST' && url.pathname === '/convert') return handleConvert(req, res, url)
        if (req.method === 'POST' && url.pathname === '/cancel') {
          const jobId = String(url.searchParams.get('job') || '')
          const job = jobs.get(jobId)
          const cancelled = await cancel(`share-${jobId}`)
          if (job && !job.finishedAt) {
            job.phase = 'cancelled'
            job.finishedAt = Date.now()
          }
          return json(res, 200, { ok: true, cancelled })
        }
        if (url.pathname === '/progress') {
          const job = jobs.get(String(url.searchParams.get('job') || ''))
          if (!job) return json(res, 404, { error: 'That job is gone - start again' })
          return json(res, 200, publicJob(job))
        }
        if (url.pathname === '/file' && (req.method === 'GET' || req.method === 'HEAD')) return handleFile(req, res, url)
        return json(res, 404, { error: 'Not found' })
      }).catch((error) => {
        log(`share server error: ${error && error.message ? error.message : error}`)
        if (res.headersSent) res.destroy()
        else json(res, 500, { error: 'The local server hit an error' })
      })
    })
  }

  async function start(preferredPort = DEFAULT_PORT) {
    if (server) return state()
    await prepare()
    sweep()
    if (!janitor) janitor = setInterval(sweep, 60 * 1000)

    const base = Number(preferredPort) || DEFAULT_PORT
    let lastError = null
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const candidate = base + attempt
      const candidateServer = listener()
      try {
        await new Promise((resolve, reject) => {
          const onError = (error) => { candidateServer.removeListener('listening', onListening); reject(error) }
          const onListening = () => { candidateServer.removeListener('error', onError); resolve() }
          candidateServer.once('error', onError)
          candidateServer.once('listening', onListening)
          candidateServer.listen(candidate, '0.0.0.0')
        })
        server = candidateServer
        listeningPort = candidate
        break
      } catch (error) {
        lastError = error
        try { candidateServer.close() } catch { /* never listened */ }
        if (error && error.code !== 'EADDRINUSE') throw error
      }
    }
    if (!server) throw lastError || new Error('No free port on this PC')
    log(`sharing on http://0.0.0.0:${listeningPort}`)
    return state()
  }

  async function stop() {
    const active = server
    server = null
    listeningPort = 0
    if (janitor) { clearInterval(janitor); janitor = null }
    // cancelConversion answers with a boolean and never rejects, so this loop must not
    // assume a promise: throwing here used to abort the shutdown and leave the socket open.
    for (const jobId of jobs.keys()) {
      try { cancel(`share-${jobId}`) } catch { /* nothing running for that job */ }
    }
    jobs.clear()
    if (active) {
      await new Promise((resolve) => {
        if (typeof active.closeAllConnections === 'function') active.closeAllConnections()
        active.close(() => resolve())
        setTimeout(resolve, 1500)
      })
    }
    if (workDir) {
      const target = workDir
      workDir = ''
      await fsp.rm(target, { recursive: true, force: true }).catch(() => {})
    }
    log('sharing stopped')
    return state()
  }

  return { start, stop, state, lanAddresses }
}

module.exports = { createLanServer, lanAddresses, humanBytes }
