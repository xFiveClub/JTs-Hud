import { dbAll, dbRun } from '../database/sqlite'
import type { Vec3 } from './scorer'

// Map zones ("callouts") for the director.
//
// A zone is a named point with a radius; a position belongs to the nearest zone whose
// radius contains it. Zones are captured from live/replayed GSI (stand a player on the spot
// and save it) because hand-typing CS2 coordinates is error-prone. They can be exported
// and shared as JSON.

export interface MapZone {
  name: string
  x: number
  y: number
  z: number
  radius: number
  /** Marks a bombsite: used to describe executes and retakes */
  site?: boolean
}

const KEY_PREFIX = 'zones.'
// Zones on different floors (e.g. Nuke) overlap in 2D; ignore zones far above/below
const MAX_HEIGHT_GAP = 180

const cache = new Map<string, MapZone[]>()

export const normalizeMapName = (map?: string | null): string =>
  (map ?? '').substring((map ?? '').lastIndexOf('/') + 1).toLowerCase()

const sanitize = (zones: unknown): MapZone[] => {
  if (!Array.isArray(zones)) throw new Error('Zones must be an array')
  return zones
    .map((z: any) => ({
      name: String(z?.name ?? '')
        .trim()
        .slice(0, 40),
      x: Number(z?.x),
      y: Number(z?.y),
      z: Number(z?.z ?? 0),
      radius: Math.min(3000, Math.max(50, Number(z?.radius ?? 400))),
      site: !!z?.site || undefined
    }))
    .filter((z) => z.name && [z.x, z.y, z.z, z.radius].every(Number.isFinite))
    .slice(0, 200)
}

export const loadAllZones = async (): Promise<void> => {
  const rows: { key: string; value: string }[] = await dbAll(
    `SELECT key, value FROM settings WHERE key LIKE '${KEY_PREFIX}%'`
  )
  cache.clear()
  for (const r of rows) {
    try {
      cache.set(r.key.slice(KEY_PREFIX.length), sanitize(JSON.parse(r.value)))
    } catch {
      /* skip corrupt entry */
    }
  }
}

export const getZones = (map: string): MapZone[] => cache.get(normalizeMapName(map)) ?? []

export const getAllZones = (): Record<string, MapZone[]> => Object.fromEntries(cache)

export const setZones = async (map: string, zones: unknown): Promise<MapZone[]> => {
  const name = normalizeMapName(map)
  if (!name) throw new Error('Map name required')
  const clean = sanitize(zones)
  cache.set(name, clean)
  await dbRun(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [KEY_PREFIX + name, JSON.stringify(clean)]
  )
  return clean
}

/** Import a {map: zones[]} object (e.g. a file someone shared) */
export const importZones = async (data: unknown): Promise<Record<string, MapZone[]>> => {
  if (!data || typeof data !== 'object' || Array.isArray(data))
    throw new Error('Expected { "de_map": [zones] }')
  for (const [map, zones] of Object.entries(data as Record<string, unknown>))
    await setZones(map, zones)
  return getAllZones()
}

export const zoneAt = (zones: MapZone[], pos: Vec3 | null): MapZone | null => {
  if (!pos || !zones.length) return null
  let best: MapZone | null = null
  let bestD = Infinity
  for (const z of zones) {
    if (Math.abs(pos[2] - z.z) > MAX_HEIGHT_GAP) continue
    const d = Math.hypot(pos[0] - z.x, pos[1] - z.y)
    if (d <= z.radius && d < bestD) {
      best = z
      bestD = d
    }
  }
  return best
}
