import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
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

/* ------------------------------------------------------------------ types */

type CodecId = 'hevc' | 'avc' | 'av1' | 'vp9'
type ContainerId = 'mp4' | 'mkv' | 'mov' | 'webm'
type RateMode = 'crf' | 'bitrate' | 'size'
type SpeedId = 'fast' | 'balanced' | 'quality'

type BrowserEntry = {
  name: string
  path: string
  type: 'directory' | 'video' | 'audio' | 'file'
  size?: number
  sizeLabel?: string
}

type BrowserListing = {
  ok: boolean
  error?: string
  path: string
  parent: string | null
  root?: string
  roots: string[]
  shortcuts: { label: string; path: string }[]
  entries: BrowserEntry[]
}

type MediaProbe = { ok: boolean; duration: number; width: number; height: number; fps?: number; hasAudio?: boolean }

type Source = {
  name: string
  size: number
  duration: number
  width: number
  height: number
  path?: string
  file?: File
  hasAudio?: boolean
}

type ConvertResult = {
  name: string
  path?: string
  url?: string
  sizeLabel: string
  codecName: string
  containerName: string
  outputDir?: string
  sizeNote?: string
}

type DirectoryHandleLike = {
  name: string
  getFileHandle: (name: string, options?: { create?: boolean }) => Promise<{
    createWritable: () => Promise<{ write: (data: Blob) => Promise<void>; close: () => Promise<void> }>
  }>
}

// State of the little HTTP server that lets a phone on the same Wi-Fi hand a video to this
// PC and take the converted file back.
type ShareState = {
  ok: boolean
  running?: boolean
  port?: number
  url?: string
  addresses?: { name: string; url: string }[]
  error?: string
  shareOnLaunch?: boolean
}

interface DesktopApi {
  getPathForFile: (file: File) => string
  convertVideo: (options: Record<string, unknown>) => Promise<{
    outputPath: string
    codec: string
    container: string
    encoder: string
    size: number
    sizeLabel: string
  }>
  cancelConvert: (requestId: string) => Promise<boolean>
  readOutput: (outputPath: string) => Promise<Uint8Array>
  onConvertProgress: (callback: (payload: { requestId: string; seconds: number }) => void) => () => void
  listDirectory: (targetPath: string, includeNonVideo?: boolean) => Promise<BrowserListing>
  pickFile: () => Promise<string | null>
  pickFolder: () => Promise<string | null>
  statPath: (targetPath: string) => Promise<{ ok: boolean; size?: number; sizeLabel?: string }>
  probeMedia: (targetPath: string) => Promise<MediaProbe>
  saveAs: (sourcePath: string, suggestedName?: string) => Promise<string | null>
  openPath: (targetPath: string) => Promise<string>
  showItemInFolder: (targetPath: string) => Promise<boolean>
  appInfo: () => Promise<{ platform: string; home: string; bundled: boolean }>
  shareState: () => Promise<ShareState>
  startSharing: () => Promise<ShareState>
  stopSharing: () => Promise<ShareState>
}

declare global {
  interface Window {
    desktopAPI?: DesktopApi
    showOpenFilePicker?: (options?: unknown) => Promise<{ getFile: () => Promise<File>; name: string }[]>
    showDirectoryPicker?: (options?: unknown) => Promise<DirectoryHandleLike>
  }
}

/* -------------------------------------------------------------- constants */

const CODEC_ORDER: CodecId[] = ['avc', 'hevc', 'av1', 'vp9']
const CONTAINER_ORDER: ContainerId[] = ['mp4', 'mkv', 'mov', 'webm']

const NATIVE_BUILD = typeof window !== 'undefined' && Boolean(window.desktopAPI)

// Every codec stays selectable everywhere. In the browser each one needs an encoder the
// device actually exposes (WebCodecs), so the panel says which of them this machine can
// produce, and every result is verified before it is handed over.
const AVAILABLE_CODECS: CodecId[] = CODEC_ORDER

// What to offer when the chosen codec has no encoder on this machine. Measured in Chromium
// with its software encoders on a 1080p / 17.5 s clip at "Smallest" (CRF 32): H.264 took
// 25 s for an 85% smaller file, AV1 took 24 s for 20%, and VP9 had not finished after two
// minutes. So H.264 is the codec that actually shrinks a file in a browser; the others are
// only offered when a machine exposes an encoder for them.
const ALTERNATIVE_ORDER: CodecId[] = ['avc', 'av1', 'vp9']

const CODECS: Record<CodecId, { label: string; name: string; slug: string; containers: ContainerId[] }> = {
  hevc: { label: 'H.265 / HEVC', name: 'HEVC', slug: 'hevc', containers: ['mp4', 'mkv', 'mov'] },
  avc: { label: 'H.264 / AVC', name: 'H.264', slug: 'h264', containers: ['mp4', 'mkv', 'mov'] },
  av1: { label: 'AV1', name: 'AV1', slug: 'av1', containers: ['mp4', 'mkv', 'webm'] },
  vp9: { label: 'VP9', name: 'VP9', slug: 'vp9', containers: ['mkv', 'webm'] },
}

const CONTAINERS: Record<ContainerId, { label: string; extension: string; mimeType: string }> = {
  mp4: { label: 'MP4', extension: 'mp4', mimeType: 'video/mp4' },
  mkv: { label: 'MKV', extension: 'mkv', mimeType: 'video/x-matroska' },
  mov: { label: 'MOV', extension: 'mov', mimeType: 'video/quicktime' },
  webm: { label: 'WebM', extension: 'webm', mimeType: 'video/webm' },
}

// Audio-only output: always AAC in an `.m4a` so it plays everywhere (phone, car, editor).
const AUDIO_OUTPUT = { slug: 'audio', extension: 'm4a', codecName: 'AAC', containerName: 'M4A', mimeType: 'audio/mp4' }

// Quick buttons over the CRF slider. Lower CRF is better quality and a bigger file;
// the slider runs the other way so "drag right = smaller".
const CRF_PRESETS: { id: string; label: string; crf: number }[] = [
  { id: 'smallest', label: 'Smallest', crf: 32 },
  { id: 'balanced', label: 'Balanced', crf: 23 },
  { id: 'quality', label: 'Quality', crf: 18 },
]

const CRF_MIN = 0
const CRF_MAX = 51

const SPEEDS: { id: SpeedId; label: string; caption: string }[] = [
  { id: 'fast', label: 'Fast', caption: 'Quick' },
  { id: 'balanced', label: 'Balanced', caption: 'Default' },
  { id: 'quality', label: 'Thorough', caption: 'Smallest' },
]

const VIDEO_ACCEPT = 'video/*,.mp4,.m4v,.mkv,.mov,.webm,.avi,.wmv,.flv,.ts,.m2ts,.mts,.mpg,.mpeg,.3gp,.ogv'
const AUDIO_ACCEPT = 'audio/*,.mp3,.m4a,.aac,.flac,.wav,.ogg,.opus,.wma,.aiff'
// Video and audio are both accepted so the audio-only mode can be fed a music file too.
const MEDIA_ACCEPT = `${VIDEO_ACCEPT},${AUDIO_ACCEPT}`

/* ---------------------------------------------------------------- helpers */

const desktop = () => (typeof window !== 'undefined' ? window.desktopAPI : undefined)

function createRequestId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `req-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function basename(target: string) {
  return target.split(/[\\/]/).filter(Boolean).pop() || target
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${(bytes / 1024 ** exponent).toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`
}

// How the output size compares with the input, so a conversion is never mistaken for
// "nothing happened". Reports smaller/larger, or "about the same size".
function sizeChange(from: number, to: number): string | undefined {
  if (!from || !to) return undefined
  const ratio = (to - from) / from
  if (Math.abs(ratio) < 0.01) return 'about the same size'
  return ratio < 0 ? `${Math.round(-ratio * 100)}% smaller` : `${Math.round(ratio * 100)}% larger`
}

// ------------------------------------------------------- target file size
// "Get this under X MB" is a different question from "pick a quality": the whole-file
// budget has to be split between audio and video, and the resulting video bitrate then
// decides how much resolution the picture can actually carry. The estimate leans low
// (6% headroom, and never more than 85% of the source's own bitrate) so the result lands
// under the limit instead of just next to it.
const TARGET_SIZE_PRESETS = [
  { mb: 10, caption: 'Tiny' },
  { mb: 20, caption: 'Discord' },
  { mb: 50, caption: 'Roomier' },
] as const
const MIN_VIDEO_BITRATE_KBPS = 64
// Below roughly this many bits per pixel per frame, a picture turns to mush: step the
// resolution down until every pixel gets enough bits.
const TARGET_BITS_PER_PIXEL = 0.035

type SizePlan = {
  videoBitrateKbps: number
  width: number
  height: number
  frameRate: number
  estimatedBytes: number
}

