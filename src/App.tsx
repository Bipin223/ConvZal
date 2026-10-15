import { useRef, useState, type CSSProperties } from 'react'
import { FFmpeg } from '@ffmpeg/ffmpeg'
import { fetchFile, toBlobURL } from '@ffmpeg/util'
import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  canEncodeVideo,
  Conversion,
  Input,
  MkvOutputFormat,
  MovOutputFormat,
  Mp4OutputFormat,
  type OutputFormat,
  Output,
  Quality,
  WebMOutputFormat,
} from 'mediabunny'
import './App.css'

declare global {
  interface Window {
    desktopAPI?: {
      getPathForFile: (file: File) => string
      convertVideo: (options: Record<string, string | number>) => Promise<{ outputPath: string; codec: string; container: string }>
      readOutput: (outputPath: string) => Promise<Uint8Array>
      onConvertProgress?: (callback: (seconds: number) => void) => () => void
    }
  }
}

type BrowserRecordingResult = { blob: Blob; mimeType: string }
type CodecId = 'hevc' | 'avc' | 'av1' | 'vp9'
type ContainerId = 'mp4' | 'mkv' | 'mov' | 'webm'
type RateControl = 'crf' | 'bitrate'
type QualityPreset = 'smallest' | 'balanced' | 'quality'

const CODEC_ORDER: CodecId[] = ['hevc', 'avc', 'av1', 'vp9']
const CONTAINER_ORDER: ContainerId[] = ['mp4', 'mkv', 'mov', 'webm']

const CODECS: Record<CodecId, {
  label: string
  name: string
  slug: string
  containers: ContainerId[]
  encoders: string[]
}> = {
  hevc: { label: 'H.265 / HEVC', name: 'HEVC', slug: 'hevc', containers: ['mp4', 'mkv', 'mov'], encoders: ['libx265'] },
  avc: { label: 'H.264 / AVC', name: 'H.264', slug: 'h264', containers: ['mp4', 'mkv', 'mov'], encoders: ['libx264'] },
  av1: { label: 'AV1', name: 'AV1', slug: 'av1', containers: ['mp4', 'mkv', 'webm'], encoders: ['libsvtav1', 'libaom-av1'] },
  vp9: { label: 'VP9', name: 'VP9', slug: 'vp9', containers: ['mkv', 'webm'], encoders: ['libvpx-vp9'] },
}

const CONTAINERS: Record<ContainerId, { label: string; extension: string; mimeType: string }> = {
  mp4: { label: 'MP4', extension: 'mp4', mimeType: 'video/mp4' },
  mkv: { label: 'MKV', extension: 'mkv', mimeType: 'video/x-matroska' },
  mov: { label: 'MOV', extension: 'mov', mimeType: 'video/quicktime' },
  webm: { label: 'WebM', extension: 'webm', mimeType: 'video/webm' },
}

// Per-encoder speed/quality trade-offs. Without these FFmpeg falls back to defaults
// that are either glacial (libx265 at medium preset) or noticeably worse per byte.
const ENCODER_TUNING: Record<string, string[]> = {
  libx265: ['-preset', 'medium'],
  libx264: ['-preset', 'fast', '-profile:v', 'high'],
  libsvtav1: ['-preset', '8'],
  'libaom-av1': ['-cpu-used', '6', '-row-mt', '1'],
  'libvpx-vp9': ['-deadline', 'good', '-cpu-used', '2', '-row-mt', '1'],
}

// MediaRecorder cannot mux every codec into every container, so each container maps to
// the recorder mime types the browser can actually produce inside that container.
const RECORDER_MIME_TYPES: Record<ContainerId, string[]> = {
  mp4: ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4'],
  mov: ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4'],
  mkv: ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'],
  webm: ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'],
}

const CRF_BY_PRESET: Record<QualityPreset, number> = { smallest: 30, balanced: 23, quality: 18 }

// MediaRecorder has no CRF knob, so the preset is translated into a bits-per-pixel target.
// Without this the recorder wrote one flat bitrate and the Compression choice did nothing.
const RECORDER_BITS_PER_PIXEL: Record<QualityPreset, number> = { smallest: 0.045, balanced: 0.09, quality: 0.15 }

