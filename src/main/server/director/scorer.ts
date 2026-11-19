import type { CSGORaw, PlayerRaw } from 'csgogsi'

// Rule engine: turns each GSI tick into an "interest" score per player.
//
// GSI has no line-of-sight or kill feed, so everything here is inferred:
//  - real fights come from health/damage deltas between ticks (the strongest signal),
//  - imminent fights come from distance + where each player is looking,
//  - killers come from matching a death with an enemy's round_kills going up.

export type Vec3 = [number, number, number]

export interface PlayerSnapshot {
  steamid: string
  name: string
  side: 'CT' | 'T'
  slot: number | null
  alive: boolean
  health: number
  armor: number
  flashed: number
  money: number
  equipValue: number
  roundKills: number
  roundDamage: number
  matchKills: number
  matchDeaths: number
  matchAssists: number
  mvps: number
  activeWeapon: string | null
  primary: string | null
  hasAwp: boolean
  hasBomb: boolean
  hasKit: boolean
  pos: Vec3 | null
  fwd: Vec3 | null
  /** Named map zone (callout) if map zones are configured */
  zone: string | null
}

export interface ScoredPlayer {
  player: PlayerSnapshot
  score: number
  /** True when the player is currently trading damage — never cut away from this */
  inCombat: boolean
  reasons: string[]
}

export interface GameEvent {
  at: number
  type:
    | 'kill'
    | 'plant_start'
    | 'planted'
    | 'defuse_start'
    | 'defused'
    | 'exploded'
    | 'round_start'
    | 'round_end'
    | 'execute'
  text: string
  steamid?: string
  victim?: string
}

/** A coordinated burst of utility from one side: the classic tell of an execute */
export interface ExecuteInfo {
  side: 'CT' | 'T'
  center: Vec3
  at: number
  smokes: number
  flashes: number
  molotovs: number
  frags: number
  zone: string | null
}

interface UtilityLanding {
  side: 'CT' | 'T'
  type: 'smoke' | 'flashbang' | 'frag' | 'molotov'
  pos: Vec3
  at: number
}

/** External per-player bias, e.g. from the LLM plan (1 = neutral) */
export type Bias = Map<string, number>

const ENGAGE_RANGE = 1800 // CS2 units; beyond this a duel is unlikely to matter right now
const RECENT_COMBAT_MS = 2000
const RECENT_KILL_MS = 4000
const KILL_MATCH_WINDOW_MS = 600
const EXECUTE_WINDOW_MS = 8000
const EXECUTE_RADIUS = 1400
const EXECUTE_MIN_UTILITY = 3
const EXECUTE_COOLDOWN_MS = 15000
export const EXECUTE_ACTIVE_MS = 10000

export const parseVec = (s?: string): Vec3 | null => {
  if (!s) return null
  const parts = s.split(',').map((p) => Number(p.trim()))
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null
  return parts as Vec3
}

const PRIMARY_TYPES = new Set(['Rifle', 'SniperRifle', 'Submachine Gun', 'Shotgun', 'Machine Gun'])

export const snapshotPlayer = (steamid: string, p: PlayerRaw): PlayerSnapshot => {
  const weapons = Object.values(p.weapons ?? {})
  const active = weapons.find((w) => w.state === 'active' || w.state === 'reloading')
  const primary = weapons.find((w) => w.type && PRIMARY_TYPES.has(w.type))
  const clean = (n?: string): string | null => (n ? n.replace(/^weapon_/, '') : null)
  return {
    steamid,
    name: p.name,
    side: p.team,
    slot: typeof p.observer_slot === 'number' ? p.observer_slot : null,
    alive: (p.state?.health ?? 0) > 0,
    health: p.state?.health ?? 0,
    armor: p.state?.armor ?? 0,
    flashed: p.state?.flashed ?? 0,
    money: p.state?.money ?? 0,
    equipValue: p.state?.equip_value ?? 0,
    roundKills: p.state?.round_kills ?? 0,
    roundDamage: p.state?.round_totaldmg ?? 0,
    matchKills: p.match_stats?.kills ?? 0,
    matchDeaths: p.match_stats?.deaths ?? 0,
    matchAssists: p.match_stats?.assists ?? 0,
    mvps: p.match_stats?.mvps ?? 0,
    activeWeapon: clean(active?.name),
    primary: clean(primary?.name),
    hasAwp: weapons.some((w) => w.name === 'weapon_awp'),
    hasBomb: weapons.some((w) => w.type === 'C4' || w.name === 'weapon_c4'),
    hasKit: !!p.state?.defusekit,
    pos: parseVec(p.position),
    fwd: parseVec(p.forward),
    zone: null
  }
}

