import type { CSGORaw } from 'csgogsi'
import type { GameEvent, PlayerSnapshot } from './scorer'

// LLM layer: a slow "director" that reads the round and biases the rule engine.
//
// It never picks individual cuts (a model call takes 0.5–3 s, a duel is over before that).
// Instead it returns per-player weights + a team focus that the rule engine applies on
// every tick until the next plan arrives.
//
// Works with any OpenAI-compatible /chat/completions endpoint (OpenAI, OpenRouter,
// Ollama, LM Studio, vLLM, ...).

export interface AIPlan {
  /** steamid -> weight multiplier, clamped to [0.5, 2] */
  weights: Record<string, number>
  focusSide: 'CT' | 'T' | null
  /** Player to show during freezetime */
  freezetimeFocus: string | null
  storyline: string
  createdAt: number
  latencyMs: number
}

export interface LLMSettings {
  baseUrl: string
  model: string
  apiKey: string | null
}

const SYSTEM_PROMPT = `You are the lead observer (camera director) of a professional Counter-Strike 2 broadcast.
A fast rule engine already handles the cuts: it follows fights, kills, plants, defuses and clutches.
Your job is the editorial layer a top-tier observer brings: read the round and decide WHO the story is about.

You receive a JSON snapshot of the round. Reply with ONLY a JSON object:
{
  "weights": { "<player name>": <number 0.5-2.0> },
  "focus_side": "CT" | "T" | null,
  "freezetime_focus": "<player name>" | null,
  "storyline": "<one short sentence for the producer>"
}

Guidelines:
- 1.0 is neutral. Only list players you want to boost (>1) or de-prioritise (<1). Keep it to a few names.
- Boost: the player most likely to take the opening duel, star players on a hot streak, the AWPer holding a key angle,
  lurkers about to hit a flank, the player with the bomb during an execute, survivors in a clutch or retake.
- De-prioritise: players saving, players far from the action, players holding passive angles nothing will hit.
- focus_side: the side whose decisions drive the round right now (attackers on an execute, defenders on a retake). null if unclear.
- freezetime_focus: during freezetime pick someone worth seeing buy/plan (IGL, star player, a notable eco/force buy).
- "zone" and group "@ zone" are map callouts when configured; recent_events may include utility bursts (executes).
  Use them: an execute into a site means the defenders anchoring it and the entry fraggers are the story.
- Never invent players. Use names exactly as given.`

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))

/** Rough grouping so the model can tell a 5-man stack from a spread setup */
const groupBySide = (players: PlayerSnapshot[], side: 'CT' | 'T'): string[] => {
  const alive = players.filter((p) => p.side === side && p.alive && p.pos)
  const groups: PlayerSnapshot[][] = []
  for (const p of alive) {
    const g = groups.find((grp) =>
      grp.some((q) => Math.hypot(q.pos![0] - p.pos![0], q.pos![1] - p.pos![1]) < 700)
    )
    if (g) g.push(p)
    else groups.push([p])
  }
  return groups.map((g) => {
    const zones = [...new Set(g.map((p) => p.zone).filter(Boolean))]
    return `${g.map((p) => p.name).join(' + ')}${zones.length ? ` @ ${zones.join('/')}` : ''}`
  })
}

export const buildRoundSummary = (
  raw: CSGORaw,
  players: PlayerSnapshot[],
  events: GameEvent[],
  currentTarget: string | null
): Record<string, unknown> => {
  const map = raw.map
  const nearestEnemy = (p: PlayerSnapshot): number | null => {
    if (!p.pos) return null
    let best = Infinity
    for (const e of players) {
      if (e.side === p.side || !e.alive || !e.pos) continue
      best = Math.min(
        best,
        Math.hypot(e.pos[0] - p.pos[0], e.pos[1] - p.pos[1], e.pos[2] - p.pos[2])
      )
    }
    return Number.isFinite(best) ? Math.round(best) : null
  }

  const side = (s: 'CT' | 'T'): Record<string, unknown> => ({
    team: s === 'CT' ? map?.team_ct?.name : map?.team_t?.name,
    score: s === 'CT' ? map?.team_ct?.score : map?.team_t?.score,
    loss_streak:
      s === 'CT' ? map?.team_ct?.consecutive_round_losses : map?.team_t?.consecutive_round_losses,
    groups: groupBySide(players, s),
    players: players
      .filter((p) => p.side === s)
      .map((p) => ({
        name: p.name,
        alive: p.alive,
        zone: p.alive ? (p.zone ?? undefined) : undefined,
        hp: p.health,
        armor: p.armor,
        money: p.money,
        equip_value: p.equipValue,
        primary: p.primary,
        holding: p.activeWeapon,
        has_bomb: p.hasBomb || undefined,
        has_kit: p.hasKit || undefined,
        round_kills: p.roundKills,
        round_dmg: p.roundDamage,
        match_kd: `${p.matchKills}/${p.matchDeaths}`,
        nearest_enemy_units: p.alive ? nearestEnemy(p) : undefined
      }))
  })

  return {
    map: map?.name,
    round: (map?.round ?? 0) + 1,
    phase: raw.phase_countdowns?.phase ?? raw.round?.phase,
    phase_ends_in_s: raw.phase_countdowns?.phase_ends_in
      ? Math.round(Number(raw.phase_countdowns.phase_ends_in))
      : undefined,
    bomb: raw.bomb ? { state: raw.bomb.state, countdown: raw.bomb.countdown } : undefined,
    camera_on: currentTarget,
    recent_events: events.map((e) => e.text),
    CT: side('CT'),
    T: side('T')
  }
}