const QUALITY_ORDER: QualityPreset[] = ['smallest', 'balanced', 'quality']
const RATE_ORDER: RateControl[] = ['crf', 'bitrate']

const audioEncoderFor = (container: ContainerId) => (container === 'webm' ? 'libopus' : 'aac')

type FfmpegPlan = {
  codec: CodecId
  container: ContainerId
  encoder: string
  includeSubtitles: boolean
}

type FfmpegPlanOptions = FfmpegPlan & {
  inputPath: string
  outputPath: string
  rateControl: RateControl
  crf: number
  videoBitrate: number
  audioBitrate: number
  resolution: string
  frameRate: string
  streamProgress: boolean
}

function createOutputFormat(container: ContainerId): OutputFormat {
  if (container === 'mkv') return new MkvOutputFormat()
  if (container === 'webm') return new WebMOutputFormat()
  if (container === 'mov') return new MovOutputFormat({ fastStart: 'in-memory' })
  return new Mp4OutputFormat({ fastStart: 'in-memory' })
}

function containerForCodec(codec: CodecId, container: ContainerId): ContainerId {
  return CODECS[codec].containers.includes(container) ? container : CODECS[codec].containers[0]
}

function codecForContainer(container: ContainerId, codec: CodecId): CodecId {
  if (CODECS[codec].containers.includes(container)) return codec
  return CODEC_ORDER.find((candidate) => CODECS[candidate].containers.includes(container)) ?? 'avc'
}

// Odd frame sizes and 10-bit / 4:4:4 sources are the classic cause of HEVC files that a
// player shows as one frozen frame, so every encode is forced to even dimensions and 8-bit 4:2:0.
function buildScaleArgs(resolution: string): string[] {
  const filters = resolution === 'source' ? [] : [`scale=${resolution}:-2`]
  filters.push('scale=trunc(iw/2)*2:trunc(ih/2)*2')
  return ['-vf', filters.join(',')]
}

function buildFfmpegArgs(options: FfmpegPlanOptions): string[] {
  const isIsobmff = options.container === 'mp4' || options.container === 'mov'
  const args = ['-y', '-fflags', '+genpts', '-i', options.inputPath, '-map', '0:v:0', '-map', '0:a?']
  if (options.includeSubtitles) args.push('-map', '0:s?')
  args.push('-c:v', options.encoder)
  if (options.rateControl === 'bitrate') args.push('-b:v', `${options.videoBitrate}k`)
  else args.push('-crf', String(options.crf))
  args.push(...(ENCODER_TUNING[options.encoder] ?? []))
  args.push('-pix_fmt', 'yuv420p')
  // `hev1` boxes are rejected or mis-seeked by many players; `hvc1` is the compatible tag.
  if (options.codec === 'hevc' && isIsobmff) args.push('-tag:v', 'hvc1')
  args.push('-c:a', audioEncoderFor(options.container), '-b:a', `${options.audioBitrate}k`)
  if (options.includeSubtitles) args.push('-c:s', 'copy')
  args.push(...buildScaleArgs(options.resolution))
  if (options.frameRate !== 'source') args.push('-r', String(options.frameRate), '-fps_mode', 'cfr')
  args.push('-max_muxing_queue_size', '1024')
  if (isIsobmff) args.push('-movflags', '+faststart')
  if (options.streamProgress) args.push('-progress', 'pipe:1')
  args.push(options.outputPath)
  return args
}

// Ordered fallback list: the requested codec first (with and without subtitle copy, because
// `-c:s copy` fails on some inputs), then a universal H.264/MP4 safety net.
function buildFallbackPlans(codec: CodecId, container: ContainerId): FfmpegPlan[] {
  const plans: FfmpegPlan[] = []
  const seen = new Set<string>()
  const add = (nextCodec: CodecId, nextContainer: ContainerId, includeSubtitles: boolean) => {
    for (const encoder of CODECS[nextCodec].encoders) {
      const key = `${encoder}|${nextContainer}|${includeSubtitles}`
      if (seen.has(key)) continue
      seen.add(key)
      plans.push({ codec: nextCodec, container: nextContainer, encoder, includeSubtitles })
    }
  }
  add(codec, container, container !== 'webm')
  add(codec, container, false)
  if (codec !== 'avc' || container !== 'mp4') add('avc', 'mp4', false)
  return plans
}

