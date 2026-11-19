import { vi } from 'vitest'

// In-memory replacement for the SQLite helpers: only the settings table is needed here
vi.mock('../../src/main/server/database/sqlite', () => {
  const settings = new Map<string, string>()
  return {
    db: {},
    dbAll: async (query: string) => {
      const like = /LIKE '([^%']*)%'/.exec(query)?.[1]
      return [...settings.entries()]
        .filter(([k]) => (like === undefined ? true : k.startsWith(like)))
        .map(([key, value]) => ({ key, value }))
    },
    dbGet: async () => undefined,
    dbRun: async (query: string, params: any[] = []) => {
      if (/^INSERT/i.test(query)) settings.set(params[0], params[1])
      else if (/^DELETE/i.test(query)) settings.delete(params[0])
    },
    __settings: settings
  }
})