const dist = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

/** How directly `from` is looking at `to`, 0 (away/side) .. 1 (straight at) */
const facing = (from: PlayerSnapshot, to: PlayerSnapshot): number => {
  if (!from.pos || !from.fwd || !to.pos) return 0
  const dx = to.pos[0] - from.pos[0]
  const dy = to.pos[1] - from.pos[1]
  const dz = to.pos[2] - from.pos[2]
  const len = Math.hypot(dx, dy, dz) || 1
  const dot = (from.fwd[0] * dx + from.fwd[1] * dy + from.fwd[2] * dz) / len
  // Only a fairly tight cone counts as "looking at"
  return Math.max(0, (dot - 0.6) / 0.4)
}

/**
 * Keeps per-player history across ticks to detect damage, kills and deaths.
 * Reset at every round start.
 */
export class RoundTracker {
  private prev = new Map<string, PlayerSnapshot>()
  lastDamageTaken = new Map<string, number>()
  lastDamageDealt = new Map<string, number>()
  lastKill = new Map<string, number>()
  deathAt = new Map<string, number>()
  killerOf = new Map<string, string>()
  events: GameEvent[] = []
  private pendingDeaths: { victim: PlayerSnapshot; at: number }[] = []
  private pendingKills: { killer: PlayerSnapshot; at: number }[] = []
  private prevBombState: string | null = null
  private grenadeSeen = new Map<
    string,
    { type: string; side: 'CT' | 'T'; pos: Vec3 | null; landed: boolean }
  >()
  private landings: UtilityLanding[] = []
  executes: ExecuteInfo[] = []
  /** Optional zone lookup, set by the director when map zones exist */
  zoneOf: (pos: Vec3) => string | null = () => null

  reset(): void {
    this.grenadeSeen.clear()
    this.landings = []
    this.executes = []
    this.prev.clear()
    this.lastDamageTaken.clear()
    this.lastDamageDealt.clear()
    this.lastKill.clear()
    this.deathAt.clear()
    this.killerOf.clear()
    this.pendingDeaths = []
    this.pendingKills = []
    this.prevBombState = null
  }

  private pushEvent(e: GameEvent): void {
    this.events.push(e)
    if (this.events.length > 40) this.events.splice(0, this.events.length - 40)
  }

  recentEvents(sinceMs: number, now: number): GameEvent[] {
    return this.events.filter((e) => now - e.at <= sinceMs)
  }