function planTargetSize(input: {
  duration: number
  sourceBytes: number
  sourceWidth: number
  sourceHeight: number
  targetMb: number
  audioBitrateKbps: number
}): SizePlan | null {
  const duration = Number.isFinite(input.duration) ? input.duration : 0
  const targetMb = Number(input.targetMb)
  if (duration < 0.5 || !(targetMb > 0)) return null

  const targetBytes = targetMb * 1024 * 1024
  const audioKbps = Math.max(32, Math.min(320, input.audioBitrateKbps || 128))
  const sourceWidth = Math.max(2, input.sourceWidth || 1920)
  const sourceHeight = Math.max(2, input.sourceHeight || 1080)

  // 6% is left to the container, the index and the encoder overshooting its target.
  const budgetBps = (targetBytes * 8 * 0.94) / duration - audioKbps * 1000
  // Strictly smaller: never plan to spend more than 85% of what the source already costs.
  const sourceBps = input.sourceBytes > 0
    ? (input.sourceBytes * 8 * 0.85) / duration - audioKbps * 1000
    : Number.POSITIVE_INFINITY
  const videoBps = Math.max(
    MIN_VIDEO_BITRATE_KBPS * 1000,
    Math.min(48_000_000, Math.min(budgetBps, sourceBps)),
  )

  // 30 fps is the cap: doubling the frame rate halves the bits every frame can have.
  const frameRate = 30
  const aspect = sourceWidth / sourceHeight
  const ladder = [2160, 1440, 1080, 720, 480, 360, 240]
  let height = ladder[ladder.length - 1]
  for (const candidate of ladder) {
    if (candidate > sourceHeight) continue
    const candidateWidth = Math.max(2, Math.round((candidate * aspect) / 2) * 2)
    if (videoBps / (candidateWidth * candidate * frameRate) >= TARGET_BITS_PER_PIXEL) {
      height = candidate
      break
    }
  }
  height = Math.min(height, sourceHeight)
  const width = Math.max(2, Math.round((height * aspect) / 2) * 2)
  const videoBitrateKbps = Math.round(videoBps / 1000)

  return {
    videoBitrateKbps,
    width,
    height,
    frameRate: Math.min(frameRate, 30),
    estimatedBytes: Math.round(((videoBitrateKbps + audioKbps) * 1000 * duration) / 8),
  }
}

function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—'
  const total = Math.round(seconds)
  const minutes = Math.floor(total / 60)
  const remainder = total % 60
  return `${minutes}:${String(remainder).padStart(2, '0')}`
}

function buildCrumbs(target: string): { label: string; path: string }[] {
  if (!target) return []
  const isWindows = /^[a-zA-Z]:/.test(target)
  const parts = target.split(/[\\/]+/).filter(Boolean)
  const crumbs: { label: string; path: string }[] = []
  let accumulated = isWindows ? '' : '/'
  for (const part of parts) {
    if (isWindows) accumulated = accumulated === '' ? `${part}\\` : `${accumulated}${accumulated.endsWith('\\') ? '' : '\\'}${part}`
    else accumulated = accumulated === '/' ? `/${part}` : `${accumulated}/${part}`
    crumbs.push({ label: part, path: accumulated })
  }
  return crumbs
}

function containerForCodec(codec: CodecId, container: ContainerId): ContainerId {
  return CODECS[codec].containers.includes(container) ? container : CODECS[codec].containers[0]
}

// WebCodecs quantizer (CRF) mode is not implemented by every encoder — Edge's software
// H.264 encoder rejects it outright — so the Quality carries a bitrate next to the
// quantizer. Mediabunny then offers quantizer-based encoding with a bitrate fallback, CRF
// still wins where it is supported, and a codec is never wrongly written off as having no
// encoder at all.
const CODEC_BITRATE_FACTOR: Record<CodecId, number> = { avc: 1, hevc: 0.6, vp9: 0.6, av1: 0.4 }

// Mirrors Mediabunny's own model for qualitative presets, so the fallback lands in the same
// ballpark as the CRF that was asked for.
function estimatedBitrate(codec: CodecId, width: number, height: number, crf: number): number {
  const quality = Math.min(1, Math.max(0, (41 - crf) / 25))
  const scale = Math.pow((width * height) / (1920 * 1080), 0.95)
  const factor = 0.3 * Math.exp(2.5538 * quality)
  return Math.ceil((3_000_000 * scale * CODEC_BITRATE_FACTOR[codec] * factor) / 1000) * 1000
}

function crfQuality(codec: CodecId, width: number, height: number, crf: number): Quality {
  return new Quality({ quantizer: crf, bitrate: estimatedBitrate(codec, width, height, crf), bitrateMode: 'variable' })
}

function codecForContainer(container: ContainerId, codec: CodecId): CodecId {
  if (CODECS[codec].containers.includes(container)) return codec
  return CODEC_ORDER.find((candidate) => CODECS[candidate].containers.includes(container)) ?? 'avc'
}

// Names the browser and the exact settings page that turns hardware encoding on, so the
// "no encoder" message tells the user what to do instead of just what failed.
function accelerationHint(): { browser: string; settings: string | null } {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent
  if (/Edg\//.test(ua)) return { browser: 'Edge', settings: 'edge://settings/system' }
  if (/OPR\//.test(ua)) return { browser: 'Opera', settings: 'opera://settings/system' }
  if (/Chrome\//.test(ua)) return { browser: 'Chrome', settings: 'chrome://settings/system' }
  return { browser: 'this browser', settings: null }
}

// The native engine reports raw codes; the audio path uses `aac` / `m4a`, which are not
// in the video matrices, so display names are resolved defensively.
function codecDisplayName(codec: string) {
  if (codec === 'aac') return AUDIO_OUTPUT.codecName
  return CODECS[codec as CodecId]?.name ?? codec.toUpperCase()
}

function containerDisplayName(container: string) {
  if (container === 'm4a') return AUDIO_OUTPUT.containerName
  return CONTAINERS[container as ContainerId]?.label ?? container.toUpperCase()
}

// A local media probe that never touches the disk. Reading the header through a <video>
// element can stall on a very large file with no error and no event, which used to leave the
// drop screen stuck on "Ready when you are" forever, so the container is parsed directly with
// Mediabunny and the element is only a fallback - now with a timeout.
function probeBlob(file: File): Promise<{ duration: number; width: number; height: number; hasAudio?: boolean }> {
  const viaElement = () => new Promise<{ duration: number; width: number; height: number; hasAudio?: boolean }>((resolve) => {
    const video = document.createElement('video')
    const url = URL.createObjectURL(file)
    let settled = false
    const done = (duration: number, width: number, height: number, hasAudio?: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      video.removeAttribute('src')
      URL.revokeObjectURL(url)
      resolve({ duration, width, height, hasAudio })
    }
    const timer = setTimeout(() => done(0, 0, 0), 8000)
    video.preload = 'metadata'
    video.onloadedmetadata = () => {
      const element = video as HTMLVideoElement & { mozHasAudio?: boolean; audioTracks?: { length: number } }
      // No single property works everywhere, so the audio track is inferred when possible.
      const hasAudio = typeof element.mozHasAudio === 'boolean'
        ? element.mozHasAudio
        : element.audioTracks
          ? element.audioTracks.length > 0
          : undefined
      done(Number.isFinite(video.duration) ? video.duration : 0, video.videoWidth || 0, video.videoHeight || 0, hasAudio)
    }
    video.onerror = () => done(0, 0, 0)
    video.src = url
  })

  return (async () => {
    try {
      const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS })
      const [track, audio] = await Promise.all([input.getPrimaryVideoTrack(), input.getPrimaryAudioTrack()])
      const duration = await input.getDurationFromMetadata().catch(() => null)
      const width = track ? await track.getDisplayWidth().catch(() => 0) : 0
      const height = track ? await track.getDisplayHeight().catch(() => 0) : 0
      if (track && duration && duration > 0 && width > 0 && height > 0) {
        return { duration, width, height, hasAudio: Boolean(audio) }
      }
    } catch { /* fall through to the element probe */ }
    return viaElement()
  })()
}

/* ------------------------------------------------------- output check */

type MediaInspection = {
  videoCodec: string | null
  audioCodec: string | null
  hasVideo: boolean
  hasAudio: boolean
  duration: number
  width: number
  height: number
}

// Reads what a produced file actually contains. Mediabunny parses the container, so this
// works even for a codec the browser itself cannot play back (such as HEVC).
async function inspectMedia(blob: Blob): Promise<MediaInspection> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  try {
    const videoTrack = await input.getPrimaryVideoTrack()
    const audioTrack = await input.getPrimaryAudioTrack()
    const duration = (await input.getDurationFromMetadata().catch(() => null))
      ?? (await input.computeDuration().catch(() => 0))
    return {
      videoCodec: videoTrack?.codec ?? null,
      audioCodec: audioTrack?.codec ?? null,
      hasVideo: Boolean(videoTrack),
      hasAudio: Boolean(audioTrack),
      duration: Number.isFinite(duration) ? duration : 0,
      width: videoTrack?.displayWidth ?? 0,
      height: videoTrack?.displayHeight ?? 0,
    }
  } finally {
    input.dispose()
  }
}

// This is the guard for "it says Download but there was no conversion". A half-written
// file, a stale file left in the encoder's memory, or a fallback that quietly used a
// different codec all get rejected here, so the caller can try the next encoder instead of
// presenting garbage as success.
function assertConverted(actual: MediaInspection, expected: { codec?: CodecId; audioOnly: boolean; duration: number; label: string }) {
  if (expected.audioOnly) {
    if (!actual.hasAudio) throw new Error(`${expected.label} produced no audio`)
    return
  }
  if (!actual.hasVideo) throw new Error(`${expected.label} produced no video`)
  if (expected.codec && actual.videoCodec && actual.videoCodec !== expected.codec) {
    throw new Error(`${expected.label} produced ${actual.videoCodec.toUpperCase()} instead of ${CODECS[expected.codec].name}`)
  }
  if (actual.duration <= 0) throw new Error(`${expected.label} produced an empty file`)
  if (expected.duration > 1) {
    const tolerance = Math.max(1.5, expected.duration * 0.25)
    if (Math.abs(actual.duration - expected.duration) > tolerance) {
      throw new Error(`${expected.label} stopped early: ${actual.duration.toFixed(1)}s of ${expected.duration.toFixed(1)}s`)
    }
  }
}

