import { describe, it, expect, vi, afterEach } from 'vitest'
import { requestPlan, buildRoundSummary } from '../src/main/server/director/llm'

const players: any[] = [
  { steamid: '1', name: 'ctA', side: 'CT', alive: true, pos: [0, 0, 0], zone: 'A site' },
  { steamid: '2', name: 'tB', side: 'T', alive: true, pos: [100, 0, 0], zone: null }
]
const settings = { baseUrl: 'http://llm.test/v1/', model: 'm', apiKey: 'sk-test' }
const summary = buildRoundSummary(
  {
    map: { name: 'de_inferno', round: 4, team_ct: {}, team_t: {} },
    round: { phase: 'live' }
  } as any,
  players,
  [],
  'ctA'
)

const reply = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })

afterEach(() => vi.unstubAllGlobals())

describe('LLM plan', () => {
  it('adapts to endpoints that reject max_tokens / temperature and remembers it', async () => {
    const bodies: any[] = []
    vi.stubGlobal('fetch', async (_url: string, init: any) => {
      const body = JSON.parse(init.body)
      bodies.push(body)
      if ('max_tokens' in body)
        return new Response('Unsupported parameter: max_tokens', { status: 400 })
      if ('temperature' in body)
        return new Response('Unsupported value: temperature', { status: 400 })
      return reply('{"weights":{"ctA":1.5}}')
    })
    await requestPlan(settings, summary, players)
    expect(bodies).toHaveLength(3)
    expect(bodies[2]).toMatchObject({
      max_completion_tokens: 800,
      response_format: { type: 'json_object' }
    })
    expect(bodies[2]).not.toHaveProperty('temperature')

    await requestPlan(settings, summary, players)
    expect(bodies).toHaveLength(4) // learned: one request
  })

  it('validates the plan: clamps weights, drops unknown players, normalises side', async () => {
    vi.stubGlobal('fetch', async () =>
      reply(
        'Sure! {"weights":{"CTA":1.8,"Ghost":3,"tB":0.1},"focus_side":"t","freezetime_focus":"tB","storyline":"T stack B"}'
      )
    )
    const plan = await requestPlan(
      { ...settings, baseUrl: 'http://other.test/v1' },
      summary,
      players
    )
    expect(plan.weights).toEqual({ '1': 1.8, '2': 0.5 })
    expect(plan.focusSide).toBe('T')
    expect(plan.freezetimeFocus).toBe('2')
    expect(plan.storyline).toBe('T stack B')
  })

  it('sends the API key only as a bearer header to the configured URL', async () => {
    let seen: { url: string; auth: string } | null = null
    vi.stubGlobal('fetch', async (url: string, init: any) => {
      seen = { url, auth: init.headers.Authorization }
      return reply('{}')
    })
    await requestPlan({ ...settings, baseUrl: 'http://third.test/v1/' }, summary, players)
    expect(seen).toEqual({ url: 'http://third.test/v1/chat/completions', auth: 'Bearer sk-test' })
  })

  it('includes zones in the round summary', () => {
    const ct = (summary as any).CT
    expect(ct.players[0].zone).toBe('A site')
    expect(ct.groups[0]).toBe('ctA @ A site')
  })
})