// Native progress is reported as raw FFmpeg timestamps, so the source duration is needed
// to turn them into a percentage.
function readVideoDuration(file: File): Promise<number> {
  return new Promise((resolve) => {
    const video = document.createElement('video')
    const url = URL.createObjectURL(file)
    const done = (value: number) => {
      video.removeAttribute('src')
      URL.revokeObjectURL(url)
      resolve(value)
    }
    video.preload = 'metadata'
    video.onloadedmetadata = () => done(Number.isFinite(video.duration) ? video.duration : 0)
    video.onerror = () => done(0)
    video.src = url
  })
}

function recordBrowserCompatibleVideo(
  file: File,
  container: ContainerId,
  requestedWidth: number | undefined,
  requestedFrameRate: number | undefined,
  videoBitrate: number,
  audioBitrate: number,
  quality: QualityPreset,
  rateControl: RateControl,
  onProgress: (value: number) => void,
): Promise<BrowserRecordingResult> {
  const video = document.createElement('video')
  const videoWithCapture = video as HTMLVideoElement & {
    captureStream?: () => MediaStream
    mozCaptureStream?: () => MediaStream
    requestVideoFrameCallback?: (callback: (now: number, metadata: { mediaTime: number }) => void) => number
  }
  const sourceUrl = URL.createObjectURL(file)
  video.src = sourceUrl
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'

  return new Promise<BrowserRecordingResult>((resolve, reject) => {
    let animationFrame = 0
    let watchdog = 0
    let recorder: MediaRecorder | undefined
    let finished = false

    const cleanup = () => {
      if (animationFrame) cancelAnimationFrame(animationFrame)
      if (watchdog) window.clearInterval(watchdog)
      video.pause()
      video.removeAttribute('src')
      video.load()
      URL.revokeObjectURL(sourceUrl)
    }
    const fail = (error: Error) => {
      cleanup()
      if (recorder && recorder.state !== 'inactive') {
        try { recorder.stop() } catch { /* the recorder is already gone */ }
      }
      reject(error)
    }
    const finish = () => {
      if (finished) return
      finished = true
      if (animationFrame) cancelAnimationFrame(animationFrame)
      if (watchdog) window.clearInterval(watchdog)
      try { recorder?.stop() } catch { cleanup() }
    }

    video.onerror = () => fail(new Error('This browser cannot decode the selected video'))
    video.onloadedmetadata = () => {
      const width = requestedWidth || video.videoWidth || 1280
      const height = Math.max(2, Math.round((width * (video.videoHeight || 720)) / (video.videoWidth || 1280) / 2) * 2)
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d')
      const captureStream = videoWithCapture.captureStream?.() || videoWithCapture.mozCaptureStream?.()
      if (!context || !captureStream) { fail(new Error('This browser does not support local media capture')); return }

      const frameRate = requestedFrameRate || 30
      const canvasStream = canvas.captureStream(frameRate)
      const combinedStream = new MediaStream([...canvasStream.getVideoTracks(), ...captureStream.getAudioTracks()])
      const mimeType = RECORDER_MIME_TYPES[container].find((candidate) => MediaRecorder.isTypeSupported(candidate))
      if (!mimeType) { fail(new Error('This browser does not expose a compatible video recorder')); return }

      const chunks: Blob[] = []
      const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0
      const paint = () => {
        if (finished) return
        context.drawImage(video, 0, 0, width, height)
        if (duration > 0) {
          const ratio = Math.min(video.currentTime, duration) / duration
          onProgress(Math.max(0, Math.min(100, Math.round(ratio * 100))))
        }
      }
      const stopTracks = () => {
        combinedStream.getTracks().forEach((track) => track.stop())
        captureStream.getTracks().forEach((track) => track.stop())
      }

      const recorderBitrate = rateControl === 'bitrate'
        ? videoBitrate * 1000
        : Math.round(width * height * frameRate * RECORDER_BITS_PER_PIXEL[quality])

      recorder = new MediaRecorder(combinedStream, {
        mimeType,
        videoBitsPerSecond: recorderBitrate,
        audioBitsPerSecond: audioBitrate * 1000,
      })
      recorder.ondataavailable = (event) => { if (event.data.size > 0) chunks.push(event.data) }
      recorder.onerror = () => { stopTracks(); fail(new Error('Browser recording failed')) }
      recorder.onstop = () => {
        stopTracks()
        cleanup()
        resolve({ blob: new Blob(chunks, { type: mimeType }), mimeType })
      }

      video.onended = finish
      paint()
      recorder.start(250)

      // requestVideoFrameCallback fires once per decoded frame and keeps running while the
      // window is occluded, whereas requestAnimationFrame is throttled to a standstill and
      // would stall the canvas stream - freezing the whole output mid-encode.
      if (typeof videoWithCapture.requestVideoFrameCallback === 'function') {
        const onFrame = () => {
          if (finished) return
          paint()
          if (video.ended) { finish(); return }
          videoWithCapture.requestVideoFrameCallback?.(onFrame)
        }
        videoWithCapture.requestVideoFrameCallback(onFrame)
      } else {
        const drawFrame = () => {
          if (finished) return
          if (video.ended) { finish(); return }
          paint()
          animationFrame = requestAnimationFrame(drawFrame)
        }
        animationFrame = requestAnimationFrame(drawFrame)
      }

      // Safety net for sources whose `ended` event never fires (malformed duration etc.).
      watchdog = window.setInterval(() => {
        if (finished) { window.clearInterval(watchdog); return }
        if (video.ended) finish()
        else if (duration > 0 && video.currentTime >= duration - 0.05) finish()
      }, 1000)

      void video.play().catch(() => fail(new Error('This browser blocked local playback for conversion')))
    }
  })
}

