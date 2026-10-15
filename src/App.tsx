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
type RateMode = 'crf' | 'bitrate'
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
}

type ConvertResult = {
  name: string
  path?: string
  url?: string
  sizeLabel: string
  codec: CodecId
  container: ContainerId
  outputDir?: string
}

type DirectoryHandleLike = {
  name: string
  getFileHandle: (name: string, options?: { create?: boolean }) => Promise<{
    createWritable: () => Promise<{ write: (data: Blob) => Promise<void>; close: () => Promise<void> }>
  }>
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
}

declare global {
  interface Window {
    desktopAPI?: DesktopApi
    showOpenFilePicker?: (options?: unknown) => Promise<{ getFile: () => Promise<File>; name: string }[]>
    showDirectoryPicker?: (options?: unknown) => Promise<DirectoryHandleLike>
  }
}

/* -------------------------------------------------------------- constants */

const CODEC_ORDER: CodecId[] = ['hevc', 'avc', 'av1', 'vp9']
const CONTAINER_ORDER: ContainerId[] = ['mp4', 'mkv', 'mov', 'webm']

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

const WASM_PRESETS: Record<string, Record<SpeedId, string>> = {
  libx265: { fast: 'faster', balanced: 'medium', quality: 'slow' },
  libx264: { fast: 'veryfast', balanced: 'medium', quality: 'slow' },
  libsvtav1: { fast: '10', balanced: '8', quality: '6' },
  'libaom-av1': { fast: '4', balanced: '2', quality: '0' },
  'libvpx-vp9': { fast: '4', balanced: '2', quality: '1' },
}

const SOFTWARE_ENCODERS: Record<CodecId, string[]> = {
  hevc: ['libx265'],
  avc: ['libx264'],
  av1: ['libsvtav1', 'libaom-av1'],
  vp9: ['libvpx-vp9'],
}

const VIDEO_ACCEPT = 'video/*,.mp4,.m4v,.mkv,.mov,.webm,.avi,.wmv,.flv,.ts,.m2ts,.mts,.mpg,.mpeg,.3gp,.ogv'

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

function codecForContainer(container: ContainerId, codec: CodecId): CodecId {
  if (CODECS[codec].containers.includes(container)) return codec
  return CODEC_ORDER.find((candidate) => CODECS[candidate].containers.includes(container)) ?? 'avc'
}

// A local media probe that never touches the disk: the browser decodes the header only.
function probeBlob(file: File): Promise<{ duration: number; width: number; height: number }> {
  return new Promise((resolve) => {
    const video = document.createElement('video')
    const url = URL.createObjectURL(file)
    const done = (duration: number, width: number, height: number) => {
      video.removeAttribute('src')
      URL.revokeObjectURL(url)
      resolve({ duration, width, height })
    }
    video.preload = 'metadata'
    video.onloadedmetadata = () => done(Number.isFinite(video.duration) ? video.duration : 0, video.videoWidth || 0, video.videoHeight || 0)
    video.onerror = () => done(0, 0, 0)
    video.src = url
  })
}

/* ------------------------------------------------------ encoder arg (wasm) */

type WasmArgs = {
  codec: CodecId
  container: ContainerId
  encoder: string
  includeSubtitles: boolean
  rateMode: RateMode
  lossless: boolean
  crf: number
  videoBitrate: number
  audioBitrate: number
  resolution: string
  frameRate: string
  speed: SpeedId
  inputName: string
  outputName: string
}

