import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildContext } from '../src/index.js'
import { createLogger } from '../src/logger.js'
import { migrate } from '../src/store/schema.js'
import { SqliteStore } from './helpers/sqlite-store.js'

/**
 * Integration test for the `config.gpu` -> `createVramGate` wiring in buildContext.
 *
 * The original bug was a key-name mismatch (`config.gpu` exposed `vramCheck/minFreeVramMb/
 * smiBin/probeTimeoutMs` while `createVramGate` destructured `enabled/minFreeMb/bin/
 * timeoutMs`), so every knob silently fell back to its default and `VIDEO_VRAM_CHECK=false`
 * had no effect. This test drives the real buildContext path with a real gate and a fake
 * face2face client, so it fails if that mapping regresses.
 */

const SILENT = createLogger({ level: 'silent' })

let store
let dataDir
let ctx

beforeEach(async () => {
  store = new SqliteStore()
  await migrate(store, SILENT)
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duix-vram-'))
})

afterEach(() => {
  store.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

function build({ env = {} } = {}) {
  const face2face = {
    submit: vi.fn(async () => ({ code: 10000, msg: 'ok' })),
    query: vi.fn(async () => ({ code: 10000, data: { status: 1, progress: 0 } }))
  }
  ctx = buildContext({
    store,
    logger: SILENT,
    face2faceClient: face2face,
    env: {
      DATA_DIR: dataDir,
      WORKER_ENABLED: 'true',
      AUTH_USERNAME: 'admin',
      AUTH_PASSWORD: 'pw',
      ...env
    }
  })
  return face2face
}

async function seedWaitingTask() {
  const modelId = await ctx.daos.model.insert({
    name: 'm',
    videoPath: 'temp/m.mp4',
    audioPath: 'temp/a.wav',
    voiceId: null
  })
  return ctx.daos.video.insert({
    model_id: modelId,
    name: 'v',
    status: 'waiting',
    text_content: 'hi',
    audio_path: 'temp/a.wav'
  })
}

describe('buildContext VRAM gate wiring', () => {
  it('honours VIDEO_VRAM_CHECK=false and submits (escape hatch is wired)', async () => {
    const face2face = build({ env: { VIDEO_VRAM_CHECK: 'false' } })
    const videoId = await seedWaitingTask()

    await ctx.worker.runOnce()

    // With the gate disabled the task must reach face2face. A broken mapping would leave
    // `enabled` at its default (true), run the missing nvidia-smi probe, fail closed and
    // never submit.
    expect(face2face.submit).toHaveBeenCalledTimes(1)
    const submitted = await ctx.daos.video.selectByID(videoId)
    expect(submitted.status).toBe('pending')
  })
})