  update(players: PlayerSnapshot[], raw: CSGORaw, now: number): void {
    for (const p of players) {
      const before = this.prev.get(p.steamid)
      if (before) {
        if (p.health < before.health) this.lastDamageTaken.set(p.steamid, now)
        if (p.roundDamage > before.roundDamage) this.lastDamageDealt.set(p.steamid, now)
        if (p.roundKills > before.roundKills) {
          this.lastKill.set(p.steamid, now)
          for (let i = before.roundKills; i < p.roundKills; i++) {
            this.pendingKills.push({ killer: p, at: now })
          }
        }
        if (before.alive && !p.alive) {
          this.deathAt.set(p.steamid, now)
          this.pendingDeaths.push({ victim: p, at: now })
        }
      }
      this.prev.set(p.steamid, p)
    }

    this.matchKills(now)
    this.updateGrenades(players, raw, now)

    // Bomb events
    const bombState = raw.bomb?.state ?? null
    if (bombState !== this.prevBombState) {
      const who = raw.bomb?.player
      const name = who ? players.find((p) => p.steamid === who)?.name : undefined
      if (bombState === 'planting')
        this.pushEvent({
          at: now,
          type: 'plant_start',
          text: `${name ?? 'T'} started planting`,
          steamid: who
        })
      if (bombState === 'planted')
        this.pushEvent({ at: now, type: 'planted', text: 'Bomb planted' })
      if (bombState === 'defusing')
        this.pushEvent({
          at: now,
          type: 'defuse_start',
          text: `${name ?? 'CT'} started defusing`,
          steamid: who
        })
      if (bombState === 'defused')
        this.pushEvent({ at: now, type: 'defused', text: 'Bomb defused' })
      if (bombState === 'exploded')
        this.pushEvent({ at: now, type: 'exploded', text: 'Bomb exploded' })
      this.prevBombState = bombState
    }
  }

  // Pair deaths with enemy kill-count increments that happened at (almost) the same time
  private matchKills(now: number): void {
    for (const death of [...this.pendingDeaths]) {
      const idx = this.pendingKills.findIndex(
        (k) =>
          k.killer.side !== death.victim.side && Math.abs(k.at - death.at) <= KILL_MATCH_WINDOW_MS
      )
      if (idx >= 0) {
        const { killer } = this.pendingKills[idx]
        this.pendingKills.splice(idx, 1)
        this.pendingDeaths.splice(this.pendingDeaths.indexOf(death), 1)
        this.killerOf.set(death.victim.steamid, killer.steamid)
        this.pushEvent({
          at: death.at,
          type: 'kill',
          text: `${killer.name} killed ${death.victim.name}`,
          steamid: killer.steamid,
          victim: death.victim.steamid
        })
      }
    }
    // Drop anything that never matched (suicide, bomb, world damage, team kill)
    this.pendingDeaths = this.pendingDeaths.filter((d) => {
      if (now - d.at <= KILL_MATCH_WINDOW_MS) return true
      this.pushEvent({
        at: d.at,
        type: 'kill',
        text: `${d.victim.name} died`,
        victim: d.victim.steamid
      })
      return false
    })
    this.pendingKills = this.pendingKills.filter((k) => now - k.at <= KILL_MATCH_WINDOW_MS)
  }

  /** Most recent execute still in progress, if any */
  activeExecute(now: number): ExecuteInfo | null {
    const e = this.executes[this.executes.length - 1]
    return e && now - e.at < EXECUTE_ACTIVE_MS ? e : null
  }

  // Track utility: a grenade "lands" when a smoke pops, a fire starts, or a flash/HE
  // disappears (detonated) after being seen in flight.
  private updateGrenades(players: PlayerSnapshot[], raw: CSGORaw, now: number): void {
    const grenades = (raw.grenades ?? {}) as Record<string, any>
    const sideOf = (owner: string): 'CT' | 'T' | null =>
      players.find((p) => p.steamid === String(owner))?.side ?? null
    const land = (type: UtilityLanding['type'], side: 'CT' | 'T', pos: Vec3 | null): void => {
      if (!pos) return
      this.landings.push({ type, side, pos, at: now })
      this.detectExecute(side, now)
    }

    for (const [id, g] of Object.entries(grenades)) {
      const side = sideOf(g.owner)
      if (!side) continue
      let seen = this.grenadeSeen.get(id)
      if (!seen) {
        seen = { type: g.type, side, pos: null, landed: false }
        this.grenadeSeen.set(id, seen)
      }
      if (g.type === 'inferno') {
        const flames = Object.values(g.flames ?? {})
          .map((f) => parseVec(String(f)))
          .filter(Boolean) as Vec3[]
        if (flames.length) {
          seen.pos = [0, 1, 2].map(
            (i) => flames.reduce((a, f) => a + f[i], 0) / flames.length
          ) as Vec3
          if (!seen.landed) {
            seen.landed = true
            land('molotov', side, seen.pos)
          }
        }
        continue
      }
      seen.pos = parseVec(g.position) ?? seen.pos
      if (g.type === 'smoke' && Number(g.effecttime) > 0 && !seen.landed) {
        seen.landed = true
        land('smoke', side, seen.pos)
      }
    }

    // Flashes and HEs that vanished have detonated where we last saw them
    for (const [id, seen] of this.grenadeSeen) {
      if (id in grenades) continue
      if (!seen.landed && (seen.type === 'flashbang' || seen.type === 'frag')) {
        land(seen.type, seen.side, seen.pos)
      }
      this.grenadeSeen.delete(id)
    }

    this.landings = this.landings.filter((l) => now - l.at < EXECUTE_WINDOW_MS)
  }

