import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeMatch, accountId } from './helpers/gsi'

// Capture every console command the director sends to CS2
const sent: string[] = []
vi.mock('../src/main/server/integrations/netcon', () => ({
  netcon: {
    connected: true,
    target: { host: '127.0.0.1', port: 2020 },
    connect: async () => {},
    send: async (cmd: string) => {
      sent.push(cmd)
    },
    onStatus: () => () => {}
  }
}))

type Director = typeof import('../src/main/server/director/director').director

const fakeIo = { except: () => ({ emit: () => {} }), emit: () => {} } as any

async function setup(opts: { simulation: boolean; config?: Record<string, unknown> }) {
  vi.resetModules()
  sent.length = 0
  // The in-memory settings table survives resetModules: start every test from defaults
  const db = (await import('../src/main/server/database/sqlite')) as any
  db.__settings.clear()
  const { updateDirectorConfig } = await import('../src/main/server/director/config')
  const { director } = await import('../src/main/server/director/director')
  await updateDirectorConfig({
    minShotMs: 1500,
    deathHoldMs: 600,
    manualOverrideMs: 2000,
    maxShotMs: 8000,
    ...opts.config
  })
  director.attach(fakeIo)
  director.setSimulation(opts.simulation)
  await director.start()
  const match = makeMatch()
  let now = 1_000_000
  /** Advance the game clock, ticking every 50 ms like a GSI feed */
  const run = (ms: number): void => {
    const end = now + ms
    while (now < end) {
      now += 50
      director.onGameState(match.raw(), new Set(), now)
    }
  }
  const onCamera = (): string | undefined => director.getStatus().observed?.name
  return { director, match, run, onCamera }
}

let current: Director | null = null
afterEach(() => {
  current?.stop()
  current = null
  vi.useRealTimers()
})

describe('director cut rules (simulation)', () => {
  let ctx: Awaited<ReturnType<typeof setup>>
  beforeEach(async () => {
    ctx = await setup({ simulation: true })
    current = ctx.director
    ctx.match.state.camera = null
  })

  it('picks someone immediately when nothing is on camera', () => {
    ctx.run(100)
    expect(ctx.onCamera()).toBeDefined()
  })

  it('cuts to an imminent duel, stays during the fight, then follows the killer', () => {
    const { match, run, onCamera } = ctx
    run(2000)
    const ctC = match.byName('ctC')
    const tC = match.byName('tC')
    ctC.pos = [0, 0, 0]
    ctC.fwd = [1, 0, 0]
    tC.pos = [600, 0, 0]
    tC.fwd = [-1, 0, 0]
    run(2500)
    expect(['ctC', 'tC']).toContain(onCamera())
    const duelCam = onCamera()!

    // Fight starts; a hotter player elsewhere must not steal the shot
    ctC.hp = 60
    tC.roundDamage = 40
    match.byName('ctD').roundKills = 3
    run(400)
    expect(onCamera()).toBe(duelCam)

    // ctC dies to tC
    ctC.hp = 0
    tC.roundKills = 1
    tC.roundDamage = 140
    run(300)
    if (duelCam === 'ctC') expect(onCamera()).toBe('ctC') // hold on the death
    run(1000)
    expect(onCamera()).toBe('tC')
  })

  it('hard-cuts to a plant even before the minimum shot length', () => {
    const { match, run, onCamera } = ctx
    run(500)
    expect(onCamera()).not.toBe('tD')
    match.state.bomb = {
      state: 'planting',
      player: match.byName('tD').steamid,
      position: '3000, 900, 0'
    }
    run(100)
    expect(onCamera()).toBe('tD')
  })

  it('honours lock and next', () => {
    const { director, match, run, onCamera } = ctx
    run(500)
    const locked = onCamera()!
    director.toggleLock()
    match.state.bomb = {
      state: 'planting',
      player: match.byName('tD').steamid,
      position: '3000, 900, 0'
    }
    run(500)
    expect(onCamera()).toBe(locked)
    director.toggleLock()
    director.requestNextCut()
    run(100)
    expect(onCamera()).not.toBe(locked)
  })

  it('cuts to the clutch player', () => {
    const { match, run, onCamera } = ctx
    run(500)
    for (const n of ['ctA', 'ctB', 'ctD', 'ctE', 'tA', 'tB', 'tE']) match.byName(n).hp = 0
    match.byName('ctC').pos = [2500, 700, 0]
    run(5000)
    expect(onCamera()).toBe('ctC')
    const top = ctx.director.getStatus().scores[0]
    expect(top.reasons.some((r) => r.startsWith('1v2'))).toBe(true)
  })

  it('boosts players around a utility execute and logs it', () => {
    const { director, match, run } = ctx
    run(200)
    const tA = match.byName('tA')
    const target: [number, number, number] = [500, 500, 0]
    // Two smokes pop and a flash detonates around the same spot
    match.state.grenades = {
      '1': {
        owner: tA.steamid,
        type: 'smoke',
        position: '450, 500, 0',
        velocity: '0,0,0',
        lifetime: '2',
        effecttime: '0.5'
      },
      '2': {
        owner: match.byName('tB').steamid,
        type: 'smoke',
        position: '600, 450, 0',
        velocity: '0,0,0',
        lifetime: '2',
        effecttime: '0.2'
      },
      '3': {
        owner: match.byName('tC').steamid,
        type: 'flashbang',
        position: '520, 520, 50',
        velocity: '0,0,0',
        lifetime: '1'
      }
    }
    run(100)
    delete match.state.grenades['3'] // flash detonated
    match.byName('ctB').pos = [...target]
    run(100)
    const status = director.getStatus()
    expect(status.execute).toMatch(/T utility burst \(2 smokes, 1 flash\)/)
    const ctB = status.scores.find((s) => s.name === 'ctB')!
    expect(ctB.reasons.some((r) => r.startsWith('site under execute'))).toBe(true)
  })
})

