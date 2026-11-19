import { describe, it, expect, beforeEach } from 'vitest'
import {
  getZones,
  importZones,
  setZones,
  zoneAt,
  normalizeMapName
} from '../src/main/server/director/zones'

describe('map zones', () => {
  beforeEach(async () => {
    await setZones('de_nuke', [])
  })

  it('normalises workshop-style map names', () => {
    expect(normalizeMapName('workshop/123/de_Nuke')).toBe('de_nuke')
  })

  it('finds the nearest zone in range and respects floors', async () => {
    const zones = await setZones('de_nuke', [
      { name: 'A site', x: 0, y: 0, z: 0, radius: 500, site: true },
      { name: 'B site', x: 0, y: 0, z: -400, radius: 500, site: true },
      { name: 'Hut', x: 450, y: 0, z: 0, radius: 300 }
    ])
    expect(zoneAt(zones, [100, 0, 10])?.name).toBe('A site')
    expect(zoneAt(zones, [400, 0, 0])?.name).toBe('Hut')
    expect(zoneAt(zones, [0, 0, -380])?.name).toBe('B site')
    expect(zoneAt(zones, [2000, 0, 0])).toBeNull()
  })

  it('sanitises imported data', async () => {
    await importZones({
      DE_NUKE: [
        { name: '  Ramp ', x: '10', y: 20, radius: 99999 },
        { name: '', x: 1, y: 1 },
        { x: 'a' }
      ]
    })
    expect(getZones('de_nuke')).toEqual([
      { name: 'Ramp', x: 10, y: 20, z: 0, radius: 3000, site: undefined }
    ])
  })

  it('rejects malformed imports', async () => {
    await expect(importZones([1, 2] as any)).rejects.toThrow()
  })
})
