import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

describe('GSI recorder / replayer', () => {
  beforeAll(() => {
    process.env.JTS_TEST_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'jts-rec-'))
  })

  it('records payloads and replays them in order with the recorded timing', async () => {
    const rec = await import('../src/main/server/integrations/gsiRecorder')
    const name = rec.gsiRecorder.start('unit test')
    expect(name).toMatch(/_unit_test\.jsonl\.gz$/)

    for (let i = 0; i < 5; i++) {
      rec.gsiRecorder.capture({ i })
      rec.gsiRecorder.capture({ i: 'dropped' }) // within 50 ms of the previous one
      await new Promise((r) => setTimeout(r, 60)) // above the 50 ms rate limit
    }
    rec.gsiRecorder.stop()
    await new Promise((r) => setTimeout(r, 100)) // let gzip flush

    expect(rec.listRecordings().map((r) => r.name)).toContain(name)

    const got: { i: unknown; t: number }[] = []
    rec.gsiReplayer.setSink((payload, virtualNow) => got.push({ i: payload.i, t: virtualNow }))
    await rec.gsiReplayer.start(name, 4)
    expect(rec.gsiReplayer.active).toBe(true)
    await new Promise<void>((resolve) => {
      const off = rec.onRecorderStatus((s) => {
        if (!s.replaying) {
          off()
          resolve()
        }
      })
    })

    expect(got.map((g) => g.i)).toEqual([0, 1, 2, 3, 4])
    // Virtual clock keeps game timing (~60 ms apart) even at 4x playback
    const gaps = got.slice(1).map((g, k) => g.t - got[k].t)
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(50)

    rec.deleteRecording(name)
    expect(rec.listRecordings()).toHaveLength(0)
  })

  it('refuses paths outside the recordings folder', async () => {
    const rec = await import('../src/main/server/integrations/gsiRecorder')
    expect(() => rec.deleteRecording('../../etc/passwd')).toThrow()
    await expect(rec.gsiReplayer.start('../secret.jsonl.gz')).rejects.toThrow('Recording not found')
  })
})
