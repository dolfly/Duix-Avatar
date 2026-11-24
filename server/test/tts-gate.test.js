import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildContext } from '../src/index.js'
import { createLogger } from '../src/logger.js'
import { migrate } from '../src/store/schema.js'
import { createTtsGate } from '../src/integrations/tts-gate.js'
import { SqliteStore } from './helpers/sqlite-store.js'

/**
 * TTS concurrency gate (DO-124).
 *
 * The TTS service is a single GPU process that grows from ~1.75 GiB idle to ~3.6 GiB
 * mid-synthesis, so two concurrent syntheses double the card's memory (the DO-118 shape).
 * This gate serialises every TTS call the server makes — audition preview, the video
 * synthesis path, and voice cloning — behind a single slot, with the rest queuing FIFO.
 *
 *   cd server && npx vitest run test/tts-gate.test.js
 */

const SILENT = createLogger({ level: 'silent' })

/** A TTS client stub that tracks concurrency and blocks each call until `release()`d. */
function makeTrackedTts() {
  let active = 0
  let peak = 0
  let calls = 0
  const resolvers = []

  const acquire = () => {
    calls += 1
    active += 1
    peak = Math.max(peak, active)
    return new Promise((resolve) => {
      resolvers.push(() => {
        active -= 1
        resolve()
      })
    })
  }

  return {
    makeAudio: async (param) => {
      await acquire()
      return Buffer.from(param.text || '')
    },
    preprocessAndTran: async () => {
      await acquire()
      return { code: 0 }
    },
    release() {
      const next = resolvers.shift()
      if (next) next()
    },
    get active() {
      return active
    },
    get peak() {
      return peak
    },
    get calls() {
      return calls
    }
  }
}

/** Flush pending microtasks so an async path can advance to its next `await`. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('createTtsGate', () => {
  it('serialises concurrent TTS calls behind a single slot (both succeed)', async () => {
    const raw = makeTrackedTts()
    const gate = createTtsGate({ tts: raw, maxInflight: 1, log: SILENT })

    const first = gate.makeAudio({ text: '第一条' })
    const second = gate.makeAudio({ text: '第二条' })

    // The first call grabs the slot synchronously; the second must queue, not overlap.
    expect(raw.active).toBe(1)
    expect(raw.calls).toBe(1)

    raw.release()
    const a = await first
    // Releasing the first slot lets the queued call acquire it.
    expect(raw.calls).toBe(2)
    expect(raw.active).toBe(1)

    raw.release()
    const b = await second

    expect(raw.peak).toBe(1)
    expect(raw.calls).toBe(2)
    expect(a.toString()).toBe('第一条')
    expect(b.toString()).toBe('第二条')
  })

  it('shares one slot between makeAudio and preprocessAndTran', async () => {
    const raw = makeTrackedTts()
    const gate = createTtsGate({ tts: raw, maxInflight: 1, log: SILENT })

    const synth = gate.makeAudio({ text: '试听' })
    const clone = gate.preprocessAndTran({ reference_audio: 'origin_audio/x.wav', lang: 'zh' })

    expect(raw.active).toBe(1)
    expect(raw.calls).toBe(1)

    raw.release()
    await synth
    expect(raw.calls).toBe(2)

    raw.release()
    await clone

    expect(raw.peak).toBe(1)
    expect(raw.calls).toBe(2)
  })

  it('honours maxInflight > 1 (config-driven width)', async () => {
    const raw = makeTrackedTts()
    const gate = createTtsGate({ tts: raw, maxInflight: 2, log: SILENT })

    const first = gate.makeAudio({ text: '一' })
    const second = gate.makeAudio({ text: '二' })

    expect(raw.active).toBe(2)
    expect(raw.calls).toBe(2)

    raw.release()
    raw.release()
    await Promise.all([first, second])
    expect(raw.peak).toBe(2)
  })
})

describe('buildContext TTS gate wiring', () => {
  let store
  let dataDir
  let ctx

  beforeEach(async () => {
    store = new SqliteStore()
    await migrate(store, SILENT)
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duix-tts-gate-'))
  })

  afterEach(() => {
    store.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  function build(ttsClient, env = {}) {
    ctx = buildContext({
      store,
      logger: SILENT,
      ttsClient,
      face2faceClient: {
        submit: vi.fn(async () => ({ code: 10000, msg: 'ok' })),
        query: vi.fn(async () => ({ code: 10000, data: { status: 1, progress: 0 } }))
      },
      env: {
        DATA_DIR: dataDir,
        WORKER_ENABLED: 'false',
        AUTH_USERNAME: 'admin',
        AUTH_PASSWORD: 'pw',
        ...env
      }
    })
  }

  async function seedVoiceAndVideo() {
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
    // No `audio_path`: the video path must synthesise its own TTS audio via voiceService.
    const videoId = await ctx.daos.video.insert({
      model_id: modelId,
      name: 'v',
      status: 'submitting',
      text_content: '合成这段话',
      audio_path: null,
      voice_id: voiceId
    })
    return { voice: await ctx.daos.voice.selectByID(voiceId), video: await ctx.daos.video.selectByID(videoId) }
  }

  it('shares one TTS slot between the audition and video-synthesis paths', async () => {
    const raw = makeTrackedTts()
    build(raw)
    const { voice, video } = await seedVoiceAndVideo()

    // Two concurrent TTS entry points: the audition path (voiceService.makeAudio) and the
    // video synthesis path (videoService.synthesize -> voiceService.makeAudio).
    const audition = ctx.services.voice.makeAudio({ voice, text: '试听文本' })
    const videoSynthesis = ctx.services.video.synthesize(video)

    // Let the video path advance through its DAO reads until it reaches the TTS gate.
    await flush()

    // The audition holds the single slot; the video path's TTS must not start yet.
    expect(raw.calls).toBe(1)
    expect(raw.active).toBe(1)

    raw.release()
    await audition

    // After the audition ends, the queued video TTS acquires the slot.
    expect(raw.calls).toBe(2)
    expect(raw.active).toBe(1)

    raw.release()
    const result = await videoSynthesis

    expect(raw.peak).toBe(1)
    expect(raw.calls).toBe(2)
    expect(result.status).toBe('pending')
  })
})