  private detectExecute(side: 'CT' | 'T', now: number): void {
    const last = [...this.executes].reverse().find((e) => e.side === side)
    if (last && now - last.at < EXECUTE_COOLDOWN_MS) return
    const latest = this.landings[this.landings.length - 1]
    const near = this.landings.filter(
      (l) =>
        l.side === side &&
        now - l.at < EXECUTE_WINDOW_MS &&
        dist(l.pos, latest.pos) < EXECUTE_RADIUS
    )
    const count = (t: UtilityLanding['type']): number => near.filter((l) => l.type === t).length
    const smokes = count('smoke')
    const molotovs = count('molotov')
    // Needs some area-denial utility, not just a flash spam
    if (near.length < EXECUTE_MIN_UTILITY || smokes + molotovs === 0) return

    const center = [0, 1, 2].map(
      (i) => near.reduce((a, l) => a + l.pos[i], 0) / near.length
    ) as Vec3
    const exec: ExecuteInfo = {
      side,
      center,
      at: now,
      smokes,
      molotovs,
      flashes: count('flashbang'),
      frags: count('frag'),
      zone: this.zoneOf(center)
    }
    this.executes.push(exec)
    const parts = [
      smokes && `${smokes} smoke${smokes > 1 ? 's' : ''}`,
      molotovs && `${molotovs} molly`,
      exec.flashes && `${exec.flashes} flash`,
      exec.frags && `${exec.frags} HE`
    ].filter(Boolean)
    this.pushEvent({
      at: now,
      type: 'execute',
      text: `${side} utility burst${exec.zone ? ` into ${exec.zone}` : ''} (${parts.join(', ')})`
    })
  }

  logRoundEvent(type: 'round_start' | 'round_end', text: string, now: number): void {
    this.pushEvent({ at: now, type, text })
  }
}

export interface ScoreContext {
  raw: CSGORaw
  tracker: RoundTracker
  now: number
  bias: Bias
  focusSide: 'CT' | 'T' | null
  /** steamid -> label, for players the look-ahead feed says are about to fight */
  predicted?: Map<string, string>
}