// ffmpeg.wasm resolves exec() with the process exit code and does NOT reject on a failed
// command. Without this check a crashed encode silently handed back whatever file happened
// to still be lying around in its memory - the exact "it finished in a second and the video
// is a mess" bug. Clear the target first so a stale file can never be returned.
async function runFfmpeg(ffmpeg: FFmpeg, args: string[], outputName: string): Promise<Uint8Array> {
  await ffmpeg.deleteFile(outputName).catch(() => { /* nothing to remove */ })
  const exitCode = await ffmpeg.exec(args)
  if (exitCode !== 0) throw new Error(`FFmpeg exited with code ${exitCode}`)
  const data = await ffmpeg.readFile(outputName)
  return typeof data === 'string' ? new TextEncoder().encode(data) : data
}

// NOTE: there is deliberately no WebAssembly *video* encoder path.
//
// The FFmpeg core used here ships libx265/libx264 built as `[32 bit][noasm]`, reports
// "using cpu capabilities: none!", and runs a single thread. Measured on a 4-second
// 1080p clip it did not encode a single frame in 106 seconds - minutes of waiting for a
// phone clip, and effectively never for a long one. Video encoding therefore always goes
// through the device WebCodecs encoder, and the panel steers to H.264 when the chosen
// codec has no hardware encoder on this device. The WASM core is still used for
// audio-only extraction, where AAC encoding is quick.

// Audio-only WASM path: AAC in `.m4a`, mirroring the native `buildAudioArgs`.
function buildWasmAudioArgs(o: { inputName: string; outputName: string; audioBitrate: number }): string[] {
  return [
    '-y', '-i', o.inputName,
    '-map', '0:a:0', '-vn',
    '-c:a', 'aac', '-b:a', `${o.audioBitrate}k`,
    '-movflags', '+faststart',
    o.outputName,
  ]
}

function createOutputFormat(container: ContainerId): OutputFormat {
  if (container === 'mkv') return new MkvOutputFormat()
  if (container === 'webm') return new WebMOutputFormat()
  if (container === 'mov') return new MovOutputFormat({ fastStart: 'in-memory' })
  return new Mp4OutputFormat({ fastStart: 'in-memory' })
}

function videoOutput(codec: CodecId, container: ContainerId) {
  return { slug: CODECS[codec].slug, extension: CONTAINERS[container].extension, codecName: CODECS[codec].name, containerName: CONTAINERS[container].label }
}

/* ------------------------------------------------------------ primitives */

function Segmented<T extends string>({ label, hint, options, value, onChange, sentence = false, sliding = true }: {
  label: string
  hint?: string
  options: { id: T; label: string; title?: string; caption?: string }[]
  value: T
  onChange: (next: T) => void
  sentence?: boolean
  sliding?: boolean
}) {
  const activeIndex = Math.max(0, options.findIndex((option) => option.id === value))
  const hasCaptions = options.some((option) => option.caption)
  return (
    <div className="text-segmented">
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
            style={{ '--seg-count': options.length, '--seg-index': activeIndex } as CSSProperties}
            aria-hidden="true"
          />
        )}
      </div>
    </div>
  )
}