function buildWasmArgs(o: WasmArgs): string[] {
  const isIsobmff = o.container === 'mp4' || o.container === 'mov'
  const preset = WASM_PRESETS[o.encoder]?.[o.speed]
  const args = ['-y', '-fflags', '+genpts', '-i', o.inputName, '-map', '0:V:0', '-map', '0:a?']
  if (o.includeSubtitles) args.push('-map', '0:s?')
  args.push('-c:v', o.encoder)

  switch (o.encoder) {
    case 'libx265':
      if (preset) args.push('-preset', preset)
      if (o.lossless) args.push('-x265-params', 'lossless=1')
      else if (o.rateMode === 'bitrate') args.push('-b:v', `${o.videoBitrate}k`)
      else args.push('-crf', String(o.crf))
      break
    case 'libx264':
      if (preset) args.push('-preset', preset)
      if (o.lossless) args.push('-qp', '0')
      else if (o.rateMode === 'bitrate') args.push('-b:v', `${o.videoBitrate}k`)
      else args.push('-crf', String(o.crf))
      break
    case 'libsvtav1':
      if (preset) args.push('-preset', preset)
      if (o.lossless) args.push('-crf', '0')
      else if (o.rateMode === 'bitrate') args.push('-b:v', `${o.videoBitrate}k`)
      else args.push('-crf', String(o.crf))
      break
    case 'libaom-av1':
      args.push('-cpu-used', preset || '6', '-row-mt', '1')
      if (o.lossless) args.push('-lossless', '1')
      else if (o.rateMode === 'bitrate') args.push('-b:v', `${o.videoBitrate}k`)
      else args.push('-crf', String(o.crf), '-b:v', '0')
      break
    case 'libvpx-vp9':
      args.push('-deadline', o.speed === 'fast' ? 'realtime' : 'good', '-cpu-used', preset || '2', '-row-mt', '1')
      if (o.lossless) args.push('-lossless', '1')
      else if (o.rateMode === 'bitrate') args.push('-b:v', `${o.videoBitrate}k`)
      else args.push('-crf', String(o.crf), '-b:v', '0')
      break
    default:
      break
  }

  args.push('-pix_fmt', 'yuv420p')
  if (o.codec === 'hevc' && isIsobmff) args.push('-tag:v', 'hvc1')
  args.push('-c:a', o.container === 'webm' ? 'libopus' : 'aac', '-b:a', `${o.audioBitrate}k`)
  if (o.includeSubtitles) args.push('-c:s', 'copy')
  const filters: string[] = []
  if (o.resolution !== 'source') filters.push(`scale=${o.resolution}:-2`)
  filters.push('scale=trunc(iw/2)*2:trunc(ih/2)*2')
  args.push('-vf', filters.join(','))
  if (o.frameRate !== 'source') args.push('-r', String(o.frameRate), '-fps_mode', 'cfr')
  args.push('-max_muxing_queue_size', '1024')
  if (isIsobmff) args.push('-movflags', '+faststart')
  args.push(o.outputName)
  return args
}

