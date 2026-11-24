import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildContext } from '../src/index.js'
import { createLogger } from '../src/logger.js'
import { migrate } from '../src/store/schema.js'
import { SqliteStore } from './helpers/sqlite-store.js'

/**
 * `synthesize()` error boundaries (DO-160).
 *
 * The TTS call (`voiceService.makeAudio`) used to sit *outside* the `try` block, so a TTS
 * failure (15-min HTTP timeout, 5xx, socket reset) bubbled straight out of `synthesize`:
 * the `status:'failed'` write never ran and the task stayed in `submitting` — holding the
 * single in-flight slot and blocking the whole queue until the 30-minute total-timeout
 * sweep (the DO-121 shape: D2 stuck in `submitting` behind a 900s Axios timeout).
 *
 * Also pinned here: `10004 任务不存在` from gen-video (its `task_dic` is in memory only, so
 * a container restart — including the DO-160 reaper — removes every code) fails fast with
 * an explicit message instead of waiting out the total timeout as an "unknown status".
 */

const SILENT = createLogger({ level: 'silent' })

let store
let dataDir
let ctx

beforeEach(async () => {
  store = new SqliteStore()
  await migrate(store, SILENT)
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duix-synth-err-'))
})

afterEach(() => {
  store.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

function build({ ttsClient, face2face } = {}) {
  ctx = buildContext({
    store,
    logger: SILENT,
    ttsClient,
    face2faceClient: face2face || {
      submit: vi.fn(async () => ({ code: 10000, msg: 'ok' })),
      query: vi.fn(async () => ({ code: 10000, data: { status: 1, progress: 0 } }))
    },
    env: {
      DATA_DIR: dataDir,
      WORKER_ENABLED: 'false',
      AUTH_USERNAME: 'admin',
      AUTH_PASSWORD: 'pw'
    }
  })
  return ctx
}

/** A `submitting` video with no audio_path, so `synthesize` must run TTS first. */
async function seedVideoNeedingTts() {
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
    audio_path: null,
    voice_id: voiceId
  })
  return ctx.daos.video.selectByID(videoId)
}

describe('videoService.synthesize TTS failures', () => {
  it('marks the task failed (not stuck in submitting) when makeAudio throws', async () => {
    build({
      ttsClient: {
        makeAudio: vi.fn(async () => {
          throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
        })
      }
    })
    const video = await seedVideoNeedingTts()

    const result = await ctx.services.video.synthesize(video)

    expect(result.status).toBe('failed')
    const row = await ctx.daos.video.selectByID(video.id)
    expect(row.status).toBe('failed')
    expect(row.message).toContain('音色合成失败')
    expect(row.message).toContain('socket hang up')
    // The claim is released by the worker's finally; nothing here may leave the row
    // occupying the single in-flight slot.
    expect(row.status).not.toBe('submitting')
  })

  it('reports a TTS timeout explicitly', async () => {
    build({
      ttsClient: {
        makeAudio: vi.fn(async () => {
          throw Object.assign(new Error('timeout of 900000ms exceeded'), { code: 'ECONNABORTED' })
        })
      }
    })
    const video = await seedVideoNeedingTts()

    await ctx.services.video.synthesize(video)

    const row = await ctx.daos.video.selectByID(video.id)
    expect(row.status).toBe('failed')
    expect(row.message).toContain('音色合成超时')
  })

  it('fails the task when the voice disappeared between queueing and synthesis', async () => {
    const ttsClient = { makeAudio: vi.fn(async () => Buffer.from('52494646000000005741564500', 'hex')) }
    build({ ttsClient })
    const video = await seedVideoNeedingTts()
    await store.execute('DELETE FROM voice WHERE id = ?', [video.voice_id])

    const result = await ctx.services.video.synthesize(video)

    expect(result.status).toBe('failed')
    const row = await ctx.daos.video.selectByID(video.id)
    expect(row.status).toBe('failed')
    expect(row.message).toMatch(/音色/)
    expect(ttsClient.makeAudio).not.toHaveBeenCalled()
  })

  it('does not submit anything when TTS failed', async () => {
    const face2face = {
      submit: vi.fn(async () => ({ code: 10000, msg: 'ok' })),
      query: vi.fn(async () => ({ code: 10000, data: { status: 1 } }))
    }
    build({
      ttsClient: {
        makeAudio: vi.fn(async () => {
          throw new Error('TTS 内部错误')
        })
      },
      face2face
    })
    const video = await seedVideoNeedingTts()

    await ctx.services.video.synthesize(video)

    expect(face2face.submit).not.toHaveBeenCalled()
  })
})

describe('videoService.poll unknown gen-video codes', () => {
  it('fails fast on 10004 (task gone after a gen-video restart)', async () => {
    const face2face = {
      submit: vi.fn(async () => ({ code: 10000, msg: 'ok' })),
      query: vi.fn(async () => ({ code: 10004, success: true, msg: '任务不存在' }))
    }
    build({ ttsClient: { makeAudio: vi.fn() }, face2face })
    const videoId = await ctx.daos.video.insert({
      model_id: 1,
      name: 'v',
      status: 'pending',
      code: 'orphan-code',
      text_content: '你好',
      progress: 10
    })
    const video = await ctx.daos.video.selectByID(videoId)

    const result = await ctx.services.video.poll(video)

    expect(result.status).toBe('failed')
    const row = await ctx.daos.video.selectByID(videoId)
    expect(row.status).toBe('failed')
    expect(row.message).toMatch(/已不存在|重启/)
  })

  it('keeps polling on a transient query error (no false failure)', async () => {
    const face2face = {
      submit: vi.fn(),
      query: vi.fn(async () => {
        throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
      })
    }
    build({ ttsClient: { makeAudio: vi.fn() }, face2face })
    const videoId = await ctx.daos.video.insert({
      model_id: 1,
      name: 'v',
      status: 'pending',
      code: 'code-1',
      text_content: '你好',
      progress: 10
    })
    const video = await ctx.daos.video.selectByID(videoId)

    const result = await ctx.services.video.poll(video)

    expect(result.status).toBe('pending')
    expect((await ctx.daos.video.selectByID(videoId)).status).toBe('pending')
  })
})