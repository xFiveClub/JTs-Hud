import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'

// Smoke test of the packaged-style build (out/): the app boots, the renderer can talk to
// the local API through the origin guard, and the AI Director page and overlay load.

let app: ElectronApplication
let page: Page
const API = 'http://localhost:1349'

test.beforeAll(async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'jts-e2e-'))
  app = await electron.launch({
    args: [path.join(__dirname, '..', 'out', 'main', 'index.js')],
    env: { ...process.env, JTS_USER_DATA_DIR: userData }
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
})

test.afterAll(async () => {
  await app?.close()
})

test('boots and shows the sidebar', async () => {
  await expect(page.getByText('AI Director').first()).toBeVisible()
  await expect(page.getByText('Spectator Binds').first()).toBeVisible()
})

test('renderer reaches the API with its token (origin guard)', async () => {
  const status = await page.evaluate(
    async (api) => (await fetch(`${api}/api/settings`)).status,
    API
  )
  expect(status).toBe(200)
})

test('foreign websites are rejected, CS2-style clients are not', async () => {
  const evil = await fetch(`${API}/api/settings`, { headers: { Origin: 'https://evil.example' } })
  expect(evil.status).toBe(403)
  const plain = await fetch(`${API}/api/settings`)
  expect(plain.status).toBe(200)
  const gsi = await fetch('http://localhost:23415/cs2/input', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: { steamid: '1' } })
  })
  expect(gsi.status).toBe(200)
})

test('AI Director page renders and settings round-trip over IPC', async () => {
  await page.evaluate(() => (window.location.hash = '#/director'))
  await expect(page.getByRole('button', { name: 'Start Director' })).toBeVisible()
  const cfg = await page.evaluate(() => window.api.director.getConfig())
  expect(cfg.commandTemplate).toContain('{accountid}')
  expect(cfg).not.toHaveProperty('llmApiKey')
  const saved = await page.evaluate(() =>
    window.api.director.setConfig({ minShotMs: 3000, llmApiKey: 'sk-e2e' })
  )
  expect(saved.minShotMs).toBe(3000)
  expect(saved.llmApiKeySet).toBe(true)
  expect(JSON.stringify(saved)).not.toContain('sk-e2e')
})

test('director overlay is served', async () => {
  const res = await fetch(`${API}/overlays/director/`)
  expect(res.status).toBe(200)
  expect(await res.text()).toContain('director:overlay')
})

test('socket.io handshake: app token accepted, token-less "null" origin rejected', async () => {
  const ok = await page.evaluate(async (api) => {
    const r = await fetch(`${api}/socket.io/?EIO=4&transport=polling&token=${window.api.appToken}`)
    return r.status
  }, API)
  expect(ok).toBe(200)
  const denied = await fetch(`${API}/socket.io/?EIO=4&transport=polling`, {
    headers: { Origin: 'null' }
  })
  expect(denied.status).not.toBe(200)
})
