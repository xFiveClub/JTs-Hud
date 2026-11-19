import type { CSGORaw } from 'csgogsi'
import type { Server } from 'socket.io'
import { netcon } from '../integrations/netcon'
import { getSettings } from '../domains/settings/settings.routes'
import { DirectorConfig, getApiKey, getDirectorConfig } from './config'
import { AIPlan, buildRoundSummary, requestPlan } from './llm'
import {
  Bias,
  PlayerSnapshot,
  RoundTracker,
  ScoredPlayer,
  scorePlayers,
  snapshotPlayer
} from './scorer'
import { getZones, zoneAt } from './zones'

// AI Director: picks who the observer camera follows and sends it to CS2 over netcon.
//
// Cut rules (what a professional observer does):
//  - a shot lasts at least `minShotMs`, unless the player dies or a plant/defuse starts elsewhere
//  - never cut away from a player who is trading damage
//  - after a death, hold briefly, then go to the killer
//  - a new candidate must beat the current shot clearly (`switchMargin`) and for a moment (no flicker)
//  - if the human observer changes the camera, back off for `manualOverrideMs`
//
// All timing uses the `now` passed with each tick, so replays at 4x behave like the real match.

const STEAMID64_BASE = 76561197960265728n
const CANDIDATE_SUSTAIN_MS = 300
const RESEND_GUARD_MS = 1500
const COMMAND_CONFIRM_MS = 2500
const PLAN_TTL_MS = 30000
const AI_EVENT_MIN_GAP_MS = 4000
const STATUS_INTERVAL_MS = 250
const OVERLAY_INTERVAL_MS = 250
const RECONNECT_INTERVAL_MS = 3000
const LOOKAHEAD_STALE_MS = 3000
const LOOKAHEAD_CALM_MS = 3000
const PREDICTED_MIN_SHOT_MS = 1000

export interface CutLogEntry {
  at: number
  name: string
  reason: string
}

export interface DirectorStatus {
  enabled: boolean
  simulation: boolean
  lockedOn: string | null
  netconConnected: boolean
  netconTarget: string
  receivingGsi: boolean
  lookahead: { receiving: boolean; active: boolean; predicted: string[] }
  map: string | null
  phase: string | null
  pausedForMs: number
  observed: { steamid: string; name: string } | null
  players: {
    steamid: string
    name: string
    side: 'CT' | 'T'
    zone: string | null
    pos: number[] | null
  }[]
  scores: {
    steamid: string
    name: string
    side: 'CT' | 'T'
    score: number
    inCombat: boolean
    reasons: string[]
  }[]
  cuts: CutLogEntry[]
  warning: string | null
  execute: string | null
  ai: {
    enabled: boolean
    state: 'off' | 'idle' | 'thinking' | 'error'
    storyline: string | null
    focusSide: 'CT' | 'T' | null
    weights: { name: string; weight: number }[]
    latencyMs: number | null
    planAgeMs: number | null
    error: string | null
  }
}

/** What the director overlay (browser source) renders */
export interface OverlayState {
  active: boolean
  teams: { CT: string | null; T: string | null }
  onCamera: { name: string; side: 'CT' | 'T'; reason: string | null } | null
  storyline: string | null
  focusCard: {
    name: string
    side: 'CT' | 'T'
    kills: number
    deaths: number
    assists: number
    mvps: number
    money: number
    primary: string | null
    title: string
  } | null
  clutch: { name: string; side: 'CT' | 'T'; vs: number; hp: number } | null
  execute: { side: 'CT' | 'T'; text: string } | null
}

const accountIdOf = (steamid: string): string => {
  try {
    return (BigInt(steamid) - STEAMID64_BASE).toString()
  } catch {
    return steamid
  }
}