function Switch({ checked, onChange, label, hint, disabled }: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  hint?: string
  disabled?: boolean
}) {
  return (
    <div className={`switch-row ${disabled ? 'disabled' : ''}`}>
      <span className="switch-copy">
        <span className="field-label">{label}</span>
        {hint && <span className="switch-hint">{hint}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        className={`switch ${checked ? 'on' : ''}`}
        onClick={() => onChange(!checked)}
      >
        <span className="switch-knob" />
      </button>
    </div>
  )
}

/* ---------------------------------------------------------- file browser */

function FileBrowser({ mode, initialPath, onClose, onChooseFile, onChooseFolder }: {
  mode: 'file' | 'folder'
  initialPath?: string
  onClose: () => void
  onChooseFile: (path: string) => void
  onChooseFolder: (path: string) => void
}) {
  const api = desktop()
  const [listing, setListing] = useState<BrowserListing | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<BrowserEntry | null>(null)
  const [manualPath, setManualPath] = useState(initialPath || '')
  const listRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async (targetPath: string) => {
    if (!api) return
    setLoading(true)
    setError('')
    setSelected(null)
    try {
      const next = await api.listDirectory(targetPath || '', false)
      if (next.ok) {
        setListing(next)
        setManualPath(next.path)
      } else {
        setError(next.error || 'This folder could not be opened')
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'This folder could not be opened')
    } finally {
      setLoading(false)
    }
  }, [api])

  // oxlint-disable-next-line react/set-state-in-effect -- loading a directory is a fetch
  useEffect(() => { void load(initialPath || '') }, [load, initialPath])
  useEffect(() => { if (listRef.current) listRef.current.scrollTop = 0 }, [listing?.path])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const crumbs = useMemo(() => buildCrumbs(listing?.path || ''), [listing?.path])
  // In folder mode only directories are actionable; in file mode everything is.
  const entries = useMemo(() => (listing?.entries || []).filter((entry) => (mode === 'folder' ? entry.type === 'directory' : true)), [listing, mode])

  const openEntry = (entry: BrowserEntry) => {
    if (entry.type === 'directory') void load(entry.path)
    else if (mode === 'file') onChooseFile(entry.path)
  }

  const confirm = () => {
    if (mode === 'folder') {
      if (selected && selected.type === 'directory') onChooseFolder(selected.path)
      else if (listing?.path) onChooseFolder(listing.path)
    } else if (selected) {
      onChooseFile(selected.path)
    }
  }

  const systemDialog = async () => {
    if (!api) return
    if (mode === 'folder') {
      const picked = await api.pickFolder()
      if (picked) onChooseFolder(picked)
    } else {
      const picked = await api.pickFile()
      if (picked) onChooseFile(picked)
    }
  }

  return (
    <div className="browser-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="browser" role="dialog" aria-modal="true" aria-label={mode === 'folder' ? 'Choose an output folder' : 'Choose a video'}>
        <header className="browser-head">
          <div>
            <span className="browser-kicker">{mode === 'folder' ? 'Destination' : 'Open video'}</span>
            <h3>{mode === 'folder' ? 'Choose an output folder' : 'Choose a video to convert'}</h3>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">✕</button>
        </header>

        <div className="browser-toolbar">
          <button
            type="button"
            className="tool-button"
            onClick={() => listing?.parent && load(listing.parent)}
            disabled={!listing?.parent}
            title="Go up one level"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
            Up
          </button>
          <button type="button" className="tool-button" onClick={() => load('')} title="Show drives and shortcuts">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7l9-4 9 4-9 4-9-4Z" /><path d="M3 12l9 4 9-4" /><path d="M3 17l9 4 9-4" /></svg>
            Drives
          </button>
          <form
            className="path-form"
            onSubmit={(event) => { event.preventDefault(); void load(manualPath) }}
          >
            <input
              value={manualPath}
              spellCheck={false}
              placeholder="Paste a folder path and press Enter"
              onChange={(event) => setManualPath(event.target.value)}
              aria-label="Folder path"
            />
            <button type="submit" className="tool-button subtle">Go</button>
          </form>
        </div>

        <nav className="breadcrumbs" aria-label="Current folder">
          <button type="button" onClick={() => load('')}>This PC</button>
          {crumbs.map((crumb, index) => (
            <span key={crumb.path}>
              <i aria-hidden="true">›</i>
              <button type="button" onClick={() => load(crumb.path)} disabled={index === crumbs.length - 1}>{crumb.label}</button>
            </span>
          ))}
        </nav>

        <div className="browser-body">
          <aside className="browser-side">
            {(listing?.shortcuts || []).map((shortcut) => (
              <button type="button" key={shortcut.path} className="side-link" onClick={() => load(shortcut.path)}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l1.6 2H19.5A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5Z" /></svg>
                {shortcut.label}
              </button>
            ))}
            {(listing?.roots || []).length > 0 && <span className="side-divider" />}
            {(listing?.roots || []).map((root) => (
              <button type="button" key={root} className="side-link" onClick={() => load(root)}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16v12H4z" /><path d="M4 10h16" /></svg>
                {root}
              </button>
            ))}
          </aside>

          <div className="browser-list" ref={listRef}>
            {loading && <p className="browser-empty">Loading…</p>}
            {!loading && error && <p className="browser-empty error">{error}</p>}
            {!loading && !error && entries.length === 0 && <p className="browser-empty">Nothing here to show.</p>}
            {!loading && !error && entries.map((entry) => (
              <button
                type="button"
                key={entry.path}
                className={`entry ${selected?.path === entry.path ? 'selected' : ''}`}
                onClick={() => setSelected(entry)}
                onDoubleClick={() => openEntry(entry)}
              >
                <span className={`entry-icon ${entry.type}`} aria-hidden="true">
                  {entry.type === 'directory' ? (
                    <svg viewBox="0 0 24 24"><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l1.6 2H19.5A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5Z" /></svg>
                  ) : (
                    <svg viewBox="0 0 24 24"><path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h7L20 11.5V19a1 1 0 0 1-1 1H5.5A1.5 1.5 0 0 1 4 18.5Z" /><path d="M12.5 4v7.5H20" /></svg>
                  )}
                </span>
                <span className="entry-name">{entry.name}</span>
                <span className="entry-meta">{entry.type === 'directory' ? 'Folder' : entry.sizeLabel || ''}</span>
              </button>
            ))}
          </div>
        </div>

        <footer className="browser-foot">
          <span className="browser-selection" title={selected?.path || listing?.path || ''}>
            {selected ? selected.name : listing?.path || 'This PC'}
          </span>
          <div className="browser-actions">
            {api && <button type="button" className="ghost-button" onClick={systemDialog}>System dialog</button>}
            <button type="button" className="ghost-button" onClick={onClose}>Cancel</button>
            <button
              type="button"
              className="primary-button"
              onClick={confirm}
              disabled={mode === 'file' ? !selected : false}
            >
              {mode === 'folder' ? 'Use this folder' : 'Open'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------- app */

function App() {
  const ffmpegRef = useRef(new FFmpeg())
  // The in-flight device (WebCodecs) conversion, so Cancel can actually abort it.
  const browserJobRef = useRef<Conversion | null>(null)
  // Distinguishes "the user pressed Cancel" from a genuine encode failure.
  const cancelRequestedRef = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const outputHandleRef = useRef<DirectoryHandleLike | null>(null)
  const requestIdRef = useRef('')
  const startedAtRef = useRef(0)

  const [source, setSource] = useState<Source | null>(null)
  const [result, setResult] = useState<ConvertResult | null>(null)

  // H.265 is the point of the app (it shrinks a file the most), so it stays the default
  // here and in the desktop build. The browser path cannot silently downgrade the codec:
  // when this device has no encoder for the chosen one, the panel says exactly why and
  // offers H.264 or the desktop app instead of quietly producing something else.
  const [codec, setCodec] = useState<CodecId>('hevc')
  const [container, setContainer] = useState<ContainerId>('mp4')
  const [rateMode, setRateMode] = useState<RateMode>('crf')
  const [lossless, setLossless] = useState(false)
  const [crf, setCrf] = useState(23)
  const [videoBitrate, setVideoBitrate] = useState('8000')
  const [targetSizeMb, setTargetSizeMb] = useState('20')
  const [resolution, setResolution] = useState('source')
  const [frameRate, setFrameRate] = useState('source')
  const [audioBitrate, setAudioBitrate] = useState('192')
  const [speed, setSpeed] = useState<SpeedId>('balanced')
  const [hardware, setHardware] = useState(false)
  const [audioOnly, setAudioOnly] = useState(false)

  // What a whole-file budget works out to for the clip that is actually loaded: the
  // bitrate comes from the budget, and the resolution is whatever that bitrate can carry.
  const sizePlan = useMemo(() => (rateMode === 'size' && source
    ? planTargetSize({
        duration: source.duration,
        sourceBytes: source.size,
        sourceWidth: source.width,
        sourceHeight: source.height,
        targetMb: Number(targetSizeMb),
        audioBitrateKbps: Number(audioBitrate),
      })
    : null), [rateMode, source, targetSizeMb, audioBitrate])

  const [outputDir, setOutputDir] = useState('')
  const [browserMode, setBrowserMode] = useState<'file' | 'folder' | null>(null)

  const [status, setStatus] = useState('Ready when you are')
  const [progress, setProgress] = useState(0)
  const [isBusy, setIsBusy] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [isDark, setIsDark] = useState(true)
  const [desktopMode, setDesktopMode] = useState(false)
  // Which codecs this browser can actually encode with the encoders it exposes, probed
  // once on mount so the panel can explain a missing one before Convert is pressed.
  const [encodableCodecs, setEncodableCodecs] = useState<Partial<Record<CodecId, boolean>>>({})
  // Whether the machine exposes any hardware video encoder at all (probed with H.264,
  // which every Chromium has in software). When there is none, HEVC cannot be encoded in
  // the browser: Chromium ships no software HEVC encoder and uses hardware only.
  const [hasHardwareEncoder, setHasHardwareEncoder] = useState<boolean | null>(null)
  // Phone sharing (desktop only): the URL the phone should open, and a QR for it.
  const [share, setShare] = useState<ShareState>({ ok: true, running: false })
  const [shareBusy, setShareBusy] = useState(false)
  const [shareQrImage, setShareQrImage] = useState({ url: '', dataUrl: '' })
  const [shareCopied, setShareCopied] = useState(false)

  const crfPreset = CRF_PRESETS.find((preset) => preset.crf === crf && !lossless)?.id

  // True only once the probe has answered for this codec: this browser cannot encode it.
  const codecUnencodable = !desktopMode && !audioOnly && encodableCodecs[codec] === false
  // HEVC is the one codec that has no software encoder in Chromium, so "no hardware
  // encoder anywhere" is the specific, fixable cause worth calling out.
  const hevcNeedsHardware = codecUnencodable && codec === 'hevc' && hasHardwareEncoder === false
  const acceleration = hevcNeedsHardware ? accelerationHint() : null
  // The best codec this machine *can* encode, offered as a one-click swap.
  const alternative = codecUnencodable
    ? ALTERNATIVE_ORDER.find((candidate) => candidate !== codec && encodableCodecs[candidate]) ?? null
    : null

  const codecName = CODECS[codec].name
  const containerLabel = CONTAINERS[container].label
  const hardwareAvailable = desktopMode
  // The dropdowns stay in sync with audio-only so the summary and button always agree.
  const activeCodecName = audioOnly ? AUDIO_OUTPUT.codecName : codecName
  const activeContainerLabel = audioOnly ? AUDIO_OUTPUT.containerName : containerLabel
  // Desktop probes the streams, so a silent clip is caught before the encode is attempted.
  const audioMissing = audioOnly && source?.hasAudio === false
  // Shown on phones/tablets, where a blob download often never reaches the gallery.
  const canShareFiles = !desktopMode
    && typeof navigator !== 'undefined'
    && typeof navigator.canShare === 'function'
    && typeof navigator.share === 'function'
  // The QR image is stored together with the URL it was drawn for, so a stale code is never
  // shown next to a new address.
  const shareQr = share.running && shareQrImage.url === (share.url || '') ? shareQrImage.dataUrl : ''

  /* ---------------------------------------------------------- lifecycle */

  useEffect(() => {
    let cancelled = false
    const api = desktop()
    if (!api) return
    void api.appInfo().then(() => {
      if (cancelled) return
      setDesktopMode(true)
      // The reference H.265 converters pick the fastest working encoder without asking, so
      // the GPU starts switched on and the plan chain still falls back to the CPU encoder
      // the moment ffmpeg reports the GPU encoder unusable.
      setHardware(true)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  /* ------------------------------------------------------ phone sharing */

  const toggleSharing = useCallback(async (next: boolean) => {
    const api = desktop()
    if (!api) return
    setShareBusy(true)
    setShareCopied(false)
    try {
      const state = next ? await api.startSharing() : await api.stopSharing()
      setShare(state)
      if (!state.ok) setStatus(`Could not share: ${state.error || 'the port may be taken'}`)
      else if (next && state.url) setStatus(`Your phone can open ${state.url}`)
      else setStatus('Ready when you are')
    } catch (error) {
      setShare({ ok: false, running: false, error: error instanceof Error ? error.message : String(error) })
    } finally {
      setShareBusy(false)
    }
  }, [])

  const copyShareUrl = useCallback(async () => {
    const url = share.url
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
      setShareCopied(true)
      setTimeout(() => setShareCopied(false), 2000)
    } catch { /* the clipboard can be blocked; the URL is on screen either way */ }
  }, [share.url])

  // A reload of the window keeps the server running inside the main process, so the panel
  // asks for the current state instead of assuming it is off.
  useEffect(() => {
    const api = desktop()
    if (!api) return
    let cancelled = false
    void api.shareState().then((next) => { if (!cancelled) setShare(next) }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const url = share.running ? share.url : ''
    if (!url) return
    let cancelled = false
    // Imported on demand: only the desktop panel ever needs a QR encoder, so the website
    // never downloads it.
    void import('qrcode')
      .then((module) => module.toDataURL(url, { margin: 1, width: 220, color: { dark: '#0d0a15', light: '#ffffff' } }))
      .then((dataUrl) => { if (!cancelled) setShareQrImage({ url, dataUrl }) })
      .catch(() => { /* no QR: the URL is still on screen to type */ })
    return () => { cancelled = true }
  }, [share.running, share.url])

  useEffect(() => {
    if (NATIVE_BUILD) return
    let cancelled = false
    void (async () => {
      const [results, hardwareEncoder] = await Promise.all([
        Promise.all(CODEC_ORDER.map(async (candidate) => {
          const supported = await canEncodeVideo(candidate).catch(() => false)
          return [candidate, supported] as const
        })),
        // `prefer-hardware` is answered by the GPU process: it reports false when the
        // machine has no hardware encoder to offer, which is the case that rules HEVC out.
        canEncodeVideo('avc', { hardwareAcceleration: 'prefer-hardware' }).catch(() => false),
      ])
      if (cancelled) return
      setEncodableCodecs(Object.fromEntries(results) as Partial<Record<CodecId, boolean>>)
      setHasHardwareEncoder(hardwareEncoder)
    })()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!isBusy) return
    const timer = window.setInterval(() => setElapsed(Math.round((Date.now() - startedAtRef.current) / 1000)), 500)
    return () => window.clearInterval(timer)
  }, [isBusy])

  /* ------------------------------------------------------------ choosing */

  const adoptBlob = useCallback(async (file: File) => {
    const meta = await probeBlob(file)
    setSource({ name: file.name, size: file.size, duration: meta.duration, width: meta.width, height: meta.height, hasAudio: meta.hasAudio, file })
    setResult(null)
    setProgress(0)
    setStatus('Media ready to convert')
  }, [])

  const adoptPath = useCallback(async (targetPath: string) => {
    const api = desktop()
    setStatus('Reading media details…')
    const [info, stats] = await Promise.all([
      api ? api.probeMedia(targetPath) : Promise.resolve<MediaProbe>({ ok: false, duration: 0, width: 0, height: 0 }),
      api ? api.statPath(targetPath) : Promise.resolve<{ ok: boolean; size?: number; sizeLabel?: string }>({ ok: false }),
    ])
    setSource({
      name: basename(targetPath),
      size: stats.ok && stats.size ? stats.size : 0,
      duration: info.duration || 0,
      width: info.width || 0,
      height: info.height || 0,
      hasAudio: info.hasAudio,
      path: targetPath,
    })
    setResult(null)
    setProgress(0)
    setStatus('Media ready to convert')
  }, [])

  const adoptDropped = useCallback(async (file: File) => {
    const api = desktop()
    if (api) {
      const targetPath = api.getPathForFile(file)
      if (targetPath) { await adoptPath(targetPath); return }
    }
    await adoptBlob(file)
  }, [adoptBlob, adoptPath])

  const openFileBrowser = useCallback(async () => {
    const api = desktop()
    if (api) { setBrowserMode('file'); return }
    // Browsers get the native picker, which already has Up / breadcrumbs.
    if (window.showOpenFilePicker) {
      try {
        const [handle] = await window.showOpenFilePicker({ multiple: false, types: [{ description: 'Video or audio', accept: { 'video/*': ['.mp4', '.m4v', '.mkv', '.mov', '.webm', '.avi', '.wmv', '.flv', '.ts', '.mpg', '.mpeg', '.3gp', '.ogv'], 'audio/*': ['.mp3', '.m4a', '.aac', '.flac', '.wav', '.ogg', '.opus', '.wma', '.aiff'] } }] })
        if (handle) await adoptBlob(await handle.getFile())
        return
      } catch (pickerError) {
        // A SecurityError means the API is blocked here; anything else is the user
        // dismissing the dialog, in which case opening the fallback would be rude.
        if ((pickerError as { name?: string })?.name === 'AbortError') return
      }
    }
    inputRef.current?.click()
  }, [adoptBlob])

  const chooseOutputFolder = useCallback(async () => {
    const api = desktop()
    if (api) { setBrowserMode('folder'); return }
    if (window.showDirectoryPicker) {
      try {
        const handle = await window.showDirectoryPicker({ mode: 'readwrite' })
        outputHandleRef.current = handle
        setOutputDir(handle.name)
        setStatus(`Saving to ${handle.name}`)
      } catch { /* dismissed or blocked */ }
      return
    }
    setStatus('This browser cannot choose a folder; the file will be downloaded instead.')
  }, [])

  const handleChosenFile = useCallback((targetPath: string) => {
    setBrowserMode(null)
    void adoptPath(targetPath)
  }, [adoptPath])

  const handleChosenFolder = useCallback((targetPath: string) => {
    setBrowserMode(null)
    setOutputDir(targetPath)
    setStatus(`Saving to ${targetPath}`)
  }, [])

  const clearSource = useCallback(() => {
    setSource(null)
    setResult(null)
    setProgress(0)
    setStatus('Ready when you are')
  }, [])

  /* --------------------------------------------------------- conversion */

  const finalizeBrowser = useCallback(async (blob: Blob, output: { slug: string; extension: string; codecName: string; containerName: string }): Promise<ConvertResult> => {
    const name = `${source?.name.replace(/\.[^/.]+$/, '') || 'output'}-${output.slug}.${output.extension}`
    let saved = false
    if (outputHandleRef.current) {
      try {
        const fileHandle = await outputHandleRef.current.getFileHandle(name, { create: true })
        const writable = await fileHandle.createWritable()
        await writable.write(blob)
        await writable.close()
        saved = true
      } catch (writeError) {
        console.warn('Could not write to the chosen folder', writeError)
      }
    }
    return {
      name,
      url: URL.createObjectURL(blob),
      sizeLabel: formatBytes(blob.size),
      codecName: output.codecName,
      containerName: output.containerName,
      outputDir: saved ? outputHandleRef.current?.name : undefined,
      sizeNote: sizeChange(source?.size ?? 0, blob.size),
    }
  }, [source])

  const runBrowserConversion = useCallback(async (): Promise<ConvertResult> => {
    const file = source?.file
    if (!file) throw new Error('this file cannot be read in the browser')
    const sourceWidth = source?.width || 1920
    const sourceHeight = source?.height || 1080

    // A size budget becomes a concrete bitrate and resolution here; every other mode
    // passes the user's own settings through untouched.
    const plan = rateMode === 'size'
      ? planTargetSize({
          duration: source?.duration ?? 0,
          sourceBytes: source?.size ?? 0,
          sourceWidth,
          sourceHeight,
          targetMb: Number(targetSizeMb),
          audioBitrateKbps: Number(audioBitrate),
        })
      : null
    if (rateMode === 'size' && !plan) {
      throw new Error('This file does not report a duration, so a size budget cannot be planned — pick Bitrate instead')
    }
    const planMode = Boolean(plan)
    // Budget for the whole file, and never more than 85% of the source: the point is to
    // shrink it, even when the user asks for a size larger than the file already is.
    const budgetBytes = plan
      ? Math.min(Math.max(1, Number(targetSizeMb)) * 1024 * 1024, (source?.size || Number.POSITIVE_INFINITY) * 0.85)
      : 0
    const audioBytes = ((Number(audioBitrate) || 0) * 1000 * (source?.duration ?? 0)) / 8
    const userWidth = resolution === 'source' ? undefined : Number(resolution)
    const userFrameRate = frameRate === 'source' ? undefined : Number(frameRate)
    const clampWidth = (value: number) => Math.max(320, Math.min(sourceWidth, Math.round(value / 2) * 2))
    const qualityFor = (videoBitrateKbps: number, width: number) => (
      planMode
        // The bitrate is only a hint in a browser (see the note below), but it still has to
        // be a number the encoder accepts; the real size control is the pixel count.
        ? new Quality({ bitrate: Math.max(64, videoBitrateKbps) * 1000, bitrateMode: 'constant' })
        : rateMode === 'bitrate'
          ? new Quality({ bitrate: Number(videoBitrate) * 1000, bitrateMode: 'variable' })
          : lossless
            ? new Quality({ quantizer: 0 })
            : crfQuality(codec, width, Math.max(2, Math.round((width * sourceHeight) / sourceWidth)), crf)
    )

    // Audio-only always goes through FFmpeg WASM: its AAC encoder is quick and dependable
    // and no video encoding is involved.
    if (audioOnly) {
      setStatus('Downloading the local FFmpeg engine…')
      const ffmpeg = ffmpegRef.current
      if (!ffmpeg.loaded) {
        const baseURL = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm'
        const coreURL = await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript')
        const wasmURL = await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm')
        await ffmpeg.load({ coreURL, wasmURL })
      }
      const inputExtension = file.name.split('.').pop()?.toLowerCase() || 'mp4'
      const inputName = `input.${inputExtension}`
      await ffmpeg.writeFile(inputName, await fetchFile(file))
      const onProgress = (event: { progress: number }) => {
        setProgress(Math.max(0, Math.min(100, Math.round(event.progress * 100))))
      }
      ffmpeg.on('progress', onProgress)
      try {
        setStatus('Extracting the audio locally with FFmpeg…')
        const outputName = `output.${AUDIO_OUTPUT.extension}`
        const bytes = await runFfmpeg(ffmpeg, buildWasmAudioArgs({ inputName, outputName, audioBitrate: Number(audioBitrate) }), outputName)
        const blob = new Blob([bytes.buffer as ArrayBuffer], { type: AUDIO_OUTPUT.mimeType })
        assertConverted(await inspectMedia(blob), { audioOnly: true, duration: source?.duration ?? 0, label: 'The audio encoder' })
        return finalizeBrowser(blob, AUDIO_OUTPUT)
      } finally {
        ffmpeg.off('progress', onProgress)
      }
    }

    // Video has exactly one usable path: the device WebCodecs encoder. There is no
    // WebAssembly fallback - the bundled core's x264/x265 is noasm and single-threaded and
    // cannot finish a real clip (see the note above \`buildWasmAudioArgs\`). Trying it is
    // what made the app look frozen at 0% forever.
    //
    // Size mode is a different kind of encoding: Chromium's WebCodecs H.264 encoder ignores
    // `bitrate` outright (measured: asking for 500 kbps and 1500 kbps produced the same
    // ~54 Mbps), so the only lever that really moves the file size is the pixel count. The
    // plan gives a first guess, a six-second probe measures how this clip actually encodes,
    // and the full pass is then scaled to the budget. A reminder pass corrects the estimate
    // if the clip's later scenes compress differently.
    const encodeVideo = async (options: { width?: number; frameRate?: number; trimStart?: number; trimEnd?: number; discardAudio?: boolean } = {}) => {
      const width = options.width ?? (plan ? plan.width : userWidth)
      const fps = options.frameRate ?? (plan ? plan.frameRate : userFrameRate)
      const quality = qualityFor(plan ? plan.videoBitrateKbps : Number(videoBitrate), width ?? sourceWidth)

      // Deliberately no canEncodeVideo() pre-flight: Mediabunny memoises that answer for the
      // lifetime of the page, so a single transient false - which Edge does produce for a
      // moment after a previous encoder is released - would disable the codec until reload.
      // Configuring the encoder is the real check, and a failed attempt is retried.
      const attempt = async () => {
        const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS })
        const output = new Output({ format: createOutputFormat(container), target: new BufferTarget() })
        const conversion = await Conversion.init({
          input,
          output,
          tracks: 'all',
          ...(options.trimEnd
            ? { trim: { start: options.trimStart ?? 0, end: (options.trimStart ?? 0) + options.trimEnd } }
            : {}),
          ...(options.discardAudio ? { audio: { discard: true } } : {}),
          video: {
            codec,
            quality,
            forceTranscode: true,
            width,
            frameRate: fps,
            keyFrameInterval: 2,
            hardwareAcceleration: hardware ? 'prefer-hardware' : 'no-preference',
          },
          showWarnings: false,
        })
        if (!conversion.isValid) {
          throw new Error(`this browser has no ${CODECS[codec].name} encoder available for these settings`)
        }
        browserJobRef.current = conversion
        conversion.onProgress = (value) => {
          setProgress(Math.max(0, Math.min(100, Math.round(value * 100))))
        }
        try {
          await conversion.execute()
        } finally {
          browserJobRef.current = null
        }
        if (!output.target.buffer) throw new Error('the encoder returned an empty file')
        return new Blob([output.target.buffer], { type: CONTAINERS[container].mimeType })
      }

      for (const delay of [0, 700, 2000]) {
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
        try {
          return await attempt()
        } catch (error) {
          const message = String((error as Error)?.message ?? error)
          // Only an unavailable encoder is worth retrying; a decode failure will just fail again.
          if (!/encoder|not supported|notsupported/i.test(message)) throw error
        }
      }

      const hint = accelerationHint()
      const swap = alternative ? `switch to ${CODECS[alternative].name}` : 'switch codec'
      throw new Error(codec === 'hevc' && hasHardwareEncoder === false
        ? `H.265 needs a hardware video encoder and ${hint.browser} has none — turn on hardware acceleration${hint.settings ? ` (${hint.settings})` : ''} and restart, ${swap}, or convert with the desktop app`
        : `${hint.browser} could not start its ${CODECS[codec].name} encoder — ${swap}, or convert with the desktop app`)
    }

    let produced: Blob
    if (plan) {
      const duration = Math.max(1, source?.duration ?? 1)
      const framesPerSecond = plan.frameRate
      const videoBudget = Math.max(64_000, budgetBytes * 0.94 - audioBytes)

      // Six seconds is long enough to see how this content compresses and short enough to
      // be nearly free next to the real pass. Sample the middle, not the opening: an intro
      // card or a fade-in compresses to almost nothing and would overestimate the budget.
      const probeSeconds = Math.min(6, duration)
      const probeStart = Math.max(0, duration / 2 - probeSeconds / 2)
      setStatus('Measuring how this clip compresses…')
      setProgress(0)
      const probeWidth = clampWidth(plan.width)
      const probe = await encodeVideo({ width: probeWidth, frameRate: framesPerSecond, trimStart: probeStart, trimEnd: probeSeconds, discardAudio: true })
      const probeHeight = Math.max(2, Math.round((probeWidth * sourceHeight) / sourceWidth))
      const bytesPerPixelFrame = probe.size / (probeWidth * probeHeight * probeSeconds * framesPerSecond)

      // size ≈ bpp x pixels x frames, so solve for the pixels that fit the video budget.
      // 0.92 on the width (≈15% on size) covers scenes that compress worse than the sample.
      const wantPixels = videoBudget / (bytesPerPixelFrame * duration * framesPerSecond)
      let currentWidth = clampWidth(Math.min(
        plan.width,
        Math.sqrt(wantPixels * (sourceWidth / sourceHeight)) * 0.92,
      ))

      setStatus(`Encoding ${CODECS[codec].name} at ${currentWidth}px to fit ${targetSizeMb} MB…`)
      setProgress(0)
      produced = await encodeVideo({ width: currentWidth, frameRate: framesPerSecond })

      // Correction passes scale from the width that actually produced this result, not from
      // the original estimate - otherwise a second correction can grow the file again.
      for (let attempt = 0; attempt < 2 && produced.size > budgetBytes && !cancelRequestedRef.current; attempt += 1) {
        const nextWidth = clampWidth(currentWidth * Math.sqrt(budgetBytes / produced.size) * 0.97)
        if (nextWidth >= currentWidth) break
        currentWidth = nextWidth
        setStatus(`Came out at ${formatBytes(produced.size)} — re-encoding at ${currentWidth}px to fit ${targetSizeMb} MB…`)
        setProgress(0)
        const smaller = await encodeVideo({ width: currentWidth, frameRate: framesPerSecond })
        if (smaller.size >= produced.size) break
        produced = smaller
      }
    } else {
      setStatus(`Encoding ${CODECS[codec].name} with the device encoder…`)
      produced = await encodeVideo()
    }

    assertConverted(await inspectMedia(produced), {
      codec,
      audioOnly: false,
      duration: source?.duration ?? 0,
      label: 'The device encoder',
    })
    return finalizeBrowser(produced, videoOutput(codec, container))
  }, [source, resolution, frameRate, rateMode, videoBitrate, targetSizeMb, lossless, crf, codec, container, hardware, audioBitrate, audioOnly, finalizeBrowser, hasHardwareEncoder, alternative])

  const convert = useCallback(async () => {
    if (!source || isBusy) return
    startedAtRef.current = Date.now()
    cancelRequestedRef.current = false
    setElapsed(0)
    setIsBusy(true)
    setProgress(0)
    setResult(null)

    const api = desktop()
    try {
      if (api && source.path) {
        const requestId = createRequestId()
        requestIdRef.current = requestId
        setStatus('Encoding with native FFmpeg…')
        const total = source.duration
        const unsubscribe = api.onConvertProgress((payload) => {
          if (payload.requestId !== requestId || total <= 0) return
          const ratio = Math.max(0, Math.min(1, payload.seconds / total))
          setProgress(Math.round(ratio * 100))
        })
        try {
          // The desktop engine takes a plain bitrate, so the same budget math applies:
          // it gets the planned bitrate, width and frame rate instead of the mode name.
          const nativePlan = rateMode === 'size'
            ? planTargetSize({
                duration: source.duration,
                sourceBytes: source.size,
                sourceWidth: source.width,
                sourceHeight: source.height,
                targetMb: Number(targetSizeMb),
                audioBitrateKbps: Number(audioBitrate),
              })
            : null
          if (rateMode === 'size' && !nativePlan) {
            throw new Error('This file does not report a duration, so a size budget cannot be planned — pick Bitrate instead')
          }
          const nativeResult = await api.convertVideo({
            requestId,
            inputPath: source.path,
            codec,
            container,
            audioOnly,
            mode: rateMode === 'crf' && lossless ? 'lossless' : 'crf',
            rateControl: nativePlan ? 'bitrate' : rateMode,
            crf,
            videoBitrate: nativePlan ? nativePlan.videoBitrateKbps : Number(videoBitrate),
            audioBitrate: Number(audioBitrate),
            resolution: nativePlan ? String(nativePlan.width) : resolution,
            frameRate: nativePlan ? String(nativePlan.frameRate) : frameRate,
            speed,
            hardware: audioOnly ? false : hardware,
            outputDir: outputDir || undefined,
          })
          setProgress(100)
          setResult({
            name: basename(nativeResult.outputPath),
            path: nativeResult.outputPath,
            sizeLabel: nativeResult.sizeLabel || formatBytes(nativeResult.size),
            codecName: codecDisplayName(nativeResult.codec),
            containerName: containerDisplayName(nativeResult.container),
            outputDir: outputDir || undefined,
            sizeNote: sizeChange(source.size, nativeResult.size),
          })
          setStatus(`Done — ${containerDisplayName(nativeResult.container)} written to disk`)
        } finally {
          unsubscribe?.()
        }
      } else {
        const browserResult = await runBrowserConversion()
        setProgress(100)
        setResult(browserResult)
        setStatus(browserResult.outputDir ? `Done — saved to ${browserResult.outputDir}` : 'Done — your file is ready to download')
      }
    } catch (error) {
      if ((error as { cancelled?: boolean }).cancelled || cancelRequestedRef.current) {
        setStatus('Conversion cancelled')
      } else {
        console.error(error)
        setStatus(error instanceof Error ? `Could not finish: ${error.message}` : 'Could not finish the conversion')
      }
      setProgress(0)
    } finally {
      setIsBusy(false)
      requestIdRef.current = ''
    }
  }, [source, isBusy, codec, container, audioOnly, rateMode, lossless, crf, videoBitrate, targetSizeMb, audioBitrate, resolution, frameRate, speed, hardware, outputDir, runBrowserConversion])

  const cancel = useCallback(async () => {
    const id = requestIdRef.current
    if (id) await desktop()?.cancelConvert(id)
    // The browser path had no way out at all: Cancel used to do nothing here, so a slow
    // device encode could only be escaped by closing the tab.
    cancelRequestedRef.current = true
    const job = browserJobRef.current
    if (job) {
      browserJobRef.current = null
      try {
        await job.cancel()
      } catch { /* already finished */ }
    }
    setStatus('Cancelling…')
  }, [])

  /* -------------------------------------------------------------- result */

  const revealResult = useCallback(async () => {
    const api = desktop()
    if (!api || !result?.path) return
    await api.showItemInFolder(result.path)
  }, [result])

  const playResult = useCallback(async () => {
    const api = desktop()
    if (!api || !result?.path) return
    await api.openPath(result.path)
  }, [result])

  const saveResultCopy = useCallback(async () => {
    const api = desktop()
    if (!api || !result?.path) return
    const target = await api.saveAs(result.path, result.name)
    if (target) setStatus(`Copied to ${target}`)
  }, [result])

  // Phones rarely honour an `<a download>` on a blob, so the share sheet (which can save
  // straight into Photos / Files) is offered whenever the browser supports sharing files.
  const shareResult = useCallback(async () => {
    if (!result?.url) return
    try {
      const blob = await (await fetch(result.url)).blob()
      const file = new File([blob], result.name, { type: blob.type || 'video/mp4' })
      await navigator.share?.({ files: [file], title: result.name })
      setStatus('Use the share sheet to save it to this device')
    } catch (error) {
      if ((error as { name?: string })?.name !== 'AbortError') setStatus('Could not open the share sheet — use Download instead')
    }
  }, [result])

  /* ---------------------------------------------------------------- view */

  const sourceMeta = source
    ? [source.width && source.height ? `${source.width}×${source.height}` : '', source.duration ? formatDuration(source.duration) : '', source.size ? formatBytes(source.size) : ''].filter(Boolean).join('  ·  ')
    : ''

  return (
    <main className={`app-shell ${isDark ? 'dark-mode' : ''}`}>
      <div className="aurora" aria-hidden="true" />

      <header className="topbar">
        <a className="brand" href="/" aria-label="ConvZal home">
          <span className="brand-mark">C</span>
          <span className="brand-copy">
            <span className="brand-name">CONVZAL</span>
            <span className="brand-tag">Video &amp; MP4 converter</span>
          </span>
        </a>
        <div className="topbar-actions">
          <span className="privacy-pill" title="Everything runs on this device">
            <span className="status-dot" />
            {desktopMode ? 'NATIVE ENGINE' : 'DEVICE-ONLY'}
          </span>
          <button
            className="theme-toggle"
            type="button"
            onClick={() => setIsDark((current) => !current)}
            aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            <span className="theme-icon" key={isDark ? 'sun' : 'moon'}>
              {isDark ? (
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="12" cy="12" r="4.1" />
                  <path d="M12 2.2v2.6M12 19.2v2.6M2.2 12h2.6M19.2 12h2.6M5.1 5.1l1.8 1.8M17.1 17.1l1.8 1.8M18.9 5.1l-1.8 1.8M6.9 17.1l-1.8 1.8" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.7 14.2A8.7 8.7 0 0 1 9.8 3.3a8.7 8.7 0 1 0 10.9 10.9Z" /></svg>
              )}
            </span>
          </button>
        </div>
      </header>

      <section className="intro">
        <p className="eyebrow"><span aria-hidden="true" />LOCAL VIDEO CONVERTER</p>
        <h1>Video and <em>MP4</em> converter.</h1>
        <p className="intro-sub">Shrink it locally, keep the quality. Nothing ever leaves this device.</p>
      </section>

      <section className="card" aria-label="Video converter">
        {/* -------------------------------------------------- source pane */}
        <div className="upload-panel">
          <input
            ref={inputRef}
            id="media-input"
            type="file"
            accept={MEDIA_ACCEPT}
            className="sr-only-input"
            aria-label="Choose a media file"
            onChange={(event) => { const next = event.target.files?.[0]; if (next) void adoptDropped(next); event.target.value = '' }}
          />

          <div
            className={`drop-zone ${source ? 'has-file' : ''} ${isDragging ? 'dragging' : ''}`}
            onDragOver={(event) => { event.preventDefault(); setIsDragging(true) }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={(event) => {
              event.preventDefault()
              setIsDragging(false)
              const dropped = event.dataTransfer.files?.[0]
              if (dropped) void adoptDropped(dropped)
            }}
          >
            {source ? (
              <div className="source-card">
                <span className="source-badge">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6.5A1.5 1.5 0 0 1 5.5 5h13A1.5 1.5 0 0 1 20 6.5v11A1.5 1.5 0 0 1 18.5 19h-13A1.5 1.5 0 0 1 4 17.5Z" /><path d="m10 9.5 5 2.5-5 2.5Z" /></svg>
                </span>
                <strong className="source-name">{source.name}</strong>
                <small className="source-meta">{sourceMeta || 'Ready to convert'}</small>
                <div className="source-actions">
                  <button type="button" className="ghost-button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); void openFileBrowser() }}>Change</button>
                  <button type="button" className="ghost-button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); clearSource() }}>Remove</button>
                </div>
              </div>
            ) : (
              // A real `<label>`: on phones the label's native activation opens the file
              // picker even where `showOpenFilePicker` is missing or a JS `.click()` is
              // ignored. Desktop keeps the nicer in-app / system picker.
              <label
                className="drop-empty"
                htmlFor="media-input"
                role="button"
                tabIndex={0}
                onClick={(event) => {
                  if (desktop() || window.showOpenFilePicker) {
                    event.preventDefault()
                    void openFileBrowser()
                  }
                }}
                onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void openFileBrowser() } }}
              >
                <span className="upload-glyph" aria-hidden="true">
                  <svg viewBox="0 0 24 24"><path d="M12 19V6M6 11.6 12 5.6l6 6" /></svg>
                </span>
                <strong className="drop-title">Drop a video or audio file</strong>
                <small>or tap to browse this device</small>
                <span className="drop-cta">Choose a file</span>
                <small className="drop-formats">MP4 · MOV · MKV · M4A · MP3 · WAV and more</small>
              </label>
            )}
          </div>

          <div className="destination">
            <span className="dest-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24"><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l1.6 2H19.5A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5Z" /></svg>
            </span>
            <span className="dest-copy">
              <span className="field-label">Save to</span>
              <small title={outputDir || ''}>{outputDir || (desktopMode ? 'Same folder as the source' : 'Browser downloads')}</small>
            </span>
            <button type="button" className="ghost-button" onClick={() => void chooseOutputFolder()}>Choose</button>
          </div>

          <div className="privacy-note">
            <span className="lock-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24"><rect x="5" y="10.5" width="14" height="9.5" rx="2.2" /><path d="M8.2 10.5V8a3.8 3.8 0 0 1 7.6 0v2.5" /></svg>
            </span>
            <span>
              <strong>Private by design</strong>
              <small>{desktopMode ? 'Encoded on this PC by the bundled FFmpeg. No upload, no account.' : 'Runs locally with WebAssembly. No upload, no account.'}</small>
            </span>
          </div>

          {desktopMode && (
            <div className="share-panel">
              <Switch
                checked={Boolean(share.running)}
                onChange={(next) => void toggleSharing(next)}
                disabled={shareBusy}
                label="Use it from your phone"
                hint="The phone sends the video over your Wi-Fi and this PC encodes it"
              />

              {share.running && share.url && (
                <div className="share-card">
                  {shareQr
                    ? <img className="share-qr" src={shareQr} alt={`QR code that opens ${share.url}`} />
                    : <span className="share-qr share-qr-empty" aria-hidden="true" />}
                  <span className="share-copy">
                    <span className="field-label">Scan, or open on the phone</span>
                    <code className="share-url">{share.url}</code>
                    <span className="share-actions">
                      <button type="button" className="ghost-button" onClick={() => void copyShareUrl()}>
                        {shareCopied ? 'Copied' : 'Copy link'}
                      </button>
                    </span>
                    <small className="share-hint">
                      Scan once and bookmark the link on the phone — the switch is remembered, so sharing is already on next time.
                    </small>
                    <small className="share-hint">
                      Same Wi-Fi needed. If Windows asks about the firewall, allow ConvZal on private networks.
                    </small>
                    {share.addresses && share.addresses.length > 1 && (
                      <small className="share-hint">
                        Other addresses: {share.addresses.slice(1, 4).map((entry) => entry.url).join(' · ')}
                      </small>
                    )}
                  </span>
                </div>
              )}

              {share.ok === false && share.error && <p className="panel-note warn-note">{share.error}</p>}
            </div>
          )}
        </div>

        {/* ------------------------------------------------ settings pane */}
        <aside className="settings-panel">
          <div className="panel-heading"><span>01</span><h2>Output settings</h2></div>

          <Segmented<'video' | 'audio'>
            label="What to keep"
            hint={audioOnly ? 'Audio only' : 'Video + audio'}
            options={[
              { id: 'video', label: 'Video' },
              { id: 'audio', label: 'Audio only (M4A)' },
            ]}
            value={audioOnly ? 'audio' : 'video'}
            onChange={(next) => setAudioOnly(next === 'audio')}
            sentence
          />

          <div className="format-summary">
            <span className="field-label">Format</span>
            <span className="format-value">{activeCodecName} · {activeContainerLabel}</span>
          </div>

          {audioOnly && (
            <p className="panel-note">
              The video is dropped and the soundtrack is saved as AAC in an <strong>.m4a</strong> — plays on phones,
              cars and editors. Set the bitrate below; 192–256 kbps suits most music.
            </p>
          )}

          {!audioOnly && (<>
          <div className="field-block">
            <Segmented<RateMode>
              label="Rate control"
              hint={rateMode === 'size'
                ? (sizePlan ? `under ${targetSizeMb} MB` : 'whole-file budget')
                : rateMode === 'bitrate' ? `${(Number(videoBitrate) / 1000).toFixed(1)} Mbps` : lossless ? 'Lossless' : `CRF ${crf}`}
              options={[
                { id: 'crf', label: 'Quality (CRF)' },
                { id: 'bitrate', label: 'Bitrate' },
                { id: 'size', label: 'Target size' },
              ]}
              value={rateMode}
              onChange={setRateMode}
              sentence
            />

            {rateMode === 'crf' ? (
              <>
                <div className={`crf-control ${lossless ? 'is-lossless' : ''}`}>
                  <input
                    type="range"
                    min={CRF_MIN}
                    max={CRF_MAX}
                    step={1}
                    value={crf}
                    disabled={lossless}
                    onChange={(event) => setCrf(Number(event.target.value))}
                    aria-label="CRF value"
                  />
                  <div className="crf-scale">
                    <span>Lossless · biggest</span>
                    <span>Smallest file</span>
                  </div>
                </div>
                <div className="chip-row">
                  {CRF_PRESETS.map((preset) => (
                    <button
                      type="button"
                      key={preset.id}
                      className={`chip ${crfPreset === preset.id ? 'active' : ''}`}
                      disabled={lossless}
                      onClick={() => { setCrf(preset.crf); setLossless(false) }}
                    >
                      {preset.label}
                      <small>CRF {preset.crf}</small>
                    </button>
                  ))}
                </div>
                <Switch
                  checked={lossless}
                  onChange={setLossless}
                  label="Lossless"
                  hint="Mathematically lossless — very large files"
                  disabled={rateMode !== 'crf'}
                />
              </>
            ) : rateMode === 'bitrate' ? (
              <label className="field">
                <span className="field-label">Target bitrate</span>
                <span className="field-control">
                  <select value={videoBitrate} onChange={(event) => setVideoBitrate(event.target.value)}>
                    <option value="1500">1.5 Mbps</option>
                    <option value="3000">3 Mbps</option>
                    <option value="5000">5 Mbps</option>
                    <option value="8000">8 Mbps</option>
                    <option value="12000">12 Mbps</option>
                    <option value="20000">20 Mbps</option>
                    <option value="30000">30 Mbps</option>
                    <option value="50000">50 Mbps</option>
                  </select>
                </span>
              </label>
            ) : (
              <>
                <label className="field">
                  <span className="field-label">Target file size</span>
                  <span className="field-control">
                    <input
                      className="size-input"
                      type="number"
                      min={1}
                      max={2048}
                      step={1}
                      inputMode="numeric"
                      value={targetSizeMb}
                      onChange={(event) => setTargetSizeMb(event.target.value)}
                      aria-label="Target file size in megabytes"
                    />
                    <span className="size-unit">MB</span>
                  </span>
                </label>
                <div className="chip-row">
                  {TARGET_SIZE_PRESETS.map((preset) => (
                    <button
                      type="button"
                      key={preset.mb}
                      className={`chip ${Number(targetSizeMb) === preset.mb ? 'active' : ''}`}
                      onClick={() => setTargetSizeMb(String(preset.mb))}
                    >
                      {preset.mb} MB
                      <small>{preset.caption}</small>
                    </button>
                  ))}
                </div>
                <p className="plan-line">
                  {sizePlan
                    ? `≈ ${(sizePlan.videoBitrateKbps / 1000).toFixed(2)} Mbps video · ${sizePlan.height}p ${sizePlan.frameRate} fps · fits in ${formatBytes(sizePlan.estimatedBytes)}`
                    : 'Load a video first — its duration sets the bitrate that fits the budget.'}
                </p>
              </>
            )}
          </div>

          <Segmented<SpeedId>
            label="Encoding effort"
            hint={speed === 'quality' ? 'Smallest file' : speed === 'fast' ? 'Fastest' : undefined}
            options={SPEEDS.map((option) => ({ id: option.id, label: option.label, caption: option.caption }))}
            value={speed}
            onChange={setSpeed}
          />

          {hardwareAvailable && (
            <Switch
              checked={hardware}
              onChange={setHardware}
              label="Use the GPU"
              hint="Much faster; the CPU encoder is used when no GPU answers"
              disabled={lossless}
            />
          )}

          <div className="field-row">
            <label className="field">
              <span className="field-label">Codec</span>
              <span className="field-control">
                <select value={codec} onChange={(event) => { const next = event.target.value as CodecId; setCodec(next); setContainer((current) => containerForCodec(next, current)) }}>
                  {AVAILABLE_CODECS.map((option) => <option value={option} key={option}>{CODECS[option].label}</option>)}
                </select>
              </span>
            </label>
            <label className="field">
              <span className="field-label">Container</span>
              <span className="field-control">
                <select value={container} onChange={(event) => { const next = event.target.value as ContainerId; setContainer(next); setCodec((current) => codecForContainer(next, current)) }}>
                  {CONTAINER_ORDER.map((option) => <option value={option} key={option} disabled={!CODECS[codec].containers.includes(option)}>{CONTAINERS[option].label}</option>)}
                </select>
              </span>
            </label>
          </div>

          {!desktopMode && codecUnencodable && (
            <p className="panel-note warn-note">
              <strong>{CODECS[codec].name}</strong>
              {hevcNeedsHardware && acceleration
                ? <> needs a hardware encoder, and {acceleration.browser} has none available.</>
                : <> has no encoder available in this browser.</>}{' '}
              {alternative ? (
                <>
                  <button
                    type="button"
                    className="inline-action"
                    onClick={() => { setCodec(alternative); setContainer((current) => containerForCodec(alternative, current)) }}
                  >
                    Use {CODECS[alternative].name}
                  </button>{' '}
                  instead — it still shrinks files well.
                </>
              ) : null}
              {hevcNeedsHardware && acceleration?.settings && (
                <span className="note-tip">{' '}Or re-enable hardware acceleration in {acceleration.settings} and restart the browser.</span>
              )}
            </p>
          )}

          {!desktopMode && !codecUnencodable && (
            <p className="panel-note">
              <strong>{CODECS[codec].name}</strong> is encoded by this computer, so the file never leaves it.
            </p>
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
          </>)}

          <label className="field">
            <span className="field-label">Audio bitrate</span>
            <span className="field-control">
              <select value={audioBitrate} onChange={(event) => setAudioBitrate(event.target.value)}>
                <option value="64">64 kbps</option>
                <option value="96">96 kbps</option>
                <option value="128">128 kbps</option>
                <option value="192">192 kbps</option>
                <option value="256">256 kbps</option>
                <option value="320">320 kbps</option>
              </select>
            </span>
          </label>

          <div className="action-zone">
            <button className="convert-button" type="button" disabled={!source || isBusy || audioMissing} onClick={() => void convert()}>
              <span className="convert-label">{isBusy ? 'Encoding' : audioOnly ? 'Extract audio (M4A)' : `Convert to ${codecName}`}</span>
              <span className="button-arrow" aria-hidden="true">{isBusy ? `${progress}%` : '↗'}</span>
            </button>

            {audioMissing && <p className="status-text warn">This file has no audio track to extract.</p>}

            {isBusy && (
              <>
                <div className="progress-track" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} aria-label="Conversion progress">
                  <span style={{ transform: `scaleX(${progress / 100})` }} />
                </div>
                <button type="button" className="cancel-button" onClick={() => void cancel()}>Cancel · {elapsed}s elapsed</button>
              </>
            )}

            <p className="status-text" aria-live="polite">{status}</p>

            {result && (
              <div className="result-card">
                <div className="result-head">
                  <span className="result-check" aria-hidden="true">
                    <svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>
                  </span>
                  <span className="result-copy">
                    <strong title={result.name}>{result.name}</strong>
                    <small>{result.sizeLabel}{result.sizeNote ? ` (${result.sizeNote})` : ''} · {result.codecName} · {result.containerName}</small>
                  </span>
                </div>
                <div className="result-actions">
                  {result.path ? (
                    <>
                      <button type="button" className="ghost-button" onClick={() => void revealResult()}>Show in folder</button>
                      <button type="button" className="ghost-button" onClick={() => void playResult()}>Play</button>
                      <button type="button" className="ghost-button" onClick={() => void saveResultCopy()}>Save a copy</button>
                    </>
                  ) : (
                    <>
                      <a className="download-button" href={result.url} download={result.name}>
                        <span className="download-label">Download {result.name}</span>
                        <span aria-hidden="true">↓</span>
                      </a>
                      {canShareFiles && (
                        <button type="button" className="ghost-button" onClick={() => void shareResult()}>Save to device</button>
                      )}
                    </>
                  )}
                </div>
                {result.path && <small className="result-path" title={result.path}>{result.path}</small>}
              </div>
            )}
          </div>
        </aside>
      </section>

      <footer className="footer-note">Made by Bipin Rizal</footer>

      {browserMode && (
        <FileBrowser
          mode={browserMode}
          initialPath={browserMode === 'folder' ? outputDir : (source?.path ? source.path.replace(/[\\/][^\\/]*$/, '') : '')}
          onClose={() => setBrowserMode(null)}
          onChooseFile={handleChosenFile}
          onChooseFolder={handleChosenFolder}
        />
      )}
    </main>
  )
}

export default App
