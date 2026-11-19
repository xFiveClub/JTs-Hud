import { safeStorage } from 'electron'
import { dbAll, dbRun } from '../database/sqlite'

// AI Director configuration.
//
// Stored in the `settings` table under `director.*` keys. This config is ONLY reachable
// through Electron IPC, never through the HTTP API: the HUD server allows any origin
// (CORS *), so exposing it there would let any web page read the API key or point the
// LLM base URL at a server it controls.

export interface DirectorConfig {
  /** Use the LLM layer on top of the rule engine */
  useAI: boolean
  /** Minimum time a shot stays on screen before a normal cut (ms) */
  minShotMs: number
  /** After this long on a quiet shot, rotate to another good candidate (ms) */
  maxShotMs: number
  /** How long to stay on a player after they die before cutting away (ms) */
  deathHoldMs: number
  /** A candidate must beat the current shot by this fraction to trigger a cut (0.35 = +35%) */
  switchMargin: number
  /** When the human observer changes the camera, pause the director for this long (ms) */
  manualOverrideMs: number
  /**
   * Console command used to move the camera. Placeholders:
   * {accountid} (32-bit Steam account id), {steamid} (SteamID64), {name}, {slot}
   */
  commandTemplate: string
  /** Send `spec_autodirector 0` when the director starts so CS2's own director doesn't fight it */
  disableGameAutodirector: boolean
  /** OpenAI-compatible base URL, e.g. https://api.openai.com/v1 or http://localhost:11434/v1 */
  llmBaseUrl: string
  llmModel: string
  /** How often the LLM refreshes its read of the round while it's live (ms) */
  aiIntervalMs: number
  /**
   * tv_delay of the broadcast, in seconds. When > 0 and a look-ahead GSI feed (no delay) is
   * posting to /cs2/lookahead, the director sees fights before the broadcast does.
   */
  lookaheadDelaySec: number
  /** How many seconds before a predicted fight the camera should already be there */
  lookaheadLeadSec: number
  // Director overlay widgets (browser source at /overlays/director/)
  overlayStoryline: boolean
  overlayFocusCard: boolean
  overlayClutch: boolean
  overlayExecute: boolean
  overlayReason: boolean
}

export interface DirectorConfigPublic extends DirectorConfig {
  /** Whether an API key is stored. The key itself never leaves the main process. */
  llmApiKeySet: boolean
  /** False when the OS keychain is unavailable and the key is stored unencrypted */
  llmApiKeyEncrypted: boolean
}

export const DEFAULT_DIRECTOR_CONFIG: DirectorConfig = {
  useAI: false,
  minShotMs: 2500,
  maxShotMs: 12000,
  deathHoldMs: 900,
  switchMargin: 0.35,
  manualOverrideMs: 8000,
  commandTemplate: 'spec_player_by_accountid {accountid}',
  disableGameAutodirector: true,
  llmBaseUrl: 'https://api.openai.com/v1',
  llmModel: '',
  aiIntervalMs: 10000,
  lookaheadDelaySec: 0,
  lookaheadLeadSec: 1.5,
  overlayStoryline: true,
  overlayFocusCard: true,
  overlayClutch: true,
  overlayExecute: true,
  overlayReason: false
}

const PREFIX = 'director.'
const KEY_FIELD = `${PREFIX}llmApiKey`

const NUMBER_LIMITS: Partial<Record<keyof DirectorConfig, [number, number]>> = {
  minShotMs: [500, 20000],
  maxShotMs: [2000, 120000],
  deathHoldMs: [0, 5000],
  switchMargin: [0, 3],
  manualOverrideMs: [0, 120000],
  aiIntervalMs: [3000, 120000],
  lookaheadDelaySec: [0, 300],
  lookaheadLeadSec: [0.3, 5]
}

let cache: DirectorConfig | null = null
let apiKeyCache: string | null | undefined

const readRows = async (): Promise<Record<string, string>> => {
  const rows: { key: string; value: string }[] = await dbAll(
    `SELECT key, value FROM settings WHERE key LIKE '${PREFIX}%'`
  )
  return Object.fromEntries(rows.map((r) => [r.key, r.value]))
}

