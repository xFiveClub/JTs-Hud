import { ElectronAPI } from '@electron-toolkit/preload'

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      appToken: string
      openExternal: (url: string) => Promise<void>
      onUpdateAvailable: (callback: (version: string) => void) => void
      director: {
        getConfig: () => Promise<any>
        setConfig: (updates: Record<string, unknown>) => Promise<any>
        setEnabled: (enabled: boolean) => Promise<any>
        getStatus: () => Promise<any>
        testLLM: () => Promise<{ ok: boolean; message: string }>
        setSimulation: (on: boolean) => Promise<any>
        toggleLock: () => Promise<string | null>
        next: () => Promise<void>
        lookaheadCfg: (host?: string) => Promise<string>
      }
      zones: {
        get: (map: string) => Promise<any[]>
        set: (map: string, zones: unknown) => Promise<any[]>
        export: () => Promise<string>
        import: (json: string) => Promise<Record<string, any[]>>
      }
      recorder: {
        status: () => Promise<any>
        list: () => Promise<{ name: string; sizeBytes: number; modifiedAt: number }[]>
        start: (label?: string) => Promise<string>
        stop: () => Promise<void>
        remove: (name: string) => Promise<void>
        openFolder: () => Promise<string>
        replay: (name: string, opts?: { speed?: number; simulate?: boolean }) => Promise<void>
        pause: (paused: boolean) => Promise<void>
        speed: (speed: number) => Promise<void>
        stopReplay: () => Promise<void>
      }
    }
  }
}
