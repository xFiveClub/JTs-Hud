import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const appToken =
  process.argv.find((a) => a.startsWith('--jts-token='))?.slice('--jts-token='.length) ?? ''

const api = {
  // Token for the local HUD server API (see server/middleware/originGuard.ts)
  appToken,

  // Open a URL in the system browser
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('open-external', url),

  // Listen for update-available notifications from the main process
  onUpdateAvailable: (callback: (version: string) => void): void => {
    ipcRenderer.on('update-available', (_event, version) => callback(version))
  },

  // AI Director (config incl. API key only travels over IPC, never HTTP)
  director: {
    getConfig: () => ipcRenderer.invoke('director:get-config'),
    setConfig: (updates: Record<string, unknown>) =>
      ipcRenderer.invoke('director:set-config', updates),
    setEnabled: (enabled: boolean) => ipcRenderer.invoke('director:set-enabled', enabled),
    getStatus: () => ipcRenderer.invoke('director:get-status'),
    testLLM: () => ipcRenderer.invoke('director:test-llm'),
    setSimulation: (on: boolean) => ipcRenderer.invoke('director:set-simulation', on),
    toggleLock: () => ipcRenderer.invoke('director:toggle-lock'),
    next: () => ipcRenderer.invoke('director:next'),
    lookaheadCfg: (host?: string) => ipcRenderer.invoke('director:lookahead-cfg', host)
  },

  zones: {
    get: (map: string) => ipcRenderer.invoke('zones:get', map),
    set: (map: string, zones: unknown) => ipcRenderer.invoke('zones:set', map, zones),
    export: () => ipcRenderer.invoke('zones:export'),
    import: (json: string) => ipcRenderer.invoke('zones:import', json)
  },

  recorder: {
    status: () => ipcRenderer.invoke('recorder:status'),
    list: () => ipcRenderer.invoke('recorder:list'),
    start: (label?: string) => ipcRenderer.invoke('recorder:start', label),
    stop: () => ipcRenderer.invoke('recorder:stop'),
    remove: (name: string) => ipcRenderer.invoke('recorder:delete', name),
    openFolder: () => ipcRenderer.invoke('recorder:open-folder'),
    replay: (name: string, opts?: { speed?: number; simulate?: boolean }) =>
      ipcRenderer.invoke('replay:start', name, opts),
    pause: (paused: boolean) => ipcRenderer.invoke('replay:pause', paused),
    speed: (speed: number) => ipcRenderer.invoke('replay:speed', speed),
    stopReplay: () => ipcRenderer.invoke('replay:stop')
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