const writeRow = (key: string, value: string): Promise<unknown> =>
  dbRun(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, value]
  )

export const getDirectorConfig = async (): Promise<DirectorConfig> => {
  if (cache) return cache
  const map = await readRows()
  const cfg = { ...DEFAULT_DIRECTOR_CONFIG }
  for (const key of Object.keys(DEFAULT_DIRECTOR_CONFIG) as (keyof DirectorConfig)[]) {
    const raw = map[PREFIX + key]
    if (raw === undefined) continue
    const def = DEFAULT_DIRECTOR_CONFIG[key]
    if (typeof def === 'boolean') (cfg as any)[key] = raw === 'true'
    else if (typeof def === 'number') {
      const n = Number(raw)
      if (Number.isFinite(n)) (cfg as any)[key] = n
    } else (cfg as any)[key] = raw
  }
  cache = cfg
  return cfg
}

export const getDirectorConfigPublic = async (): Promise<DirectorConfigPublic> => {
  const cfg = await getDirectorConfig()
  const map = await readRows()
  const stored = map[KEY_FIELD]
  return {
    ...cfg,
    llmApiKeySet: !!stored,
    llmApiKeyEncrypted: !stored || stored.startsWith('enc:')
  }
}

/** Validate and persist a partial config update. Unknown keys are ignored. */
export const updateDirectorConfig = async (
  updates: Partial<DirectorConfig> & { llmApiKey?: string | null }
): Promise<DirectorConfigPublic> => {
  const current = await getDirectorConfig()
  const next: DirectorConfig = { ...current }

  for (const key of Object.keys(DEFAULT_DIRECTOR_CONFIG) as (keyof DirectorConfig)[]) {
    if (!(key in updates)) continue
    const value = (updates as any)[key]
    const def = DEFAULT_DIRECTOR_CONFIG[key]
    if (typeof def === 'boolean') (next as any)[key] = !!value
    else if (typeof def === 'number') {
      const n = Number(value)
      if (!Number.isFinite(n)) continue
      const [min, max] = NUMBER_LIMITS[key] ?? [-Infinity, Infinity]
      ;(next as any)[key] = Math.min(max, Math.max(min, n))
    } else (next as any)[key] = String(value ?? '').trim()
  }

  if (!next.commandTemplate) next.commandTemplate = DEFAULT_DIRECTOR_CONFIG.commandTemplate
  if (next.llmBaseUrl && !/^https?:\/\//i.test(next.llmBaseUrl)) {
    throw new Error('LLM base URL must start with http:// or https://')
  }
  if (next.maxShotMs < next.minShotMs) next.maxShotMs = next.minShotMs

  for (const key of Object.keys(next) as (keyof DirectorConfig)[]) {
    await writeRow(PREFIX + key, String(next[key]))
  }
  cache = next

  if (updates.llmApiKey !== undefined) await setApiKey(updates.llmApiKey)

  return getDirectorConfigPublic()
}

const setApiKey = async (key: string | null): Promise<void> => {
  const trimmed = (key ?? '').trim()
  apiKeyCache = trimmed || null
  if (!trimmed) {
    await dbRun('DELETE FROM settings WHERE key = ?', [KEY_FIELD])
    return
  }
  const stored = safeStorage.isEncryptionAvailable()
    ? 'enc:' + safeStorage.encryptString(trimmed).toString('base64')
    : 'raw:' + trimmed
  await writeRow(KEY_FIELD, stored)
}

/** Returns the decrypted API key, or null. Main process only. */
export const getApiKey = async (): Promise<string | null> => {
  if (apiKeyCache !== undefined) return apiKeyCache
  const map = await readRows()
  const stored = map[KEY_FIELD]
  if (!stored) return (apiKeyCache = null)
  try {
    if (stored.startsWith('enc:')) {
      apiKeyCache = safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'))
    } else if (stored.startsWith('raw:')) {
      apiKeyCache = stored.slice(4)
    } else {
      apiKeyCache = null
    }
  } catch (err) {
    console.error('[Director] Could not decrypt the stored API key:', err)
    apiKeyCache = null
  }
  return apiKeyCache
}
