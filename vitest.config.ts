import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

// Unit tests for the main-process logic (director, GSI tooling, server middleware).
// Electron and SQLite are replaced with lightweight fakes so tests run in plain Node.
export default defineConfig({
  resolve: {
    alias: {
      electron: resolve(__dirname, 'test/helpers/electron.ts')
    }
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/helpers/setup.ts']
  }
})
