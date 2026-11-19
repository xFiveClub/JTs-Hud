import { ipcMain, shell } from 'electron'
import { director } from './director'
import {
  getApiKey,
  getDirectorConfig,
  getDirectorConfigPublic,
  updateDirectorConfig
} from './config'
import { testLLM } from './llm'
import { getAllZones, getZones, importZones, setZones } from './zones'
import {
  deleteRecording,
  getRecorderStatus,
  getRecordingsDir,
  gsiRecorder,
  gsiReplayer,
  listRecordings,
  onRecorderStatus
} from '../integrations/gsiRecorder'

const GSI_PORT = process.env.GSI_PORT || 23415

/** GSI cfg for the second, undelayed client that feeds the look-ahead endpoint */
export const lookaheadCfg = (host: string): string => `"JTS_HUD_LOOKAHEAD"
{
	"uri"		"http://${host}:${GSI_PORT}/cs2/lookahead"
	"timeout"		"0.1"
	"buffer"		"0"
	"throttle"		"0"
	"heartbeat"		"0.05"
	"data"
	{
		"provider"		"1"
		"map"		"1"
		"round"		"1"
		"allplayers_id"		"1"
		"allplayers_state"		"1"
		"allplayers_weapons"		"1"
		"allplayers_position"		"1"
		"bomb"		"1"
	}
}
`

// Director control lives on IPC only (see config.ts for why it is not on the HTTP API).
export function registerDirectorIpc(): void {
  ipcMain.handle('director:get-config', () => getDirectorConfigPublic())

  ipcMain.handle('director:set-config', async (_, updates) => {
    const cfg = await updateDirectorConfig(updates ?? {})
    await director.reloadConfig()
    return cfg
  })

  ipcMain.handle('director:set-enabled', async (_, enabled: boolean) => {
    if (enabled) await director.start()
    else director.stop()
    return director.getStatus()
  })

  ipcMain.handle('director:get-status', () => director.getStatus())

  ipcMain.handle('director:set-simulation', (_, on: boolean) => {
    director.setSimulation(!!on)
    return director.getStatus()
  })
  ipcMain.handle('director:toggle-lock', () => director.toggleLock())
  ipcMain.handle('director:next', () => director.requestNextCut())

  ipcMain.handle('director:test-llm', async () => {
    const cfg = await getDirectorConfig()
    try {
      const r = await testLLM({
        baseUrl: cfg.llmBaseUrl,
        model: cfg.llmModel,
        apiKey: await getApiKey()
      })
      return { ok: true, message: `OK in ${r.latencyMs} ms — "${r.reply}"` }
    } catch (err: any) {
      return { ok: false, message: String(err?.message ?? err) }
    }
  })

  ipcMain.handle('director:lookahead-cfg', (_, host?: string) => lookaheadCfg(host || '127.0.0.1'))

  // --- Map zones ---
  ipcMain.handle('zones:get', (_, map: string) => getZones(map))
  ipcMain.handle('zones:set', (_, map: string, zones: unknown) => setZones(map, zones))
  ipcMain.handle('zones:export', () => JSON.stringify(getAllZones(), null, 2))
  ipcMain.handle('zones:import', (_, json: string) => importZones(JSON.parse(json)))

  // --- GSI recording / replay ---
  ipcMain.handle('recorder:status', () => getRecorderStatus())
  ipcMain.handle('recorder:list', () => listRecordings())
  ipcMain.handle('recorder:start', (_, label?: string) => gsiRecorder.start(label))
  ipcMain.handle('recorder:stop', () => gsiRecorder.stop())
  ipcMain.handle('recorder:delete', (_, name: string) => deleteRecording(name))
  ipcMain.handle('recorder:open-folder', () => shell.openPath(getRecordingsDir()))

  // Replays run the director in simulation by default so CS2's camera is left alone
  let replaySetSimulation = false
  ipcMain.handle(
    'replay:start',
    async (_, name: string, opts?: { speed?: number; simulate?: boolean }) => {
      if (gsiRecorder.active) throw new Error('Stop the recording before replaying')
      const simulate = opts?.simulate ?? true
      if (simulate && !director.isSimulation()) {
        director.setSimulation(true)
        replaySetSimulation = true
      }
      await gsiReplayer.start(name, opts?.speed ?? 1)
    }
  )
  ipcMain.handle('replay:pause', (_, paused: boolean) => gsiReplayer.setPaused(!!paused))
  ipcMain.handle('replay:speed', (_, speed: number) => gsiReplayer.setSpeed(Number(speed)))
  ipcMain.handle('replay:stop', () => gsiReplayer.stop())

  onRecorderStatus((s) => {
    if (!s.replaying && replaySetSimulation) {
      replaySetSimulation = false
      director.setSimulation(false)
    }
  })
}