function buildWasmPlans(codec: CodecId, container: ContainerId): { codec: CodecId; container: ContainerId; encoder: string; includeSubtitles: boolean }[] {
  const plans: { codec: CodecId; container: ContainerId; encoder: string; includeSubtitles: boolean }[] = []
  const seen = new Set<string>()
  const add = (nextCodec: CodecId, nextContainer: ContainerId, includeSubtitles: boolean) => {
    for (const encoder of SOFTWARE_ENCODERS[nextCodec]) {
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

function createOutputFormat(container: ContainerId): OutputFormat {
  if (container === 'mkv') return new MkvOutputFormat()
  if (container === 'webm') return new WebMOutputFormat()
  if (container === 'mov') return new MovOutputFormat({ fastStart: 'in-memory' })
  return new Mp4OutputFormat({ fastStart: 'in-memory' })
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
  const inputRef = useRef<HTMLInputElement>(null)
  const outputHandleRef = useRef<DirectoryHandleLike | null>(null)
  const requestIdRef = useRef('')
  const startedAtRef = useRef(0)

  const [source, setSource] = useState<Source | null>(null)
  const [result, setResult] = useState<ConvertResult | null>(null)

  const [codec, setCodec] = useState<CodecId>('hevc')
  const [container, setContainer] = useState<ContainerId>('mp4')
  const [rateMode, setRateMode] = useState<RateMode>('crf')
  const [lossless, setLossless] = useState(false)
  const [crf, setCrf] = useState(23)
  const [videoBitrate, setVideoBitrate] = useState('8000')
  const [resolution, setResolution] = useState('source')
  const [frameRate, setFrameRate] = useState('source')
  const [audioBitrate, setAudioBitrate] = useState('192')
  const [speed, setSpeed] = useState<SpeedId>('balanced')
  const [hardware, setHardware] = useState(false)

  const [outputDir, setOutputDir] = useState('')
  const [browserMode, setBrowserMode] = useState<'file' | 'folder' | null>(null)

  const [status, setStatus] = useState('Ready when you are')
  const [progress, setProgress] = useState(0)
  const [isBusy, setIsBusy] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [isDark, setIsDark] = useState(true)
  const [desktopMode, setDesktopMode] = useState(false)

  const crfPreset = CRF_PRESETS.find((preset) => preset.crf === crf && !lossless)?.id

  const codecName = CODECS[codec].name
  const containerLabel = CONTAINERS[container].label
  const hardwareAvailable = desktopMode

  /* ---------------------------------------------------------- lifecycle */

  useEffect(() => {
    let cancelled = false
    const api = desktop()
    if (!api) return
    void api.appInfo().then(() => { if (!cancelled) setDesktopMode(true) }).catch(() => {})
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
    setSource({ name: file.name, size: file.size, duration: meta.duration, width: meta.width, height: meta.height, file })
    setResult(null)
    setProgress(0)
    setStatus('Video ready to convert')
  }, [])

  const adoptPath = useCallback(async (targetPath: string) => {
    const api = desktop()
    setStatus('Reading video details…')
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
      path: targetPath,
    })
    setResult(null)
    setProgress(0)
    setStatus('Video ready to convert')
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
        const [handle] = await window.showOpenFilePicker({ multiple: false, types: [{ description: 'Video', accept: { 'video/*': ['.mp4', '.m4v', '.mkv', '.mov', '.webm', '.avi', '.wmv', '.flv', '.ts', '.mpg', '.mpeg', '.3gp', '.ogv'] } }] })
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

  const finalizeBrowser = useCallback(async (blob: Blob, resultCodec: CodecId, resultContainer: ContainerId): Promise<ConvertResult> => {
    const name = `${source?.name.replace(/\.[^/.]+$/, '') || 'output'}-${CODECS[resultCodec].slug}.${CONTAINERS[resultContainer].extension}`
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
      codec: resultCodec,
      container: resultContainer,
      outputDir: saved ? outputHandleRef.current?.name : undefined,
    }
  }, [source])

  const runBrowserConversion = useCallback(async (): Promise<ConvertResult> => {
    const file = source?.file
    if (!file) throw new Error('This file cannot be read in the browser')
    const targetWidth = resolution === 'source' ? undefined : Number(resolution)
    const targetFrameRate = frameRate === 'source' ? undefined : Number(frameRate)
    const encodingQuality = rateMode === 'bitrate'
      ? new Quality({ bitrate: Number(videoBitrate) * 1000, bitrateMode: 'variable' })
      : new Quality({ quantizer: lossless ? 0 : crf })

    // Device / WebCodecs encoder first: it produces a properly muxed file and is fast.
    const probe = await canEncodeVideo(codec, { width: targetWidth, frameRate: targetFrameRate }).catch(() => true as const)
    if (probe !== false) {
      try {
        setStatus(`Encoding ${CODECS[codec].name} with the device encoder…`)
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
            keyFrameInterval: 2,
            hardwareAcceleration: hardware ? 'prefer-hardware' : 'no-preference',
          },
          showWarnings: false,
        })
        if (!conversion.isValid) throw new Error('No browser-decodable track in this file')
        conversion.onProgress = (value) => {
          setProgress(Math.max(0, Math.min(100, Math.round(value * 100))))
        }
        await conversion.execute()
        if (!output.target.buffer) throw new Error('The encoder returned an empty file')
        return finalizeBrowser(new Blob([output.target.buffer], { type: CONTAINERS[container].mimeType }), codec, container)
      } catch (deviceError) {
        console.warn('Device encoder unavailable, falling back to FFmpeg WASM', deviceError)
      }
    }

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
      const plans = buildWasmPlans(codec, container)
      let lastError: unknown
      for (const plan of plans) {
        const outputName = `output.${CONTAINERS[plan.container].extension}`
        try {
          setStatus(`Encoding ${CODECS[plan.codec].name} locally with FFmpeg…`)
          await ffmpeg.exec(buildWasmArgs({
            codec: plan.codec,
            container: plan.container,
            encoder: plan.encoder,
            includeSubtitles: plan.includeSubtitles,
            rateMode,
            lossless,
            crf,
            videoBitrate: Number(videoBitrate),
            audioBitrate: Number(audioBitrate),
            resolution,
            frameRate,
            speed,
            inputName,
            outputName,
          }))
          const data = await ffmpeg.readFile(outputName)
          const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
          return finalizeBrowser(new Blob([bytes.buffer as ArrayBuffer], { type: CONTAINERS[plan.container].mimeType }), plan.codec, plan.container)
        } catch (planError) {
          console.warn(`${plan.encoder} into ${plan.container} failed`, planError)
          lastError = planError
        }
      }
      throw lastError instanceof Error ? lastError : new Error('The local encoder could not process this file')
    } finally {
      ffmpeg.off('progress', onProgress)
    }
  }, [source, resolution, frameRate, rateMode, videoBitrate, lossless, crf, codec, container, hardware, audioBitrate, speed, finalizeBrowser])

  const convert = useCallback(async () => {
    if (!source || isBusy) return
    startedAtRef.current = Date.now()
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
          const nativeResult = await api.convertVideo({
            requestId,
            inputPath: source.path,
            codec,
            container,
            mode: rateMode === 'crf' && lossless ? 'lossless' : 'crf',
            rateControl: rateMode,
            crf,
            videoBitrate: Number(videoBitrate),
            audioBitrate: Number(audioBitrate),
            resolution,
            frameRate,
            speed,
            hardware,
            outputDir: outputDir || undefined,
          })
          setProgress(100)
          setResult({
            name: basename(nativeResult.outputPath),
            path: nativeResult.outputPath,
            sizeLabel: nativeResult.sizeLabel || formatBytes(nativeResult.size),
            codec: nativeResult.codec as CodecId,
            container: nativeResult.container as ContainerId,
            outputDir: outputDir || undefined,
          })
          setStatus(`Done — ${CODECS[nativeResult.codec as CodecId].label} written to disk`)
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
      if ((error as { cancelled?: boolean }).cancelled) {
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
  }, [source, isBusy, codec, container, rateMode, lossless, crf, videoBitrate, audioBitrate, resolution, frameRate, speed, hardware, outputDir, runBrowserConversion])

  const cancel = useCallback(async () => {
    const id = requestIdRef.current
    if (id) await desktop()?.cancelConvert(id)
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

  /* ---------------------------------------------------------------- view */

  const sourceMeta = source
    ? [source.width && source.height ? `${source.width}×${source.height}` : '', source.duration ? formatDuration(source.duration) : '', source.size ? formatBytes(source.size) : ''].filter(Boolean).join('  ·  ')
    : ''

  return (
    <main className={`app-shell ${isDark ? 'dark-mode' : ''}`}>
      <div className="aurora" aria-hidden="true" />

      <header className="topbar">
        <a className="brand" href="/" aria-label="Rizal_convert home">
          <span className="brand-mark">R</span>
          <span className="brand-copy">
            <span className="brand-name">RIZAL_CONVERT</span>
            <span className="brand-tag">Local video optimiser</span>
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
        <p className="eyebrow"><span aria-hidden="true" />LOCAL VIDEO OPTIMISER</p>
        <h1>Make your video <em>lighter</em>.</h1>
        <p className="intro-sub">Shrink it locally, keep the quality. Nothing ever leaves this device.</p>
      </section>

      <section className="card" aria-label="Video converter">
        {/* -------------------------------------------------- source pane */}
        <div className="upload-panel">
          <input
            ref={inputRef}
            type="file"
            accept={VIDEO_ACCEPT}
            style={{ display: 'none' }}
            onChange={(event) => { const next = event.target.files?.[0]; if (next) void adoptDropped(next); event.target.value = '' }}
          />

          <div
            className={`drop-zone ${source ? 'has-file' : ''} ${isDragging ? 'dragging' : ''}`}
            role="button"
            tabIndex={0}
            onClick={() => { if (!source) void openFileBrowser() }}
            onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void openFileBrowser() } }}
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
                  <button type="button" className="ghost-button" onClick={(event) => { event.stopPropagation(); void openFileBrowser() }}>Change</button>
                  <button type="button" className="ghost-button" onClick={(event) => { event.stopPropagation(); clearSource() }}>Remove</button>
                </div>
              </div>
            ) : (
              <>
                <span className="upload-glyph" aria-hidden="true">
                  <svg viewBox="0 0 24 24"><path d="M12 19V6M6 11.6 12 5.6l6 6" /></svg>
                </span>
                <strong className="drop-title">Drop a video here</strong>
                <small>or click to browse your files</small>
                <small className="drop-formats">MP4 · MOV · MKV · AVI · WEBM and more</small>
              </>
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
        </div>

        {/* ------------------------------------------------ settings pane */}
        <aside className="settings-panel">
          <div className="panel-heading"><span>01</span><h2>Output settings</h2></div>

          <div className="format-summary">
            <span className="field-label">Format</span>
            <span className="format-value">{CODECS[codec].label} · {containerLabel}</span>
          </div>

          <div className="field-block">
            <Segmented<RateMode>
              label="Rate control"
              hint={rateMode === 'bitrate' ? `${(Number(videoBitrate) / 1000).toFixed(1)} Mbps` : lossless ? 'Lossless' : `CRF ${crf}`}
              options={[
                { id: 'crf', label: 'Quality (CRF)' },
                { id: 'bitrate', label: 'Bitrate' },
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
            ) : (
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
                  {CODEC_ORDER.map((option) => <option value={option} key={option}>{CODECS[option].label}</option>)}
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
            <button className="convert-button" type="button" disabled={!source || isBusy} onClick={() => void convert()}>
              <span className="convert-label">{isBusy ? 'Encoding' : `Convert to ${codecName}`}</span>
              <span className="button-arrow" aria-hidden="true">{isBusy ? `${progress}%` : '↗'}</span>
            </button>

            {isBusy && (
              <>
                <div className="progress-track" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} aria-label="Conversion progress">
                  <span style={{ transform: `scaleX(${progress / 100})` }} />
                </div>
                {desktopMode ? (
                  <button type="button" className="cancel-button" onClick={() => void cancel()}>Cancel · {elapsed}s elapsed</button>
                ) : (
                  <p className="status-text subtle">{elapsed}s elapsed</p>
                )}
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
                    <small>{result.sizeLabel} · {CODECS[result.codec].name} · {CONTAINERS[result.container].label}</small>
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
                    <a className="download-button" href={result.url} download={result.name}>
                      <span className="download-label">Download {result.name}</span>
                      <span aria-hidden="true">↓</span>
                    </a>
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
