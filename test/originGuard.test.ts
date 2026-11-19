import { describe, it, expect } from 'vitest'
import { APP_TOKEN, checkRequest } from '../src/main/server/middleware/originGuard'

const req = (headers: Record<string, string>, method = 'GET', url = '/api/players') =>
  ({ headers, method, url }) as any

describe('origin guard', () => {
  it('allows non-browser clients (CS2 GSI, curl)', () => {
    expect(checkRequest(req({ host: 'localhost:23415' }, 'POST'))).toBe('allow')
  })

  it('allows same-origin pages, including OBS over LAN', () => {
    expect(
      checkRequest(req({ host: '192.168.1.20:1349', origin: 'http://192.168.1.20:1349' }, 'PUT'))
    ).toBe('allow')
  })

  it('allows localhost HUD dev servers', () => {
    expect(
      checkRequest(req({ host: 'localhost:1349', origin: 'http://localhost:3500' }, 'POST'))
    ).toBe('allow')
  })

  it('blocks other websites', () => {
    expect(
      checkRequest(req({ host: 'localhost:1349', origin: 'https://evil.example' }, 'PUT'))
    ).toBe('deny')
    expect(
      checkRequest(req({ host: 'localhost:1349', origin: 'http://localhost.evil.example' }, 'GET'))
    ).toBe('deny')
  })

  it('blocks DNS rebinding (foreign Host header)', () => {
    expect(checkRequest(req({ host: 'rebind.evil.example:1349' }))).toBe('deny')
  })

  it('requires the app token for Origin "null" (packaged app / sandboxed iframes)', () => {
    expect(checkRequest(req({ host: 'localhost:1349', origin: 'null' }, 'PUT'))).toBe('deny')
    expect(checkRequest(req({ host: 'localhost:1349', origin: 'null' }, 'OPTIONS'))).toBe(
      'preflight-only'
    )
    expect(
      checkRequest(req({ host: 'localhost:1349', origin: 'null', 'x-jts-token': APP_TOKEN }, 'PUT'))
    ).toBe('allow')
    expect(
      checkRequest(
        req({ host: 'localhost:1349', origin: 'null', 'x-jts-token': 'f'.repeat(48) }, 'PUT')
      )
    ).toBe('deny')
  })

  it('accepts the token in the socket.io handshake query', () => {
    expect(
      checkRequest(
        req(
          { host: 'localhost:1349', origin: 'null' },
          'GET',
          `/socket.io/?EIO=4&token=${APP_TOKEN}`
        )
      )
    ).toBe('allow')
  })
})