/** Quote a value for the CS2 console: strip quotes and command separators */
const consoleSafe = (s: string): string => s.replace(/["';\r\n]/g, '')

class Director {
  private io: Server | null = null
  private enabled = false
  private config: DirectorConfig | null = null
  private telnet = { host: '127.0.0.1', port: 2020 }

  // Simulation: no commands are sent; the director's choice becomes the camera.
  // Used for replays and tests.
  private simulation = false
  private virtualCamera: string | null = null

  private tracker = new RoundTracker()
  private players: PlayerSnapshot[] = []
  private scored: ScoredPlayer[] = []
  private raw: CSGORaw | null = null
  private lastGsiAt = 0
  /** Difference between tick time and wall time (non-zero during replays) */
  private clockOffset = 0

  private observed: string | null = null
  private shotStart = 0
  private lastCommand: { steamid: string; at: number } | null = null
  /** Last command still waiting for CS2 to confirm via GSI */
  private pendingCommand: { steamid: string; at: number } | null = null
  private candidate: { steamid: string; since: number } | null = null
  private pausedUntil = 0
  private warning: string | null = null
  private cuts: CutLogEntry[] = []
  private lastCutReason: string | null = null
  private lockedOn: string | null = null
  private forceNext = false

  private roundPhase: string | null = null
  private phaseChangedAt = 0
  private roundNumber = -1

  private plan: AIPlan | null = null
  private aiState: 'idle' | 'thinking' | 'error' = 'idle'
  private aiError: string | null = null
  private lastAiAt = 0
  private plannedFreezetimeRound = -1
  private aiTrigger = false
  private lastAliveCounts = ''
  private executesSeen = 0

  // Look-ahead feed (undelayed GSI from a second client)
  private la = {
    tracker: new RoundTracker(),
    lastAt: 0,
    phase: null as string | null,
    lastCombat: new Map<string, number>(),
    bombState: null as string | null,
    upcoming: [] as { steamid: string; at: number; label: string }[]
  }
  private predicted = new Map<string, string>()

  private statusTimer: NodeJS.Timeout | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private lastStatusAt = 0
  private lastOverlayAt = 0
  private lastOverlayJson = ''

  attach(io: Server): void {
    this.io = io
    netcon.onStatus(() => this.emitStatus(true))
  }

  isEnabled(): boolean {
    return this.enabled
  }

  private wallNow(): number {
    return Date.now() + this.clockOffset
  }

  async start(): Promise<void> {
    this.config = await getDirectorConfig()
    const settings = await getSettings()
    this.telnet = { host: settings.telnetHost, port: settings.telnetPort }
    this.enabled = true
    this.pausedUntil = 0
    this.warning = null
    this.candidate = null
    this.lockedOn = null
    this.shotStart = this.wallNow()
    this.log('—', this.simulation ? 'Director started (simulation)' : 'Director started')

    await this.ensureConnected()
    // The socket may already be open (Spectator Binds uses it too): always hand the camera
    // over explicitly when the director starts
    if (!this.simulation && netcon.connected && this.config.disableGameAutodirector) {
      await netcon.send('spec_autodirector 0').catch(() => {})
    }
    if (!this.reconnectTimer) {
      this.reconnectTimer = setInterval(() => this.ensureConnected(), RECONNECT_INTERVAL_MS)
    }
    if (!this.statusTimer) {
      // Keeps the UI fresh even when no GSI is arriving
      this.statusTimer = setInterval(() => this.emitStatus(true), 1000)
    }
    this.emitStatus(true)
  }

  stop(): void {
    this.enabled = false
    this.lockedOn = null
    if (this.reconnectTimer) clearInterval(this.reconnectTimer)
    if (this.statusTimer) clearInterval(this.statusTimer)
    this.reconnectTimer = null
    this.statusTimer = null
    this.log('—', 'Director stopped')
    this.emitStatus(true)
    this.emitOverlay(true)
  }

  async toggle(): Promise<boolean> {
    if (this.enabled) this.stop()
    else await this.start()
    return this.enabled
  }

  /** Simulation mode: decide cuts without touching CS2 (replays, tuning, tests) */
  setSimulation(on: boolean): void {
    if (this.simulation === on) return
    this.simulation = on
    this.virtualCamera = null
    this.observed = null
    this.pendingCommand = null
    this.warning = null
    this.log('—', on ? 'Simulation on: CS2 camera is not moved' : 'Simulation off')
    if (!on) this.clockOffset = 0
    this.emitStatus(true)
  }

  isSimulation(): boolean {
    return this.simulation
  }

  /** Lock the camera on the current player (toggle). Released automatically on death. */
  toggleLock(): string | null {
    if (this.lockedOn) {
      const name = this.nameOf(this.lockedOn)
      this.lockedOn = null
      this.log(name, 'Lock released')
    } else if (this.observed) {
      this.lockedOn = this.observed
      this.log(this.nameOf(this.observed), 'Locked on player')
    }
    this.emitStatus(true)
    return this.lockedOn
  }

  /** Cut to the next best player right now, ignoring timing rules and manual pause */
  requestNextCut(): void {
    this.forceNext = true
    this.pausedUntil = 0
  }

  /** Re-read config after the UI saved it */
  async reloadConfig(): Promise<void> {
    this.config = await getDirectorConfig()
    const settings = await getSettings()
    const changed =
      settings.telnetHost !== this.telnet.host || settings.telnetPort !== this.telnet.port
    this.telnet = { host: settings.telnetHost, port: settings.telnetPort }
    if (changed && this.enabled) await this.ensureConnected()
    this.emitStatus(true)
    this.emitOverlay(true)
  }

  private async ensureConnected(): Promise<void> {
    if (!this.enabled || this.simulation) return
    const wasConnected = netcon.connected
    try {
      await netcon.connect(this.telnet.host, this.telnet.port)
      if (!wasConnected) {
        if (this.isConnectionWarning()) this.warning = null
        if (this.config?.disableGameAutodirector) await netcon.send('spec_autodirector 0')
      }
    } catch (err: any) {
      this.warning = `Cannot reach CS2 on ${this.telnet.host}:${this.telnet.port} (${err?.message ?? err}). Launch CS2 with -netconport ${this.telnet.port}.`
    }
  }

  private nameOf(steamid: string): string {
    return this.players.find((p) => p.steamid === steamid)?.name ?? steamid
  }

  // ---------------------------------------------------------------- GSI tick

  onGameState(raw: CSGORaw, excluded: Set<string>, now = Date.now()): void {
    this.clockOffset = now - Date.now()
    this.raw = raw
    this.lastGsiAt = now

    // Round bookkeeping
    const phase = raw.round?.phase ?? null
    const round = raw.map?.round ?? -1
    if (phase !== this.roundPhase) {
      if (phase === 'freezetime') {
        this.tracker.reset()
        this.executesSeen = 0
        this.tracker.logRoundEvent('round_start', `Round ${round + 1} freezetime`, now)
      }
      if (phase === 'over') this.tracker.logRoundEvent('round_end', 'Round over', now)
      this.roundPhase = phase
      this.phaseChangedAt = now
      if (phase === 'freezetime' || phase === 'live') this.aiTrigger = true
    }
    this.roundNumber = round

    const zones = getZones(raw.map?.name ?? '')
    this.tracker.zoneOf = (pos) => zoneAt(zones, pos)?.name ?? null
    this.players = Object.entries(raw.allplayers ?? {})
      .filter(([steamid]) => !excluded.has(steamid))
      .map(([steamid, p]) => {
        const snap = snapshotPlayer(steamid, p)
        snap.zone = zoneAt(zones, snap.pos)?.name ?? null
        return snap
      })
    this.tracker.update(this.players, raw, now)

    // Clutches, plants and executes change the story: ask the AI to re-read
    const aliveKey = ['CT', 'T']
      .map((s) => this.players.filter((p) => p.side === s && p.alive).length)
      .join('v')
    if (aliveKey !== this.lastAliveCounts) {
      if (/(^1v|v1$)/.test(aliveKey)) this.aiTrigger = true
      this.lastAliveCounts = aliveKey
    }
    if (raw.bomb?.state === 'planted' && raw.previously?.bomb?.state) this.aiTrigger = true
    if (this.tracker.executes.length !== this.executesSeen) {
      this.executesSeen = this.tracker.executes.length
      this.aiTrigger = true
    }

    const bias: Bias = new Map()
    let focusSide: 'CT' | 'T' | null = null
    if (this.plan && now - this.plan.createdAt < PLAN_TTL_MS) {
      for (const [id, w] of Object.entries(this.plan.weights)) bias.set(id, w)
      focusSide = this.plan.focusSide
    }
    this.predicted = this.computePredictions()
    this.scored = scorePlayers(this.players, {
      raw,
      tracker: this.tracker,
      now,
      bias,
      focusSide,
      predicted: this.predicted
    })

    this.trackObserved(raw, now)

    if (this.enabled && this.config) {
      if (now >= this.pausedUntil) {
        const decision = this.decide(raw, now)
        if (decision) this.cutTo(decision.steamid, decision.reason, now)
      }
      this.maybeAskAI(now)
    }

    this.emitStatus(false)
    this.emitOverlay(false)
  }

  /** Who is CS2 showing right now, and did a human change it? */
  private trackObserved(raw: CSGORaw, now: number): void {
    let spectating: string | null
    if (this.simulation) {
      spectating = this.virtualCamera
    } else {
      const p = raw.player
      spectating =
        p && p.steamid && p.steamid !== raw.provider?.steamid && p.spectarget !== 'free'
          ? p.steamid
          : null
    }
    const prev = this.observed
    const pending = this.pendingCommand

    if (spectating === prev) {
      // A command we sent never took effect
      if (pending && now - pending.at > COMMAND_CONFIRM_MS) {
        this.pendingCommand = null
        if (this.enabled && !this.isConnectionWarning()) {
          this.warning =
            'CS2 did not switch to the requested player. Check the command template and that you are spectating (not playing).'
        }
      }
      return
    }

    this.observed = spectating
    this.shotStart = now
    this.candidate = null

    if (pending && pending.steamid === spectating) {
      this.pendingCommand = null
      if (!this.isConnectionWarning()) this.warning = null
      return
    }

    // Not our command. Ignore switches CS2 makes by itself: the watched player died,
    // or a round/phase transition just happened.
    this.lastCutReason = null
    const prevSnap = prev ? this.players.find((x) => x.steamid === prev) : undefined
    const prevAlive = !!prevSnap?.alive
    const phaseJustChanged = now - this.phaseChangedAt < 2000
    this.pendingCommand = null
    if (this.enabled && this.config && prev && prevAlive && !phaseJustChanged) {
      this.pausedUntil = now + this.config.manualOverrideMs
      const name = spectating ? this.nameOf(spectating) : 'free cam'
      this.log(
        name,
        `Manual override — pausing ${Math.round(this.config.manualOverrideMs / 1000)}s`
      )
    }
  }

  private isConnectionWarning(): boolean {
    return !!this.warning && this.warning.startsWith('Cannot reach CS2')
  }

  // ---------------------------------------------------------------- look-ahead

  /** Ingest the undelayed feed and remember when each player's fights start */
  onLookahead(raw: CSGORaw, excluded: Set<string>, now = Date.now()): void {
    const la = this.la
    la.lastAt = now
    const phase = raw.round?.phase ?? null
    if (phase !== la.phase) {
      if (phase === 'freezetime') {
        la.tracker.reset()
        la.lastCombat.clear()
      }
      la.phase = phase
    }
    const players = Object.entries(raw.allplayers ?? {})
      .filter(([steamid]) => !excluded.has(steamid))
      .map(([steamid, p]) => snapshotPlayer(steamid, p))
    la.tracker.update(players, raw, now)

    for (const p of players) {
      const combatAt = Math.max(
        la.tracker.lastDamageTaken.get(p.steamid) ?? -Infinity,
        la.tracker.lastDamageDealt.get(p.steamid) ?? -Infinity
      )
      if (combatAt !== now) continue
      const prev = la.lastCombat.get(p.steamid) ?? -Infinity
      // Only the START of a fight is a useful prediction
      if (now - prev > LOOKAHEAD_CALM_MS)
        la.upcoming.push({ steamid: p.steamid, at: now, label: 'fight incoming (look-ahead)' })
      la.lastCombat.set(p.steamid, now)
    }

    const bombState = raw.bomb?.state ?? null
    if (bombState !== la.bombState) {
      if ((bombState === 'planting' || bombState === 'defusing') && raw.bomb?.player) {
        la.upcoming.push({
          steamid: raw.bomb.player,
          at: now,
          label: `${bombState} incoming (look-ahead)`
        })
      }
      la.bombState = bombState
    }

    const keepMs = ((this.config?.lookaheadDelaySec ?? 0) + 10) * 1000
    la.upcoming = la.upcoming.filter((u) => now - u.at < keepMs)
  }

  private lookaheadActive(): boolean {
    const delay = this.config?.lookaheadDelaySec ?? 0
    return delay > 0 && Date.now() - this.la.lastAt < LOOKAHEAD_STALE_MS
  }

  /**
   * An event seen on the look-ahead feed at time `at` shows up on the delayed broadcast at
   * `at + delay`. Flag the player from `lead` seconds before that until shortly after.
   */
  private computePredictions(): Map<string, string> {
    const out = new Map<string, string>()
    if (!this.lookaheadActive() || this.simulation) return out
    const delay = this.config!.lookaheadDelaySec * 1000
    const lead = this.config!.lookaheadLeadSec * 1000
    // Look-ahead timestamps are wall-clock; compare against wall time
    const wall = Date.now()
    for (const u of this.la.upcoming) {
      const showsAt = u.at + delay
      if (wall >= showsAt - lead && wall <= showsAt + 500) out.set(u.steamid, u.label)
    }
    return out
  }

  // ---------------------------------------------------------------- decisions

  private decide(raw: CSGORaw, now: number): { steamid: string; reason: string } | null {
    const cfg = this.config!
    const scored = this.scored
    const best = scored[0]
    if (!best) return null

    const observed = this.observed
    const curSnap = observed ? this.players.find((p) => p.steamid === observed) : undefined
    const cur = observed ? scored.find((s) => s.player.steamid === observed) : undefined
    const shotAge = now - this.shotStart
    const phase = raw.round?.phase

    // --- Operator commands ---
    if (this.forceNext) {
      this.forceNext = false
      const alt = scored.find((s) => s.player.steamid !== observed)
      if (alt) {
        this.lockedOn = null
        return { steamid: alt.player.steamid, reason: 'operator: next' }
      }
    }
    if (this.lockedOn) {
      const locked = this.players.find((p) => p.steamid === this.lockedOn)
      if (locked?.alive) {
        return locked.steamid === observed ? null : { steamid: locked.steamid, reason: 'locked' }
      }
      this.log(locked?.name ?? '?', 'Lock released (player died)')
      this.lockedOn = null
    }

    // --- Freezetime: show someone worth watching buy ---
    if (phase === 'freezetime') {
      const pick = this.plan?.freezetimeFocus
      if (
        pick &&
        pick !== observed &&
        shotAge > 1500 &&
        this.players.some((p) => p.steamid === pick)
      ) {
        return { steamid: pick, reason: 'AI freezetime pick' }
      }
      if (!curSnap) {
        const star = [...this.players].sort((a, b) => b.matchKills - a.matchKills)[0]
        if (star) return { steamid: star.steamid, reason: 'freezetime: top fragger' }
      }
      return null
    }

    // --- Round over: stay, unless the camera is on a corpse ---
    if (phase === 'over') {
      if (curSnap?.alive) return null
      const diedAt = observed ? (this.tracker.deathAt.get(observed) ?? this.shotStart) : 0
      if (observed && now - diedAt < cfg.deathHoldMs * 2) return null
      return { steamid: best.player.steamid, reason: 'round over: survivor' }
    }

    // --- Live round ---
    if (!curSnap || !cur) {
      if (curSnap && !curSnap.alive) {
        const diedAt = this.tracker.deathAt.get(curSnap.steamid) ?? this.shotStart
        if (now - diedAt < cfg.deathHoldMs) return null
        const killer = this.tracker.killerOf.get(curSnap.steamid)
        if (killer && scored.some((s) => s.player.steamid === killer)) {
          return { steamid: killer, reason: `follow the killer of ${curSnap.name}` }
        }
        return { steamid: best.player.steamid, reason: `${curSnap.name} died` }
      }
      return { steamid: best.player.steamid, reason: 'no camera target' }
    }

    // Hard events: plant/defuse starting elsewhere
    const bomb = raw.bomb
    if (
      bomb?.player &&
      (bomb.state === 'planting' || bomb.state === 'defusing') &&
      bomb.player !== observed
    ) {
      const hard = scored.find((s) => s.player.steamid === bomb.player)
      if (hard && !cur.inCombat) return { steamid: hard.player.steamid, reason: bomb.state }
    }

    // Never leave a fight
    if (cur.inCombat) {
      this.candidate = null
      return null
    }

    // Look-ahead says a fight is about to start elsewhere: be there before it happens
    if (shotAge >= PREDICTED_MIN_SHOT_MS && !this.predicted.has(observed!)) {
      const pred = scored.find((s) => this.predicted.has(s.player.steamid))
      if (pred && pred.player.steamid !== observed) {
        return { steamid: pred.player.steamid, reason: this.predicted.get(pred.player.steamid)! }
      }
    }

    if (best.player.steamid === observed) {
      this.candidate = null
      // Quiet for too long: rotate to the next most interesting player
      if (shotAge >= cfg.maxShotMs && cur.score < 25) {
        const alt = scored.find((s) => s.player.steamid !== observed && s.score >= cur.score * 0.7)
        if (alt) return { steamid: alt.player.steamid, reason: 'quiet shot: rotation' }
      }
      return null
    }

    if (shotAge < cfg.minShotMs) return null

    const threshold = cur.score * (1 + cfg.switchMargin) + 5
    if (best.score > threshold) {
      if (this.candidate?.steamid === best.player.steamid) {
        if (now - this.candidate.since >= CANDIDATE_SUSTAIN_MS) {
          return {
            steamid: best.player.steamid,
            reason: best.reasons.slice(0, 3).join(', ') || 'more interesting'
          }
        }
      } else {
        this.candidate = { steamid: best.player.steamid, since: now }
      }
      return null
    }
    this.candidate = null

    if (shotAge >= cfg.maxShotMs && cur.score < 25 && best.score >= cur.score * 0.9) {
      return { steamid: best.player.steamid, reason: 'quiet shot: rotation' }
    }
    return null
  }

  private cutTo(steamid: string, reason: string, now: number): void {
    if (steamid === this.observed) return
    if (
      this.lastCommand &&
      this.lastCommand.steamid === steamid &&
      now - this.lastCommand.at < RESEND_GUARD_MS
    )
      return
    const p = this.players.find((x) => x.steamid === steamid)
    if (!p || !this.config) return

    this.lastCommand = { steamid, at: now }
    this.pendingCommand = { steamid, at: now }
    this.candidate = null
    this.lastCutReason = reason
    this.log(p.name, reason, now)

    if (this.simulation) {
      // The decision IS the camera; picked up by trackObserved on the next tick
      this.virtualCamera = steamid
      this.trackObserved(this.raw!, now)
      return
    }

    const cmd = this.config.commandTemplate
      .replace(/\{accountid\}/g, accountIdOf(steamid))
      .replace(/\{steamid\}/g, steamid)
      .replace(/\{name\}/g, consoleSafe(p.name))
      .replace(/\{slot\}/g, String(p.slot ?? ''))

    netcon.send(cmd, this.telnet.host, this.telnet.port).catch((err) => {
      this.warning = `Cannot reach CS2 on ${this.telnet.host}:${this.telnet.port} (${err?.message ?? err}). Launch CS2 with -netconport ${this.telnet.port}.`
    })
  }

  // ---------------------------------------------------------------- AI layer

  private maybeAskAI(now: number): void {
    const cfg = this.config!
    if (!cfg.useAI || !cfg.llmModel || this.aiState === 'thinking' || !this.raw) return
    const phase = this.raw.round?.phase
    if (phase === 'over') return

    let due = false
    if (phase === 'freezetime' && this.plannedFreezetimeRound !== this.roundNumber) due = true
    else if (phase === 'live' && now - this.lastAiAt >= cfg.aiIntervalMs) due = true
    else if (this.aiTrigger && now - this.lastAiAt >= AI_EVENT_MIN_GAP_MS) due = true
    if (!due) return

    this.aiTrigger = false
    this.lastAiAt = now
    if (phase === 'freezetime') this.plannedFreezetimeRound = this.roundNumber
    this.aiState = 'thinking'

    const players = this.players
    const observedName = this.observed ? this.nameOf(this.observed) : null
    const summary = buildRoundSummary(
      this.raw,
      players,
      this.tracker.recentEvents(30000, now),
      observedName
    )
    const requestedAt = now

    getApiKey()
      .then((apiKey) =>
        requestPlan({ baseUrl: cfg.llmBaseUrl, model: cfg.llmModel, apiKey }, summary, players)
      )
      .then((plan) => {
        // Plans live on the tick clock so replays age them correctly
        this.plan = { ...plan, createdAt: requestedAt + plan.latencyMs }
        this.aiState = 'idle'
        this.aiError = null
      })
      .catch((err) => {
        this.aiState = 'error'
        this.aiError = String(err?.message ?? err)
        console.error('[Director] AI plan failed:', this.aiError)
      })
      .finally(() => {
        this.emitStatus(true)
        this.emitOverlay(true)
      })
  }

  // ---------------------------------------------------------------- status & overlay

  private log(name: string, reason: string, at = this.wallNow()): void {
    this.cuts.unshift({ at: at - this.clockOffset, name, reason })
    if (this.cuts.length > 25) this.cuts.length = 25
  }

  private freshPlan(now: number): AIPlan | null {
    return this.plan && now - this.plan.createdAt < PLAN_TTL_MS ? this.plan : null
  }

  getStatus(): DirectorStatus {
    const now = this.wallNow()
    const cfg = this.config
    const planFresh = this.freshPlan(now)
    const obs = this.observed
    const exec = this.tracker.activeExecute(now)
    return {
      enabled: this.enabled,
      simulation: this.simulation,
      lockedOn: this.lockedOn ? this.nameOf(this.lockedOn) : null,
      netconConnected: netcon.connected,
      netconTarget: `${this.telnet.host}:${this.telnet.port}`,
      receivingGsi: now - this.lastGsiAt < 3000,
      lookahead: {
        receiving: Date.now() - this.la.lastAt < LOOKAHEAD_STALE_MS,
        active: this.lookaheadActive(),
        predicted: [...this.predicted.keys()].map((id) => this.nameOf(id))
      },
      map: this.raw?.map?.name ?? null,
      phase: this.raw?.phase_countdowns?.phase ?? this.raw?.round?.phase ?? null,
      pausedForMs: Math.max(0, this.pausedUntil - now),
      observed: obs ? { steamid: obs, name: this.nameOf(obs) } : null,
      players: this.players.map((p) => ({
        steamid: p.steamid,
        name: p.name,
        side: p.side,
        zone: p.zone,
        pos: p.pos ? p.pos.map((n) => Math.round(n)) : null
      })),
      scores: this.scored.map((s) => ({
        steamid: s.player.steamid,
        name: s.player.name,
        side: s.player.side,
        score: Math.round(s.score),
        inCombat: s.inCombat,
        reasons: s.reasons
      })),
      cuts: this.cuts,
      warning: this.enabled ? this.warning : null,
      execute: exec
        ? (this.tracker.events.filter((e) => e.type === 'execute').pop()?.text ?? null)
        : null,
      ai: {
        enabled: !!cfg?.useAI,
        state: !cfg?.useAI ? 'off' : this.aiState,
        storyline: planFresh?.storyline ?? null,
        focusSide: planFresh?.focusSide ?? null,
        weights: planFresh
          ? Object.entries(planFresh.weights).map(([id, weight]) => ({
              name: this.nameOf(id),
              weight
            }))
          : [],
        latencyMs: this.plan?.latencyMs ?? null,
        planAgeMs: this.plan ? now - this.plan.createdAt : null,
        error: this.aiError
      }
    }
  }

  getOverlayState(): OverlayState {
    const now = this.wallNow()
    const cfg = this.config
    const raw = this.raw
    const off: OverlayState = {
      active: false,
      teams: { CT: null, T: null },
      onCamera: null,
      storyline: null,
      focusCard: null,
      clutch: null,
      execute: null
    }
    if (!this.enabled || !cfg || !raw) return off

    const plan = this.freshPlan(now)
    const phase = raw.round?.phase
    const obs = this.observed ? this.players.find((p) => p.steamid === this.observed) : undefined

    let focusCard: OverlayState['focusCard'] = null
    if (cfg.overlayFocusCard && phase === 'freezetime') {
      const aiPick = plan?.freezetimeFocus
        ? this.players.find((p) => p.steamid === plan.freezetimeFocus)
        : undefined
      const pick = aiPick ?? [...this.players].sort((a, b) => b.matchKills - a.matchKills)[0]
      if (pick) {
        focusCard = {
          name: pick.name,
          side: pick.side,
          kills: pick.matchKills,
          deaths: pick.matchDeaths,
          assists: pick.matchAssists,
          mvps: pick.mvps,
          money: pick.money,
          primary: pick.primary,
          title: aiPick ? 'Player to watch' : 'Top fragger'
        }
      }
    }

    let clutch: OverlayState['clutch'] = null
    if (cfg.overlayClutch && phase === 'live') {
      for (const side of ['CT', 'T'] as const) {
        const mates = this.players.filter((p) => p.side === side && p.alive)
        const enemies = this.players.filter((p) => p.side !== side && p.alive)
        if (mates.length === 1 && enemies.length >= 2) {
          clutch = { name: mates[0].name, side, vs: enemies.length, hp: mates[0].health }
        }
      }
    }

    const exec = cfg.overlayExecute && phase === 'live' ? this.tracker.activeExecute(now) : null
    const execText = exec
      ? `${exec.side === 'T' ? 'Execute' : 'Retake utility'}${exec.zone ? ` · ${exec.zone}` : ''}`
      : null

    return {
      active: true,
      teams: { CT: raw.map?.team_ct?.name ?? null, T: raw.map?.team_t?.name ?? null },
      onCamera: obs
        ? { name: obs.name, side: obs.side, reason: cfg.overlayReason ? this.lastCutReason : null }
        : null,
      storyline: cfg.overlayStoryline ? (plan?.storyline ?? null) : null,
      focusCard,
      clutch,
      execute: exec && execText ? { side: exec.side, text: execText } : null
    }
  }

  private emitStatus(force: boolean): void {
    const now = Date.now()
    if (!this.io || (!force && now - this.lastStatusAt < STATUS_INTERVAL_MS)) return
    this.lastStatusAt = now
    this.io.except('huds').emit('director:status', this.getStatus())
  }

  private emitOverlay(force: boolean): void {
    const now = Date.now()
    if (!this.io || (!force && now - this.lastOverlayAt < OVERLAY_INTERVAL_MS)) return
    this.lastOverlayAt = now
    const state = this.getOverlayState()
    const json = JSON.stringify(state)
    if (!force && json === this.lastOverlayJson) return
    this.lastOverlayJson = json
    this.io.emit('director:overlay', state)
  }
}

export const director = new Director()
