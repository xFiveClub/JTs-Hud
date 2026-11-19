// Minimal stand-in for the electron module in unit tests
import os from 'os'
import path from 'path'

export const app = {
  getPath: (_name: string): string =>
    process.env.JTS_TEST_USERDATA ?? path.join(os.tmpdir(), 'jts-hud-test'),
  getAppPath: (): string => process.cwd(),
  getVersion: (): string => '0.0.0-test'
}

export const safeStorage = {
  isEncryptionAvailable: (): boolean => true,
  encryptString: (s: string): Buffer => Buffer.from(`enc(${s})`),
  decryptString: (b: Buffer): string => b.toString().replace(/^enc\((.*)\)$/, '$1')
}

export const ipcMain = { handle: (): void => {}, on: (): void => {} }
export const shell = { openPath: async (): Promise<string> => '' }