describe('director against CS2 (commands)', () => {
  it('sends the account-id command and backs off on a manual camera change', async () => {
    const ctx = await setup({ simulation: false })
    current = ctx.director
    const { match, run } = ctx
    run(200)
    expect(sent).toContain('spec_autodirector 0')

    // Make tB clearly the most interesting, and confirm CS2 "switched" when asked
    match.state.bomb = {
      state: 'planting',
      player: match.byName('tB').steamid,
      position: '3000, 1800, 0'
    }
    run(100)
    expect(sent).toContain(`spec_player_by_accountid ${accountId(match.byName('tB').steamid)}`)
    match.state.camera = match.byName('tB').steamid
    run(2000)
    match.state.bomb = { state: 'planted', position: '3000, 1800, 0' }

    // Human switches to ctE (alive) → paused
    match.state.camera = match.byName('ctE').steamid
    run(100)
    expect(ctx.director.getStatus().pausedForMs).toBeGreaterThan(0)
    const before = sent.length
    match.state.bomb = {
      state: 'defusing',
      player: match.byName('ctA').steamid,
      position: '3000, 1800, 0'
    }
    run(1000)
    expect(sent.length).toBe(before) // still paused: no commands
    run(1500)
    expect(sent.length).toBeGreaterThan(before) // resumed: cut to the defuser
  })

  it('strips console separators from names in the name template', async () => {
    const ctx = await setup({
      simulation: false,
      config: { commandTemplate: 'spec_player "{name}"' }
    })
    current = ctx.director
    const tD = ctx.match.byName('tD')
    tD.name = 'evil";quit'
    ctx.match.state.bomb = { state: 'planting', player: tD.steamid, position: '0,0,0' }
    ctx.run(100)
    expect(sent).toContain('spec_player "evilquit"')
    expect(sent.some((c) => c.includes(';quit'))).toBe(false)
  })
})

describe('look-ahead', () => {
  it('moves the camera to a fight before it shows on the delayed feed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(5_000_000)
    const ctx = await setup({
      simulation: false,
      config: { lookaheadDelaySec: 5, lookaheadLeadSec: 1.5 }
    })
    current = ctx.director
    const { director, match } = ctx
    const delayed = makeMatch()
    delayed.state.camera = delayed.byName('ctA').steamid

    // Ticks on wall-clock time; the look-ahead feed sees the fight 5 s early
    const tick = (ms: number, both = true): void => {
      const end = Date.now() + ms
      while (Date.now() < end) {
        vi.setSystemTime(Date.now() + 50)
        if (both) director.onLookahead(match.raw(), new Set(), Date.now())
        director.onGameState(delayed.raw(), new Set(), Date.now())
        const cmd = sent[sent.length - 1]
        const m = cmd && /accountid (\d+)/.exec(cmd)
        if (m)
          delayed.state.camera = delayed.players.find((p) => accountId(p.steamid) === m[1])!.steamid
      }
    }
    tick(3000)
    // Fight starts on the look-ahead feed only
    match.byName('tE').hp = 70
    tick(100)
    expect(director.getStatus().lookahead.active).toBe(true)
    tick(3000) // t+3.1 s: not yet inside the lead window (5 - 1.5 = 3.5 s)
    expect(director.getStatus().observed?.name).not.toBe('tE')
    tick(800) // t+3.9 s: inside the window, 1.1 s before the fight airs
    expect(director.getStatus().observed?.name).toBe('tE')
    expect(director.getStatus().cuts[0].reason).toMatch(/look-ahead/)
  })
})
