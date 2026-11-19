import dotenv from 'dotenv'
dotenv.config() // Load .env variables before anything else

import './database/sqlite'
import express from 'express'

import { createServer } from 'http'
import { Server } from 'socket.io'
import { setupSockets } from './socket'
import { setupGSI } from './integrations/gsi'

import createMatchRouter from './domains/matches/match.routes'
import playerRoutes from './domains/players/player.routes'
import teamRoutes from './domains/teams/team.routes'
import createHudRouter from './domains/huds/hud.routes'
import settingsRoutes from './domains/settings/settings.routes'
import spectatorRoutes from './domains/spectator/spectator.routes'
import { uploadsPath } from './utils/multer'
import { getHudsDir, getBuiltinHudDir, getOverlaysDir } from '../paths'
import { signedHudMiddleware } from './middleware/signedHudMiddleware'
import { originGuard, socketAllowRequest } from './middleware/originGuard'

// Track the currently active HUD id so the socket register handler can look up correct HUD
let activeHudId: string | null = null
export const setActiveHudId = (id: string | null) => {
  activeHudId = id
}
export const getActiveHudId = () => activeHudId

// Setup HUD Server (Port 1349)
const hudsPath = getHudsDir()
const app = express()

// Only the app itself, localhost HUD dev servers and same-origin pages may call the API
app.use(originGuard)

const httpServer = createServer(app)
export const io = new Server(httpServer, {
  // Origin policy is enforced by allowRequest; reflect the origin for allowed handshakes
  cors: { origin: true },
  allowRequest: socketAllowRequest
})

app.use(express.json())
// Middleware to handle signed HUD files (decode JWT before serving)
app.use(signedHudMiddleware)
// The default mount must come first so it takes priority over the user huds folder
app.use('/huds/default', express.static(getBuiltinHudDir()))
app.use('/huds', express.static(hudsPath))
// Browser-source overlays (AI Director overlay at /overlays/director/)
app.use('/overlays', express.static(getOverlaysDir()))
app.use('/api/uploads', express.static(uploadsPath))

app.use('/api/huds', createHudRouter(io))
app.use('/api/teams', teamRoutes)
app.use('/api/players', playerRoutes)
app.use('/api/match', createMatchRouter(io))
app.use('/api/settings', settingsRoutes)
app.use('/api/spectator', spectatorRoutes)

setupSockets(io)

// Setup GSI Listener Server (Port 23415)
const gsiApp = express()
// CS2 posts without an Origin header; browsers on other sites are rejected
gsiApp.use(originGuard)
gsiApp.use(express.json({ limit: '5mb' }))
gsiApp.use('/cs2', setupGSI(io)) // This is what the gsi cfg file sends data to

const HUD_PORT = process.env.HUD_PORT || 1349
const GSI_PORT = process.env.GSI_PORT || 23415

let serversRunning = false

// Start both servers
export function startServers(): void {
  if (serversRunning) return
  serversRunning = true

  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[HUD Server] Port ${HUD_PORT} is already in use.`)
    } else {
      console.error('[HUD Server] Server error:', err)
    }
  })
  httpServer.listen(HUD_PORT, () => {
    console.log(`HUD Server and WebSockets listening on port ${HUD_PORT}`)
  })

  const gsiServer = gsiApp.listen(GSI_PORT, () => {
    console.log(`CS2 GSI Listener running on port ${GSI_PORT}`)
  })
  gsiServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[GSI Server] Port ${GSI_PORT} is already in use.`)
    } else {
      console.error('[GSI Server] Server error:', err)
    }
  })

  // Store reference so stopServers/shutdown can close it
  activeGsiServer = gsiServer
}

let activeGsiServer: ReturnType<typeof gsiApp.listen> | null = null

// Stop both servers
export function stopServers(): Promise<void> {
  if (!serversRunning) return Promise.resolve()
  serversRunning = false
  return new Promise((resolve) => {
    const done = () => {
      activeGsiServer = null
      resolve()
    }
    io.close(() => {
      httpServer.closeAllConnections?.()
      httpServer.close(() => {
        if (activeGsiServer) {
          activeGsiServer.closeAllConnections?.()
          activeGsiServer.close(() => {
            console.log('[Server] Servers stopped.')
            done()
          })
        } else {
          done()
        }
      })
    })
  })
}

// Gracefully shut down all servers and socket connections (called on app quit)
export function shutdown(): Promise<void> {
  return stopServers()
}