function TextSegmented<T extends string>({ label, hint, options, value, onChange, sliding = false, captionsBelow = false, sentence = false }: {
  label: string
  hint?: string
  options: { id: T; label: string; title?: string; caption?: string }[]
  value: T
  onChange: (next: T) => void
  sliding?: boolean
  captionsBelow?: boolean
  sentence?: boolean
}) {
  const activeIndex = Math.max(0, options.findIndex((option) => option.id === value))
  // Captions live inside the slot when they describe the option in place, and
  // under the track when the reference puts them at its outer edges instead.
  const hasCaptions = !captionsBelow && options.some((option) => option.caption)
  return (
    <div className={`field text-segmented ${sliding ? 'sliding' : ''}`}>
      <div className="segment-heading">
        <span className="field-label">{label}</span>
        {hint && <span className="field-hint">{hint}</span>}
      </div>
      <div className={`segmented ${sentence ? 'sentence' : ''}`} role="group" aria-label={label}>
        {options.map((option) => (
          <button
            type="button"
            key={option.id}
            className={option.id === value ? 'segment active' : 'segment'}
            aria-pressed={option.id === value}
            title={option.title}
            onClick={() => onChange(option.id)}
          >
            <span className="segment-label">{option.label}</span>
            {hasCaptions && option.caption && <span className="segment-caption">{option.caption}</span>}
          </button>
        ))}
        {sliding && (
          <span
            className="segment-slider"
            style={{
              '--seg-count': options.length,
              '--seg-index': activeIndex,
            } as CSSProperties}
            aria-hidden="true"
          />
        )}
      </div>
      {captionsBelow && options.some((option) => option.caption) && (
        <div className="segment-captions">
          {options.filter((option) => option.caption).map((option) => <span key={option.id}>{option.caption}</span>)}
        </div>
      )}
    </div>
  )
}

