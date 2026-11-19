import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import readline from 'readline'
import zlib from 'zlib'

// GSI recorder / replayer.
//
// Records raw GSI payloads to gzipped JSON Lines so a match can be replayed later without
// CS2 running: to tune the director, to test HUDs, or to build regression fixtures.
//
// File format (.jsonl.gz):
//   line 1:  {"v":1,"startedAt":<epoch ms>,"map":"de_mirage"}
//   line n:  {"t":<ms since start>,"d":<raw GSI payload>}

const MAX_RATE_MS = 50 // record at most 20 payloads/second; CS2 can send far more
const FORMAT_VERSION = 1

export interface RecordingInfo {
  name: string
  sizeBytes: number
  modifiedAt: number
}

export interface RecorderStatus {
  recording: boolean
  recordingName: string | null
  recordedFrames: number
  replaying: boolean
  replayName: string | null
  replayPaused: boolean
  replaySpeed: number
  replayPositionMs: number
}

type Listener = (s: RecorderStatus) => void
const listeners = new Set<Listener>()
export const onRecorderStatus = (l: Listener): (() => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}
const notify = (): void => {
  const s = getRecorderStatus()
  for (const l of listeners) l(s)
}

export const getRecordingsDir = (): string => {
  const dir = path.join(app.getPath('userData'), 'gsi-recordings')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** Resolve a recording name to a path inside the recordings dir (no traversal) */
const resolveRecording = (name: string): string => {
  const base = path.basename(String(name))
  if (!base.endsWith('.jsonl.gz')) throw new Error('Not a recording file')
  return path.join(getRecordingsDir(), base)
}

export const listRecordings = (): RecordingInfo[] =>
  fs
    .readdirSync(getRecordingsDir())
    .filter((f) => f.endsWith('.jsonl.gz'))
    .map((name) => {
      const st = fs.statSync(path.join(getRecordingsDir(), name))
      return { name, sizeBytes: st.size, modifiedAt: st.mtimeMs }
    })
    .sort((a, b) => b.modifiedAt - a.modifiedAt)

export const deleteRecording = (name: string): void => {
  if (gsiReplayer.name === path.basename(name)) gsiReplayer.stop()
  if (gsiRecorder.name === path.basename(name)) throw new Error('Stop the recording first')
  fs.unlinkSync(resolveRecording(name))
}

// ------------------------------------------------------------------ recorder

class GsiRecorder {
  private gzip: zlib.Gzip | null = null
  private startedAt = 0
  private lastAt = 0
  name: string | null = null
  frames = 0

  get active(): boolean {
    return !!this.gzip
  }

  start(label?: string): string {
    if (this.gzip) return this.name!
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const safe = (label ?? '').replace(/[^a-z0-9_-]+/gi, '_').slice(0, 40)
    this.name = `${stamp}${safe ? `_${safe}` : ''}.jsonl.gz`
    const out = fs.createWriteStream(path.join(getRecordingsDir(), this.name))
    this.gzip = zlib.createGzip({ level: 6 })
    this.gzip.pipe(out)
    this.startedAt = Date.now()
    this.lastAt = 0
    this.frames = 0
    this.gzip.write(JSON.stringify({ v: FORMAT_VERSION, startedAt: this.startedAt }) + '\n')
    notify()
    return this.name
  }

  /** Called with every live payload, BEFORE any mutation by the GSI pipeline */
  capture(payload: unknown): void {
    if (!this.gzip) return
    const now = Date.now()
    if (now - this.lastAt < MAX_RATE_MS) return
    this.lastAt = now
    this.gzip.write(JSON.stringify({ t: now - this.startedAt, d: payload }) + '\n')
    this.frames++
    if (this.frames % 100 === 0) notify()
  }

  stop(): void {
    if (!this.gzip) return
    this.gzip.end()
    this.gzip = null
    this.name = null
    notify()
  }
}

// ------------------------------------------------------------------ replayer

/** virtualNow: recording time mapped onto a monotonic clock, so game timing survives speed changes */
type Sink = (payload: any, virtualNow: number) => void

class GsiReplayer {
  private sink: Sink | null = null
  private session = 0
  name: string | null = null
  paused = false
  speed = 1
  positionMs = 0
  private resumeWaiters: (() => void)[] = []
  // Playback clock: frame t is due at wallStart + (t - mediaStart) / speed
  private wallStart = 0
  private mediaStart = 0
  private virtualEpoch = 0

  get active(): boolean {
    return !!this.name
  }

  setSink(sink: Sink): void {
    this.sink = sink
  }

  async start(name: string, speed = 1): Promise<void> {
    const file = resolveRecording(name)
    if (!fs.existsSync(file)) throw new Error('Recording not found')
    this.stop()
    const session = ++this.session
    this.name = path.basename(file)
    this.speed = speed
    this.paused = false
    this.positionMs = 0
    notify()

    // Run in the background; resolves once playback has started
    this.play(file, session).catch((err) => {
      console.error('[Replay] failed:', err)
      if (this.session === session) this.stop()
    })
  }

  private async play(file: string, session: number): Promise<void> {
    const rl = readline.createInterface({
      input: fs.createReadStream(file).pipe(zlib.createGunzip()),
      crlfDelay: Infinity
    })
    let first = true
    let lastNotify = 0

    try {
      for await (const line of rl) {
        if (this.session !== session) return
        if (!line.trim()) continue
        const entry = JSON.parse(line)
        if (entry.v !== undefined) continue // header

        if (first) {
          first = false
          this.mediaStart = entry.t
          this.wallStart = Date.now()
          this.virtualEpoch = Date.now() - entry.t
        }

        // Wait until this frame is due (respecting speed and pause)
        for (;;) {
          if (this.session !== session) return
          if (this.paused) {
            await new Promise<void>((r) => this.resumeWaiters.push(r))
            // Resume from where we stopped
            this.mediaStart = this.positionMs
            this.wallStart = Date.now()
            continue
          }
          const due = this.wallStart + (entry.t - this.mediaStart) / this.speed
          const wait = due - Date.now()
          if (wait <= 0) break
          await new Promise((r) => setTimeout(r, Math.min(wait, 200)))
        }

        this.positionMs = entry.t
        try {
          this.sink?.(entry.d, this.virtualEpoch + entry.t)
        } catch (err) {
          console.error('[Replay] sink error:', err)
        }
        if (Date.now() - lastNotify > 1000) {
          lastNotify = Date.now()
          notify()
        }
      }
    } finally {
      rl.close()
    }
    if (this.session === session) this.stop()
  }

  setSpeed(speed: number): void {
    // Rebase the clock on the current position so a speed change doesn't jump
    this.mediaStart = this.positionMs
    this.wallStart = Date.now()
    this.speed = Math.min(16, Math.max(0.25, speed))
    notify()
  }

  setPaused(paused: boolean): void {
    this.paused = paused
    if (!paused) {
      const w = this.resumeWaiters
      this.resumeWaiters = []
      w.forEach((r) => r())
    }
    notify()
  }

  stop(): void {
    if (!this.name) return
    this.session++
    this.name = null
    this.paused = false
    const w = this.resumeWaiters
    this.resumeWaiters = []
    w.forEach((r) => r())
    notify()
  }
}

export const gsiRecorder = new GsiRecorder()
export const gsiReplayer = new GsiReplayer()

export const getRecorderStatus = (): RecorderStatus => ({
  recording: gsiRecorder.active,
  recordingName: gsiRecorder.name,
  recordedFrames: gsiRecorder.frames,
  replaying: gsiReplayer.active,
  replayName: gsiReplayer.name,
  replayPaused: gsiReplayer.paused,
  replaySpeed: gsiReplayer.speed,
  replayPositionMs: gsiReplayer.positionMs
})
