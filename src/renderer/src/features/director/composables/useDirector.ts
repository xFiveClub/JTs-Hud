import { ref, onMounted, onUnmounted } from 'vue'
import { socket } from '../../../socket'
import { port } from '../../../index'

export interface DirectorConfig {
  useAI: boolean
  minShotMs: number
  maxShotMs: number
  deathHoldMs: number
  switchMargin: number
  manualOverrideMs: number
  commandTemplate: string
  disableGameAutodirector: boolean
  llmBaseUrl: string
  llmModel: string
  aiIntervalMs: number
  lookaheadDelaySec: number
  lookaheadLeadSec: number
  overlayStoryline: boolean
  overlayFocusCard: boolean
  overlayClutch: boolean
  overlayExecute: boolean
  overlayReason: boolean
  llmApiKeySet: boolean
  llmApiKeyEncrypted: boolean
}

export interface DirectorStatus {
  enabled: boolean
  simulation: boolean
  lockedOn: string | null
  netconConnected: boolean
  netconTarget: string
  receivingGsi: boolean
  lookahead: { receiving: boolean; active: boolean; predicted: string[] }
  map: string | null
  phase: string | null
  players: {
    steamid: string
    name: string
    side: 'CT' | 'T'
    zone: string | null
    pos: number[] | null
  }[]
  execute: string | null
  pausedForMs: number
  observed: { steamid: string; name: string } | null
  scores: {
    steamid: string
    name: string
    side: 'CT' | 'T'
    score: number
    inCombat: boolean
    reasons: string[]
  }[]
  cuts: { at: number; name: string; reason: string }[]
  warning: string | null
  ai: {
    enabled: boolean
    state: 'off' | 'idle' | 'thinking' | 'error'
    storyline: string | null
    focusSide: 'CT' | 'T' | null
    weights: { name: string; weight: number }[]
    latencyMs: number | null
    planAgeMs: number | null
    error: string | null
  }
}

export const COMMAND_PRESETS = [
  { value: 'spec_player_by_accountid {accountid}', label: 'By Steam account id (recommended)' },
  { value: 'spec_player "{name}"', label: 'By player name' },
  { value: 'spec_player {slot}', label: 'By observer slot' }
]

export function useDirector() {
  const config = ref<DirectorConfig | null>(null)
  const status = ref<DirectorStatus | null>(null)
  const apiKeyInput = ref('')
  const saving = ref(false)
  const toggling = ref(false)
  const testingAI = ref(false)
  const message = ref<{ ok: boolean; text: string } | null>(null)

  const flash = (ok: boolean, text: string): void => {
    message.value = { ok, text }
    setTimeout(() => {
      if (message.value?.text === text) message.value = null
    }, 4000)
  }

  const load = async (): Promise<void> => {
    config.value = await window.api.director.getConfig()
    status.value = await window.api.director.getStatus()
  }

  const save = async (): Promise<boolean> => {
    if (!config.value) return false
    saving.value = true
    try {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { llmApiKeySet, llmApiKeyEncrypted, ...rest } = config.value
      const updates: Record<string, unknown> = { ...rest }
      if (apiKeyInput.value.trim()) updates.llmApiKey = apiKeyInput.value.trim()
      config.value = await window.api.director.setConfig(updates)
      apiKeyInput.value = ''
      flash(true, 'Director settings saved')
      return true
    } catch (err: any) {
      flash(false, err?.message ?? 'Could not save settings')
      return false
    } finally {
      saving.value = false
    }
  }

  const clearApiKey = async (): Promise<void> => {
    config.value = await window.api.director.setConfig({ llmApiKey: null })
    flash(true, 'API key removed')
  }

  const toggle = async (): Promise<void> => {
    toggling.value = true
    try {
      status.value = await window.api.director.setEnabled(!status.value?.enabled)
    } finally {
      toggling.value = false
    }
  }

  const testAI = async (): Promise<void> => {
    testingAI.value = true
    try {
      if (!(await save())) return
      const r = await window.api.director.testLLM()
      flash(r.ok, r.ok ? `AI reachable: ${r.message}` : `AI test failed: ${r.message}`)
    } finally {
      testingAI.value = false
    }
  }

  const setSimulation = async (on: boolean): Promise<void> => {
    status.value = await window.api.director.setSimulation(on)
  }
  const toggleLock = (): Promise<unknown> => window.api.director.toggleLock()
  const nextCut = (): Promise<void> => window.api.director.next()

  const copy = async (text: string, what: string): Promise<void> => {
    await navigator.clipboard.writeText(text)
    flash(true, `${what} copied to clipboard`)
  }
  const copyLookaheadCfg = async (host: string): Promise<void> =>
    copy(await window.api.director.lookaheadCfg(host), 'Look-ahead GSI cfg')
  const overlayUrl = `http://localhost:${port}/overlays/director/`
  const copyOverlayUrl = (): Promise<void> => copy(overlayUrl, 'Overlay URL')
  const openOverlayPreview = (): Promise<void> => window.api.openExternal(`${overlayUrl}?preview=1`)

  const onStatus = (s: DirectorStatus): void => {
    status.value = s
  }

  onMounted(() => {
    load()
    socket.on('director:status', onStatus)
  })
  onUnmounted(() => {
    socket.off('director:status', onStatus)
  })

  return {
    config,
    status,
    apiKeyInput,
    saving,
    toggling,
    testingAI,
    message,
    save,
    clearApiKey,
    toggle,
    testAI,
    setSimulation,
    toggleLock,
    nextCut,
    copyLookaheadCfg,
    overlayUrl,
    copyOverlayUrl,
    openOverlayPreview
  }
}