function App() {
  const ffmpegRef = useRef(new FFmpeg())
  const [file, setFile] = useState<File | null>(null)
  const [outputUrl, setOutputUrl] = useState('')
  const [outputName, setOutputName] = useState('')
  const [codec, setCodec] = useState<CodecId>('hevc')
  const [container, setContainer] = useState<ContainerId>('mp4')
  const [quality, setQuality] = useState<QualityPreset>('balanced')
  const [rateControl, setRateControl] = useState<RateControl>('crf')
  const [videoBitrate, setVideoBitrate] = useState('8000')
  const [resolution, setResolution] = useState('source')
  const [frameRate, setFrameRate] = useState('source')
  const [audioBitrate, setAudioBitrate] = useState('192')
  const [status, setStatus] = useState('Ready for a video')
  const [progress, setProgress] = useState(0)
  const [isBusy, setIsBusy] = useState(false)
  const [isDark, setIsDark] = useState(true)

  const crf = CRF_BY_PRESET[quality]
  const targetWidth = resolution === 'source' ? undefined : Number(resolution)
  const targetFrameRate = frameRate === 'source' ? undefined : Number(frameRate)
  const videoBitrateKbps = Number(videoBitrate)
  const audioBitrateKbps = Number(audioBitrate)

  const chooseFile = (nextFile?: File) => {
    if (!nextFile || !nextFile.type.startsWith('video/')) {
      setStatus('Choose a video file to continue')
      return
    }
    if (outputUrl) URL.revokeObjectURL(outputUrl)
    setFile(nextFile)
    setOutputUrl('')
    setOutputName('')
    setProgress(0)
    setStatus('Video ready to encode')
  }

  // Containers and codecs must stay mutually valid, so changing one re-homes the other.
  const chooseCodec = (nextCodec: CodecId) => {
    setCodec(nextCodec)
    setContainer((current) => containerForCodec(nextCodec, current))
  }

  const chooseContainer = (nextContainer: ContainerId) => {
    setContainer(nextContainer)
    setCodec((current) => codecForContainer(nextContainer, current))
  }

  const finishConversion = (resultBlob: Blob, resultCodec: CodecId, resultContainer: ContainerId, sourceName: string) => {
    if (outputUrl) URL.revokeObjectURL(outputUrl)
    setOutputUrl(URL.createObjectURL(resultBlob))
    setOutputName(`${sourceName}-${CODECS[resultCodec].slug}.${CONTAINERS[resultContainer].extension}`)
    setProgress(100)
    setStatus(`Done. ${CODECS[resultCodec].label} in ${CONTAINERS[resultContainer].label} is ready.`)
  }

  const convertVideo = async () => {
    if (!file || isBusy) return
    const sourceName = file.name.replace(/\.[^/.]+$/, '')
    const encodingQuality = rateControl === 'crf'
      ? new Quality({ quantizer: crf })
      : new Quality({ bitrate: videoBitrateKbps * 1000, bitrateMode: 'variable' })
    setIsBusy(true)
    setProgress(0)
    setStatus('Loading the local encoder...')
    let resultCodec = codec
    let resultContainer = container
    let resultBlob: Blob | null = null
    let unsubscribeProgress: (() => void) | undefined

    try {
      if (window.desktopAPI) {
        const desktop = window.desktopAPI
        const sourceDuration = await readVideoDuration(file)
        setStatus('Encoding with native FFmpeg...')
        unsubscribeProgress = desktop.onConvertProgress?.((seconds) => {
          if (sourceDuration <= 0) return
          const ratio = Math.max(0, Math.min(1, seconds / sourceDuration))
          setProgress(Math.round(ratio * 100))
          setStatus(`Encoding with native FFmpeg... ${Math.round(ratio * 100)}%`)
        })
        const nativeResult = await desktop.convertVideo({
          inputPath: desktop.getPathForFile(file),
          codec,
          container,
          rateControl,
          crf,
          videoBitrate: videoBitrateKbps,
          audioBitrate: audioBitrateKbps,
          resolution,
          frameRate,
        })
        const data = await desktop.readOutput(nativeResult.outputPath)
        resultCodec = nativeResult.codec as CodecId
        resultContainer = nativeResult.container as ContainerId
        resultBlob = new Blob([data.buffer as ArrayBuffer], { type: CONTAINERS[resultContainer].mimeType })
      } else {
        // A strict capability probe is not a reliable verdict: it reports HEVC/AV1 as
        // unsupported on hardware that encodes them fine, and the old code then fell through
        // to the real-time recorder - which is slow and ignores the compression preset.
        // Attempt the device encoder whenever the probe does not clearly rule it out, and let
        // an actual failure decide. Undefined is treated as "unknown", not "unsupported".
        const probe = await canEncodeVideo(codec, { width: targetWidth, frameRate: targetFrameRate })
          .catch(() => true as const)
        if (probe !== false) {
          try {
            const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS })
            const output = new Output({ format: createOutputFormat(container), target: new BufferTarget() })
            const conversion = await Conversion.init({
              input,
              output,
              tracks: 'all',
              video: {
                codec,
                quality: encodingQuality,
                forceTranscode: true,
                width: targetWidth,
                frameRate: targetFrameRate,
                // Short, evenly spaced keyframes keep HEVC/AV1 results seekable in every player.
                keyFrameInterval: 2,
              },
              showWarnings: false,
            })
            if (!conversion.isValid) throw new Error('This video does not have a browser-decodable track')
            conversion.onProgress = (nextProgress) => {
              setProgress(Math.max(0, Math.min(100, Math.round(nextProgress * 100))))
              setStatus(`Encoding ${CODECS[codec].name} with the device encoder...`)
            }
            await conversion.execute()
            if (!output.target.buffer) throw new Error('The encoder returned an empty file')
            resultBlob = new Blob([output.target.buffer], { type: CONTAINERS[container].mimeType })
          } catch (deviceError) {
            console.warn('Device encoder failed, falling back to the compatibility recorder', deviceError)
          }
        }

        if (!resultBlob) {
          try {
            setStatus('Using the browser compatibility recorder...')
            const browserResult = await recordBrowserCompatibleVideo(file, container, targetWidth, targetFrameRate, videoBitrateKbps, audioBitrateKbps, quality, rateControl, setProgress)
            const isMp4 = browserResult.mimeType.startsWith('video/mp4')
            resultCodec = isMp4 ? 'avc' : 'vp9'
            resultContainer = isMp4 ? 'mp4' : 'webm'
            resultBlob = browserResult.blob
          } catch (browserError) {
            console.warn('Browser compatibility recorder unavailable', browserError)
          }
        }
      }

      if (!resultBlob) {
        setStatus('Downloading the local fallback encoder...')
        setProgress(5)
        const ffmpeg = ffmpegRef.current
        ffmpeg.on('log', ({ message }) => {
          const logLine = String(message || '')
          if (/input|output|encoder|stream|error/i.test(logLine)) setStatus(logLine.slice(-92))
        })
        if (!ffmpeg.loaded) {
          const baseURL = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm'
          const loadEncoder = async () => {
            const coreURL = await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript')
            setStatus('Initializing the local fallback encoder...')
            const wasmURL = await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm')
            await ffmpeg.load({ coreURL, wasmURL })
          }
          await Promise.race([
            loadEncoder(),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('The local encoder took too long to load')), 45000)),
          ])
        }
        ffmpeg.on('progress', ({ progress: nextProgress }) => {
          setProgress(Math.max(0, Math.min(100, Math.round(nextProgress * 100))))
          setStatus(`Encoding ${CODECS[resultCodec].name} locally with FFmpeg WASM...`)
        })

        const inputExtension = file.name.split('.').pop()?.toLowerCase() || 'mp4'
        const inputName = `input.${inputExtension}`
        await ffmpeg.writeFile(inputName, await fetchFile(file))

        // Try the requested target first, then progressively safer combinations. The result is
        // only accepted once a plan actually produced a file on the virtual filesystem.
        const plans = buildFallbackPlans(codec, container)
        let lastError: unknown
        for (const plan of plans) {
          const outputName = `output.${CONTAINERS[plan.container].extension}`
          try {
            await ffmpeg.exec(buildFfmpegArgs({
              inputPath: inputName,
              outputPath: outputName,
              codec: plan.codec,
              container: plan.container,
              encoder: plan.encoder,
              includeSubtitles: plan.includeSubtitles,
              rateControl,
              crf,
              videoBitrate: videoBitrateKbps,
              audioBitrate: audioBitrateKbps,
              resolution,
              frameRate,
              streamProgress: false,
            }))
            const data = await ffmpeg.readFile(outputName)
            const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
            resultBlob = new Blob([bytes.buffer as ArrayBuffer], { type: CONTAINERS[plan.container].mimeType })
            resultCodec = plan.codec
            resultContainer = plan.container
            lastError = undefined
            break
          } catch (planError) {
            console.warn(`${plan.encoder} into ${plan.container} failed`, planError)
            lastError = planError
          }
        }
        if (!resultBlob) throw lastError instanceof Error ? lastError : new Error('The local fallback encoder could not process this file')
      }

      finishConversion(resultBlob, resultCodec, resultContainer, sourceName)
    } catch (error) {
      console.error(error)
      try {
        setStatus('Using the browser compatibility recorder...')
        const browserResult = await recordBrowserCompatibleVideo(file, container, targetWidth, targetFrameRate, videoBitrateKbps, audioBitrateKbps, quality, rateControl, setProgress)
        const isMp4 = browserResult.mimeType.startsWith('video/mp4')
        finishConversion(browserResult.blob, isMp4 ? 'avc' : 'vp9', isMp4 ? 'mp4' : 'webm', sourceName)
      } catch (fallbackError) {
        console.error(fallbackError)
        setStatus('This browser cannot decode or record this video locally.')
        setProgress(0)
      }
    } finally {
      unsubscribeProgress?.()
      setIsBusy(false)
    }
  }

  return (
    <main className={`app-shell ${isDark ? 'dark-mode' : ''}`}>
      <header className="topbar">
        <a className="brand" href="/" aria-label="Rizal_convert home">
          <span className="brand-mark">R</span>
          <span className="brand-name">RIZAL_CONVERT</span>
        </a>
        <div className="topbar-actions">
          <span className="privacy-pill" title="Everything runs on this device"><span className="status-dot" /> DEVICE-ONLY PROCESSING</span>
          <button
            className="theme-toggle"
            type="button"
            onClick={() => setIsDark((current) => !current)}
            aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            <span className="theme-icon" key={isDark ? 'sun' : 'moon'}>
              {isDark ? (
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <circle cx="12" cy="12" r="4.1" />
                  <path d="M12 2.2v2.6M12 19.2v2.6M2.2 12h2.6M19.2 12h2.6M5.1 5.1l1.8 1.8M17.1 17.1l1.8 1.8M18.9 5.1l-1.8 1.8M6.9 17.1l-1.8 1.8" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M20.7 14.2A8.7 8.7 0 0 1 9.8 3.3a8.7 8.7 0 1 0 10.9 10.9Z" />
                </svg>
              )}
            </span>
          </button>
        </div>
      </header>

      <section className="intro">
        <p className="eyebrow"><span aria-hidden="true" />LOCAL VIDEO OPTIMIZER</p>
        <h1>Make your video <em>lighter</em>.</h1>
      </section>

      <section className="card" aria-label="Video converter">
        <div className="upload-panel">
          <label
            className={`drop-zone ${file ? 'has-file' : ''}`}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => { event.preventDefault(); chooseFile(event.dataTransfer.files[0]) }}
          >
            <input type="file" accept="video/*" onChange={(event) => chooseFile(event.target.files?.[0])} />
            <span className="upload-glyph" aria-hidden="true">
              <svg viewBox="0 0 24 24" focusable="false">
                <path d="M12 19V6M6 11.6 12 5.6l6 6" />
              </svg>
            </span>
            <strong className="drop-title">{file ? file.name : 'Drop a video here'}</strong>
            <small>{file ? `${(file.size / (1024 * 1024)).toFixed(1)} MB ready to encode` : 'or click to browse your device'}</small>
            {!file && <small className="drop-formats">MP4, MOV, MKV, AVI and more</small>}
          </label>
          <div className="privacy-note">
            <span className="lock-icon" aria-hidden="true">⌁</span>
            <span>
              <strong>Private by design</strong>
              <small>Processing runs locally with WebAssembly. No upload, no account.</small>
            </span>
          </div>
        </div>

        <aside className="settings-panel">
          <div className="panel-heading"><span>01</span><h2>Output settings</h2></div>
          <div className="format-summary">
            <span className="field-label">Format</span>
            <span className="format-value">{CODECS[codec].label} in {CONTAINERS[container].label}</span>
            <span className="format-dot" />
          </div>

        <TextSegmented
          label="Compression"
          options={QUALITY_ORDER.map((option) => ({
            id: option,
            label: option,
            title: `CRF ${CRF_BY_PRESET[option]}`,
            caption: option === 'smallest' ? 'Smallest file' : option === 'quality' ? 'Best quality' : '',
          }))}
          value={quality}
          onChange={setQuality}
          sliding
          captionsBelow
        />

        <div className="field-row">
          <label className="field">
            <span className="field-label">Codec</span>
            <span className="field-control">
              <select value={codec} onChange={(event) => chooseCodec(event.target.value as CodecId)}>
                {CODEC_ORDER.map((option) => <option value={option} key={option}>{CODECS[option].label}</option>)}
              </select>
            </span>
          </label>
          <label className="field">
            <span className="field-label">Container</span>
            <span className="field-control">
              <select value={container} onChange={(event) => chooseContainer(event.target.value as ContainerId)}>
                {CONTAINER_ORDER.map((option) => <option value={option} key={option} disabled={!CODECS[codec].containers.includes(option)}>{CONTAINERS[option].label}</option>)}
              </select>
            </span>
          </label>
        </div>

        <TextSegmented
          label="Rate control"
          hint={rateControl === 'crf' ? `CRF ${crf}` : `${videoBitrateKbps / 1000} Mbps`}
          options={RATE_ORDER.map((option) => ({
            id: option,
            label: option === 'crf' ? 'CRF quality' : 'Target bitrate',
            title: option === 'crf' ? 'Constant quality' : 'Target bitrate',
          }))}
          value={rateControl}
          onChange={setRateControl}
          sliding
          sentence
        />

        {rateControl === 'bitrate' && (
          <label className="field">
            <span className="field-label">Target bitrate</span>
            <span className="field-control">
              <select value={videoBitrate} onChange={(event) => setVideoBitrate(event.target.value)}>
                <option value="5000">5 Mbps</option>
                <option value="8000">8 Mbps</option>
                <option value="12000">12 Mbps</option>
                <option value="20000">20 Mbps</option>
                <option value="30000">30 Mbps</option>
                <option value="50000">50 Mbps</option>
              </select>
            </span>
          </label>
        )}

        <div className="field-row">
          <label className="field">
            <span className="field-label">Resolution</span>
            <span className="field-control">
              <select value={resolution} onChange={(event) => setResolution(event.target.value)}>
                <option value="source">Source size</option>
                <option value="1280">720p</option>
                <option value="1920">1080p</option>
                <option value="2560">1440p</option>
                <option value="3840">4K</option>
              </select>
            </span>
          </label>
          <label className="field">
            <span className="field-label">Frame rate</span>
            <span className="field-control">
              <select value={frameRate} onChange={(event) => setFrameRate(event.target.value)}>
                <option value="source">Source rate</option>
                <option value="24">24 fps</option>
                <option value="25">25 fps</option>
                <option value="30">30 fps</option>
                <option value="50">50 fps</option>
                <option value="60">60 fps</option>
              </select>
            </span>
          </label>
        </div>

        <label className="field">
          <span className="field-label">Audio bitrate</span>
          <span className="field-control">
            <select value={audioBitrate} onChange={(event) => setAudioBitrate(event.target.value)}>
              <option value="96">96 kbps</option>
              <option value="128">128 kbps</option>
              <option value="192">192 kbps</option>
              <option value="256">256 kbps</option>
              <option value="320">320 kbps</option>
            </select>
          </span>
        </label>

        <div className="action-zone">
          <button className="convert-button" type="button" disabled={!file || isBusy} onClick={convertVideo}>
            <span className="convert-label">{isBusy ? 'Encoding' : `Convert to ${CODECS[codec].name}`}</span>
            <span className="button-arrow" aria-hidden="true">{isBusy ? `${progress}%` : '↗'}</span>
          </button>
          {isBusy && (
            <div className="progress-track" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} aria-label="Conversion progress">
              <span style={{ transform: `scaleX(${progress / 100})` }} />
            </div>
          )}
          <p className="status-text" aria-live="polite">{status}</p>
          {outputUrl && (
            <a className="download-button" href={outputUrl} download={outputName}>
              <span className="download-label">Download {outputName}</span>
              <span aria-hidden="true">↓</span>
            </a>
          )}
        </div>
        </aside>
      </section>

      <footer className="footer-note">Made by Bipin Rizal</footer>
    </main>
  )
}

export default App