export const scorePlayers = (players: PlayerSnapshot[], ctx: ScoreContext): ScoredPlayer[] => {
  const { raw, tracker, now, bias, focusSide, predicted } = ctx
  const execute = tracker.activeExecute(now)
  const alive = players.filter((p) => p.alive)
  const bomb = raw.bomb
  const bombPos = parseVec(bomb?.position)
  const bombPlanted = bomb?.state === 'planted' || bomb?.state === 'defusing'

  return alive
    .map((p) => {
      const reasons: string[] = []
      let score = 5
      const add = (pts: number, why: string): void => {
        if (pts <= 0.5) return
        score += pts
        reasons.push(`${why} +${Math.round(pts)}`)
      }

      // --- Active fight (strongest signal) ---
      const tookAt = tracker.lastDamageTaken.get(p.steamid) ?? -Infinity
      const dealtAt = tracker.lastDamageDealt.get(p.steamid) ?? -Infinity
      const takingDamage = now - tookAt < RECENT_COMBAT_MS
      const dealingDamage = now - dealtAt < RECENT_COMBAT_MS
      if (takingDamage) add(25 * (1 - (now - tookAt) / RECENT_COMBAT_MS) + 10, 'taking damage')
      if (dealingDamage) add(25 * (1 - (now - dealtAt) / RECENT_COMBAT_MS) + 10, 'dealing damage')

      // --- Imminent duel: enemies close and looking at each other ---
      const enemies = alive.filter((e) => e.side !== p.side)
      let threat = 0
      let closest = Infinity
      if (p.pos) {
        for (const e of enemies) {
          if (!e.pos) continue
          const d = dist(p.pos, e.pos)
          closest = Math.min(closest, d)
          if (d > ENGAGE_RANGE) continue
          const prox = Math.pow(1 - d / ENGAGE_RANGE, 1.5)
          // Big height gaps usually mean different floors / no line of sight
          const heightPenalty = Math.abs(p.pos[2] - e.pos[2]) > 220 ? 0.4 : 1
          threat += prox * heightPenalty * (0.35 + 0.45 * facing(p, e) + 0.3 * facing(e, p))
        }
      }
      add(Math.min(threat, 2) * 22, 'enemies close')

      // --- Recent kill: follow the hot hand ---
      const killAt = tracker.lastKill.get(p.steamid) ?? -Infinity
      if (now - killAt < RECENT_KILL_MS)
        add(20 * (1 - (now - killAt) / RECENT_KILL_MS) + 5, 'just got a kill')
      if (p.roundKills >= 2) add(p.roundKills * 4, `${p.roundKills}K this round`)

      // --- Bomb ---
      if (bomb?.player === p.steamid && bomb.state === 'planting') add(60, 'planting')
      if (bomb?.player === p.steamid && bomb.state === 'defusing') add(70, 'defusing')
      if (p.hasBomb && !bombPlanted) add(6, 'bomb carrier')
      if (bombPlanted && bombPos && p.pos) {
        const d = dist(p.pos, bombPos)
        if (d < 900)
          add(p.side === 'CT' ? 15 * (1 - d / 900) + 5 : 8 * (1 - d / 900) + 3, 'near planted bomb')
      }

      // --- Clutch ---
      const mates = alive.filter((m) => m.side === p.side)
      if (mates.length === 1 && enemies.length >= 1)
        add(30 + 8 * enemies.length, `1v${enemies.length}`)

      // --- Execute in progress: both the attackers and the defenders being hit ---
      if (execute && p.pos) {
        const d = dist(p.pos, execute.center)
        if (d < 1600)
          add(18 * (1 - d / 1600) + 4, execute.side === p.side ? 'executing' : 'site under execute')
      }

      // --- Look-ahead: this player fights in the next second or two ---
      const pred = predicted?.get(p.steamid)
      if (pred) add(45, pred)

      // --- Flavour ---
      if (p.activeWeapon === 'awp') add(4, 'AWP out')
      else if (p.hasAwp) add(2, 'has AWP')

      // --- Penalties ---
      if (enemies.length && closest > 3000 && !takingDamage && !dealingDamage) {
        score *= 0.75
        reasons.push('far from action ×0.75')
      }
      if (p.flashed > 150 && !takingDamage && !dealingDamage) {
        score *= 0.6
        reasons.push('flashed ×0.6')
      }

      // --- External bias (LLM plan) ---
      const b = bias.get(p.steamid)
      if (b !== undefined && b !== 1) {
        score *= b
        reasons.push(`AI ×${b.toFixed(2)}`)
      }
      if (focusSide && p.side === focusSide) {
        score *= 1.15
        reasons.push('AI team focus ×1.15')
      }

      return { player: p, score, inCombat: takingDamage || dealingDamage, reasons }
    })
    .sort((a, b) => b.score - a.score)
}