const extractJson = (text: string): any => {
  try {
    return JSON.parse(text)
  } catch {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1))
    throw new Error('Model did not return JSON')
  }
}

const parsePlan = (data: any, players: PlayerSnapshot[], latencyMs: number): AIPlan => {
  const byName = new Map(players.map((p) => [p.name.toLowerCase(), p.steamid]))
  const weights: Record<string, number> = {}
  if (data && typeof data.weights === 'object') {
    for (const [name, w] of Object.entries(data.weights)) {
      const id = byName.get(String(name).toLowerCase())
      const n = Number(w)
      if (id && Number.isFinite(n)) weights[id] = clamp(n, 0.5, 2)
    }
  }
  const fs = String(data?.focus_side ?? '').toUpperCase()
  const ff = data?.freezetime_focus ? byName.get(String(data.freezetime_focus).toLowerCase()) : null
  return {
    weights,
    focusSide: fs === 'CT' || fs === 'T' ? fs : null,
    freezetimeFocus: ff ?? null,
    storyline: String(data?.storyline ?? '').slice(0, 240),
    createdAt: Date.now(),
    latencyMs
  }
}

// Not every OpenAI-compatible server accepts the same parameters (newer OpenAI models want
// max_completion_tokens and reject temperature; some local servers reject response_format).
// On a 400 we drop/rename the parameter the error mentions and remember it per endpoint.
interface Compat {
  jsonMode: boolean
  temperature: boolean
  tokenParam: 'max_tokens' | 'max_completion_tokens' | null
}
const compatByEndpoint = new Map<string, Compat>()

const chat = async (
  settings: LLMSettings,
  messages: { role: string; content: string }[],
  wantJson: boolean,
  signal: AbortSignal
): Promise<Response> => {
  const key = `${settings.baseUrl}|${settings.model}`
  const compat: Compat = compatByEndpoint.get(key) ?? {
    jsonMode: true,
    temperature: true,
    tokenParam: 'max_tokens'
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`
  const url = `${settings.baseUrl.replace(/\/+$/, '')}/chat/completions`

  for (let attempt = 0; attempt < 4; attempt++) {
    const body: Record<string, unknown> = { model: settings.model, messages }
    if (compat.temperature) body.temperature = 0.3
    if (compat.tokenParam) body[compat.tokenParam] = 800
    if (wantJson && compat.jsonMode) body.response_format = { type: 'json_object' }

    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal })
    if (res.status !== 400) {
      compatByEndpoint.set(key, compat)
      return res
    }

    const text = (
      await res
        .clone()
        .text()
        .catch(() => '')
    ).toLowerCase()
    if (text.includes('max_tokens') && compat.tokenParam === 'max_tokens') {
      compat.tokenParam = 'max_completion_tokens'
    } else if (text.includes('max_completion_tokens') && compat.tokenParam) {
      compat.tokenParam = null
    } else if (text.includes('temperature') && compat.temperature) {
      compat.temperature = false
    } else if (
      wantJson &&
      compat.jsonMode &&
      (text.includes('response_format') || text.includes('json'))
    ) {
      compat.jsonMode = false
    } else {
      return res
    }
  }
  throw new Error('Endpoint rejected every parameter combination')
}

export const requestPlan = async (
  settings: LLMSettings,
  summary: Record<string, unknown>,
  players: PlayerSnapshot[],
  timeoutMs = 10000
): Promise<AIPlan> => {
  if (!settings.model) throw new Error('No model configured')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const started = Date.now()
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: JSON.stringify(summary) }
  ]

  try {
    const res = await chat(settings, messages, true, controller.signal)
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`)
    }
    const json: any = await res.json()
    const content = json?.choices?.[0]?.message?.content
    if (typeof content !== 'string') throw new Error('Unexpected response shape')
    return parsePlan(extractJson(content), players, Date.now() - started)
  } catch (err: any) {
    if (err?.name === 'AbortError') throw new Error(`Timed out after ${timeoutMs} ms`)
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/** Minimal round-trip used by the "Test" button in the UI */
export const testLLM = async (
  settings: LLMSettings
): Promise<{ latencyMs: number; reply: string }> => {
  if (!settings.model) throw new Error('No model configured')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  const started = Date.now()
  try {
    const res = await chat(
      settings,
      [{ role: 'user', content: 'Reply with the single word: ready' }],
      false,
      controller.signal
    )
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`)
    }
    const json: any = await res.json()
    return {
      latencyMs: Date.now() - started,
      reply: String(json?.choices?.[0]?.message?.content ?? '').slice(0, 80)
    }
  } catch (err: any) {
    if (err?.name === 'AbortError') throw new Error('Timed out after 15000 ms')
    throw err
  } finally {
    clearTimeout(timer)
  }
}
