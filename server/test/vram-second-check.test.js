import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildContext } from '../src/index.js'
import { createLogger } from '../src/logger.js'
import { migrate } from '../src/store/schema.js'
import { SqliteStore } from './helpers/sqlite-store.js'

/**
 * Video-side VRAM admission re-check (DO-146).
 *
 * DO-120's gate ran once, before TTS; `face2face.submit` happened after the minutes-long
 * TTS with no re-check, so a task whose own TTS (or a concurrent orphan) changed the card's
 * headroom was launched onto an already-pressured card. The fix adds a second gate check
 * right before submit, reusing the same increment-budget `canSubmit` verdict as the
 * pre-TTS check. When it fails, the task is put back to `waiting` (never submitted) and the
 * worker re-admits it on a later tick.
 */

const SILENT = createLogger({ level: 'silent' })

const WAIT_REASON = 'GPU 显存不足（本次推理需 1500MB 增量预算，可用 500MB），等待'

let store
let dataDir
let ctx

beforeEach(async () => {
  store = new SqliteStore()
  await migrate(store, SILENT)
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duix-vram2-'))
})

afterEach(() => {
  store.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

/** Fake TTS client that returns a minimal wav so the video path can synthesise its own audio. */
function makeTtsClient() {
  return { makeAudio: vi.fn(async () => Buffer.from('52494646000000005741564500', 'hex')) }
}

function build({ vramGate, ttsClient, workerEnabled = 'false' } = {}) {
  const face2face = {
    submit: vi.fn(async () => ({ code: 10000, msg: 'ok' })),
    query: vi.fn(async () => ({ code: 10000, data: { status: 1, progress: 0 } }))
  }
  ctx = buildContext({
    store,
    logger: SILENT,
    face2faceClient: face2face,
    vramGate,
    ttsClient,
    env: {
      DATA_DIR: dataDir,
      WORKER_ENABLED: workerEnabled,
      AUTH_USERNAME: 'admin',
      AUTH_PASSWORD: 'pw'
    }
  })
  return face2face
}

async function seedVoiceAndVideo({ audioPath }) {
  const modelId = await ctx.daos.model.insert({
    name: 'm',
    videoPath: 'temp/m.mp4',
    audioPath: 'temp/a.wav',
    voiceId: null
  })
  const voiceId = await ctx.daos.voice.insert({
    originAudioPath: 'origin_audio/x.wav',
    lang: 'zh',
    asrFormatAudioUrl: 'origin_audio/x.wav',
    referenceAudioText: '你好'
  })
  const videoId = await ctx.daos.video.insert({
    model_id: modelId,
    name: 'v',
    status: 'submitting',
    text_content: '合成这段话',
    audio_path: audioPath,
    voice_id: voiceId
  })
  return { video: await ctx.daos.video.selectByID(videoId) }
}

describe('videoService.synthesize second admission check', () => {
  it('re-queues instead of submitting when the post-TTS check fails (缺陷 2)', async () => {
    const vramGate = { canSubmit: vi.fn(async () => ({ ok: false, reason: WAIT_REASON })) }
    const face2face = build({ vramGate, ttsClient: makeTtsClient() })
    // No audio_path: synthesize must run TTS first, then hit the second (post-TTS) check.
    const { video } = await seedVoiceAndVideo({ audioPath: null })

    const result = await ctx.services.video.synthesize(video)

    expect(result.status).toBe('requeued')
    expect(face2face.submit).not.toHaveBeenCalled()
    const row = await ctx.daos.video.selectByID(video.id)
    expect(row.status).toBe('waiting')
    expect(row.message).toBe(WAIT_REASON)
  })

  it('submits normally when the post-TTS check passes', async () => {
    const face2face = build({
      ttsClient: makeTtsClient(),
      vramGate: { canSubmit: vi.fn(async () => ({ ok: true, reason: null })) }
    })
    const { video } = await seedVoiceAndVideo({ audioPath: null })

    const result = await ctx.services.video.synthesize(video)

    expect(result.status).toBe('pending')
    expect(face2face.submit).toHaveBeenCalledTimes(1)
    expect((await ctx.daos.video.selectByID(video.id)).status).toBe('pending')
  })
})

describe('worker first-check -> synthesize second-check race', () => {
  it('does not submit when headroom drops between the two checks', async () => {
    let calls = 0
    const vramGate = {
      canSubmit: vi.fn(async () => {
        calls += 1
        // First check (pre-TTS) passes; the card fills up (orphan/concurrent work) before
        // the second check, which then refuses.
        return calls === 1 ? { ok: true, reason: null } : { ok: false, reason: WAIT_REASON }
      })
    }
    const face2face = build({ vramGate, workerEnabled: 'true' })

    // audio_path pre-set so synthesize skips TTS and reaches the second check directly.
    const { video } = await seedVoiceAndVideo({ audioPath: 'temp/a.wav' })
    await ctx.daos.video.update(video.id, { status: 'waiting' })

    await ctx.worker.runOnce()

    expect(face2face.submit).not.toHaveBeenCalled()
    const row = await ctx.daos.video.selectByID(video.id)
    expect(row.status).toBe('waiting')
    expect(row.message).toBe(WAIT_REASON)
    expect(calls).toBe(2) // pre-TTS admission + post-TTS re-check both ran
  })
})