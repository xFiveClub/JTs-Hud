// Builds synthetic CS2 GSI payloads for a 5v5 so tests can script a round tick by tick.

export const STEAMID64_BASE = 76561197960265728n
export const OBSERVER_STEAMID = '76561190000000000'

export interface FakePlayer {
  steamid: string
  name: string
  side: 'CT' | 'T'
  pos: [number, number, number]
  fwd: [number, number, number]
  hp: number
  roundKills: number
  roundDamage: number
  matchKills: number
  weapons: Record<string, any>
}

export const accountId = (steamid: string): string => (BigInt(steamid) - STEAMID64_BASE).toString()

export function makeMatch() {
  const names = ['ctA', 'ctB', 'ctC', 'ctD', 'ctE', 'tA', 'tB', 'tC', 'tD', 'tE']
  const players: FakePlayer[] = names.map((name, i) => {
    const ct = i < 5
    return {
      steamid: (STEAMID64_BASE + BigInt(1000 + i)).toString(),
      name,
      side: ct ? 'CT' : 'T',
      // Teams start far apart, looking at each other's spawn
      pos: ct ? [-3000, i * 300, 0] : [3000, i * 300, 0],
      fwd: [ct ? 1 : -1, 0, 0],
      hp: 100,
      roundKills: 0,
      roundDamage: 0,
      matchKills: i,
      weapons: { weapon_0: { name: 'weapon_ak47', type: 'Rifle', state: 'active' } }
    }
  })

  const state = {
    players,
    phase: 'live' as 'freezetime' | 'live' | 'over',
    bomb: undefined as any,
    grenades: {} as Record<string, any>,
    camera: players[0].steamid as string | null,
    map: 'de_mirage'
  }

  const byName = (name: string): FakePlayer => {
    const p = players.find((x) => x.name === name)
    if (!p) throw new Error(`no player ${name}`)
    return p
  }

  const raw = (): any => ({
    provider: { steamid: OBSERVER_STEAMID },
    map: {
      name: state.map,
      round: 3,
      team_ct: { score: 2, name: 'Blue' },
      team_t: { score: 1, name: 'Gold' }
    },
    round: { phase: state.phase },
    bomb: state.bomb,
    grenades: state.grenades,
    player: state.camera
      ? {
          steamid: state.camera,
          name: players.find((p) => p.steamid === state.camera)?.name,
          spectarget: state.camera
        }
      : { steamid: OBSERVER_STEAMID, name: 'observer', spectarget: 'free' },
    allplayers: Object.fromEntries(
      players.map((p, i) => [
        p.steamid,
        {
          name: p.name,
          team: p.side,
          observer_slot: (i + 1) % 10,
          state: {
            health: p.hp,
            armor: 100,
            helmet: true,
            flashed: 0,
            burning: 0,
            money: 3000,
            round_kills: p.roundKills,
            round_killhs: 0,
            round_totaldmg: p.roundDamage,
            equip_value: 4500
          },
          match_stats: { kills: p.matchKills, assists: 1, deaths: 2, mvps: 1, score: 10 },
          weapons: p.weapons,
          position: p.pos.join(', '),
          forward: p.fwd.join(', ')
        }
      ])
    )
  })

  return { state, players, byName, raw }
}
