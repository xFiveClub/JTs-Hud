import crypto from 'crypto'
import os from 'os'
import net from 'net'
import type { IncomingMessage } from 'http'
import type { Request, Response, NextFunction } from 'express'

// Origin guard for the local servers.
//
// The HUD server used to allow every origin (CORS *), so any web page open on the
// broadcast PC could read and modify players, teams, matches and settings. Now a request
// is accepted when it comes from:
//   - a non-browser client (no Origin header): CS2 GSI, curl, OBS same-origin GETs
//   - the same origin it is addressed to: HUDs/overlays served by this server (also over LAN)
//   - localhost / 127.0.0.1 on any port: HUD dev servers (cs2-react-hud etc.)
//   - the Electron app itself (file:// → Origin "null"), which must present the per-run token
// and only when the Host header is a local name or IP literal (blocks DNS rebinding).

export const APP_TOKEN = crypto.randomBytes(24).toString('hex')
export const TOKEN_HEADER = 'x-jts-token'

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

const hostnameOf = (hostHeader: string): string => {
  // "[::1]:1349" -> "[::1]", "localhost:1349" -> "localhost"
  if (hostHeader.startsWith('[')) return hostHeader.slice(0, hostHeader.indexOf(']') + 1)
  return hostHeader.split(':')[0]
}

const machineNames = (): Set<string> => {
  const h = os.hostname().toLowerCase()
  return new Set([h, `${h}.local`, h.replace(/\.local$/, '')])
}

export const isAllowedHost = (hostHeader?: string): boolean => {
  if (!hostHeader) return true
  const name = hostnameOf(hostHeader.toLowerCase())
  if (LOCAL_HOSTNAMES.has(name)) return true
  if (net.isIP(name.replace(/^\[|\]$/g, ''))) return true
  return machineNames().has(name)
}

const isLocalOrigin = (origin: string): boolean => {
  try {
    const u = new URL(origin)
    return (u.protocol === 'http:' || u.protocol === 'https:') && LOCAL_HOSTNAMES.has(u.hostname)
  } catch {
    return false
  }
}

const tokenFrom = (req: IncomingMessage): string | null => {
  const header = req.headers[TOKEN_HEADER]
  if (typeof header === 'string') return header
  // socket.io handshakes carry it in the query string
  const m = /[?&]token=([a-f0-9]+)/.exec(req.url ?? '')
  return m ? m[1] : null
}

const tokenValid = (t: string | null): boolean =>
  !!t &&
  t.length === APP_TOKEN.length &&
  crypto.timingSafeEqual(Buffer.from(t), Buffer.from(APP_TOKEN))

export type GuardResult = 'allow' | 'preflight-only' | 'deny'

export const checkRequest = (req: IncomingMessage): GuardResult => {
  if (!isAllowedHost(req.headers.host)) return 'deny'
  const origin = req.headers.origin
  if (!origin) return 'allow'
  if (
    req.headers.host &&
    (origin === `http://${req.headers.host}` || origin === `https://${req.headers.host}`)
  ) {
    return 'allow'
  }
  if (isLocalOrigin(origin)) return 'allow'
  if (origin === 'null' || origin.startsWith('file://')) {
    if (tokenValid(tokenFrom(req))) return 'allow'
    // Browsers never send custom header values on a CORS preflight; let it through so the
    // real request (which must carry the token) can follow.
    return req.method === 'OPTIONS' ? 'preflight-only' : 'deny'
  }
  return 'deny'
}

/** Express middleware: rejects disallowed requests and answers CORS for allowed ones */
export const originGuard = (req: Request, res: Response, next: NextFunction): void => {
  const result = checkRequest(req)
  if (result === 'deny') {
    res.status(403).json({ error: 'Origin not allowed' })
    return
  }
  const origin = req.headers.origin
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE')
    res.setHeader('Access-Control-Allow-Headers', `Content-Type, ${TOKEN_HEADER}`)
  }
  if (req.method === 'OPTIONS') {
    res.status(204).end()
    return
  }
  next()
}

/** socket.io allowRequest hook */
export const socketAllowRequest = (
  req: IncomingMessage,
  cb: (err: string | null, ok: boolean) => void
): void => {
  const ok = checkRequest(req) === 'allow'
  cb(ok ? null : 'Origin not allowed', ok)
}
