import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createVideoDao } from '../src/dao/index.js'
import { buildContext } from '../src/index.js'
import { createLogger } from '../src/logger.js'
import { createVideoService } from '../src/services/index.js'
import { createVideoWorker } from '../src/services/worker.js'
import { migrate } from '../src/store/schema.js'
import { SqliteStore } from './helpers/sqlite-store.js'

/**
 * Dynamic per-task timeout window (DO-161).
 *
 * DO-121 measured inference time growing with the *audio* length (5.8s -> ~2 min,
 * 36.04s -> >60 min on the throttled P4000), so the fixed `VIDEO_TASK_TIMEOUT_MS` killed
 * every normal task above ~30s of audio. The window is now base + perSecond*audioSeconds,
 * capped at an absolute maximum, persisted as `video.deadline_at` once the audio is known.
 *
 * Pinned here:
 *  - a 36s task is NOT failed once the base window has elapsed (its deadline is later)
 *  - a task past its (dynamic) deadline IS failed, released and handed to the reaper
 *  - an unknown / unreadable audio length falls back to the base window, and never crashes
 *  - the absolute cap bounds the window even for a very long audio
 */

const SILENT = createLogger({ level: 'silent' })
const BASE_MS = 30 * 60 * 1000
const PER_SECOND_MS = 180000
const MAX_MS = 12 * 60 * 60 * 1000

let store
let dataDir
let ctx
let ttsStub
let face2faceStub

beforeEach(async () => {
  store = new SqliteStore()
  await migrate(store, SILENT)
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duix-task-deadline-'))
})

afterEach(() => {
  store.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

/** Minimal PCM WAV of `seconds` (8 kHz, 16-bit mono) — what the TTS service returns. */
function buildWav(seconds, { sampleRate = 8000, bits = 16, channels = 1 } = {}) {
  const byteRate = sampleRate * channels * (bits / 8)
  const dataSize = Math.round(seconds * byteRate)
  const fmt = Buffer.alloc(24)
  fmt.write('fmt ', 0, 'latin1')
  fmt.writeUInt32LE(16, 4)
  fmt.writeUInt16LE(1, 8)
  fmt.writeUInt16LE(channels, 10)
  fmt.writeUInt32LE(sampleRate, 12)
  fmt.writeUInt32LE(byteRate, 16)
  fmt.writeUInt16LE((channels * bits) / 8, 20)
  fmt.writeUInt16LE(bits, 22)

  const data = Buffer.alloc(8)
  data.write('data', 0, 'latin1')
  data.writeUInt32LE(dataSize, 4)

  const riff = Buffer.alloc(12)
  riff.write('RIFF', 0, 'latin1')
  riff.writeUInt32LE(4 + fmt.length + data.length + dataSize, 4)
  riff.write('WAVE', 8, 'latin1')

  return Buffer.concat([riff, fmt, data, Buffer.alloc(dataSize)])
}

function build({ makeAudio, env = {} } = {}) {
  ttsStub = {
    makeAudio: vi.fn(async () => makeAudio()),
    preprocessAndTran: vi.fn(async () => ({ code: 0 }))
  }
  face2faceStub = {
    submit: vi.fn(async () => ({ code: 10000, msg: 'ok' })),
    query: vi.fn(async () => ({ code: 10000, data: { status: 1, progress: 0 } }))
  }
  ctx = buildContext({
    store,
    logger: SILENT,
    ttsClient: ttsStub,
    face2faceClient: face2faceStub,
    env: {
      DATA_DIR: dataDir,
      WORKER_ENABLED: 'false',
      // Deterministic on hosts without a GPU: the VRAM gate is fail-closed, so leaving it on
      // would requeue every submit on a CI runner (and make the window assertions depend on
      // the host having nvidia-smi). The gate itself is covered by test/vram-wiring.test.js.
      VIDEO_VRAM_CHECK: 'false',
      AUTH_USERNAME: 'admin',
      AUTH_PASSWORD: 'pw',
      ...env
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
  await store.execute('UPDATE video SET started_at = ? WHERE id = ?', [Date.now(), videoId])
  return ctx.daos.video.selectByID(videoId)
}

/** A `submitting` video whose audio already exists on disk (no TTS needed). */
async function seedVideoWithAudio(relative = 'temp/uploaded.wav') {
  const modelId = await ctx.daos.model.insert({
    name: 'm',
    videoPath: 'temp/m.mp4',
    audioPath: relative,
    voiceId: null
  })
  const videoId = await ctx.daos.video.insert({
    model_id: modelId,
    name: 'v',
    status: 'submitting',
    text_content: '合成这段话',
    audio_path: relative,
    voice_id: null
  })
  await store.execute('UPDATE video SET started_at = ? WHERE id = ?', [Date.now(), videoId])
  return ctx.daos.video.selectByID(videoId)
}

function fakeService() {
  return { calls: { synthesize: [], poll: [] }, async synthesize() {}, async poll() {} }
}

function makeWorker({ reaper, taskTimeoutMs = BASE_MS } = {}) {
  const dao = createVideoDao(store)
  return createVideoWorker({
    videoDao: dao,
    videoService: fakeService(),
    taskTimeoutMs,
    taskTimeoutPerSecondMs: PER_SECOND_MS,
    taskTimeoutMaxMs: MAX_MS,
    reaper,
    log: SILENT
  })
}

/**
 * Age a task by `ms` without breaking the started_at -> deadline_at relationship, i.e.
 * "this task was first claimed `ms` ago and its window was computed then".
 */
async function ageTask(id, ms) {
  await store.execute('UPDATE video SET started_at = started_at - ?, deadline_at = deadline_at - ? WHERE id = ?', [
    ms,
    ms,
    id
  ])
}

async function setDeadline(id, ms) {
  await store.execute('UPDATE video SET deadline_at = ? WHERE id = ?', [ms, id])
}

describe('synthesize persists a dynamic deadline', () => {
  it('gives a 36s audio a window well beyond the 30-minute base', async () => {
    build({ makeAudio: () => buildWav(36.04) })
    const video = await seedVideoNeedingTts()

    const result = await ctx.services.video.synthesize(video)

    expect(result.status).toBe('pending')
    const row = await ctx.daos.video.selectByID(video.id)
    expect(row.status).toBe('pending')
    expect(row.started_at).toBeTypeOf('number')
    // base + 36.04 * 180s, anchored at started_at (DO-121: this task needed >60 min).
    expect(row.deadline_at).toBeCloseTo(row.started_at + BASE_MS + Math.ceil(36.04 * PER_SECOND_MS), -2)
    expect(row.deadline_at).toBeGreaterThan(row.started_at + BASE_MS)
  })

  it('keeps a short audio on the (short) base + small dynamic window', async () => {
    build({ makeAudio: () => buildWav(5.8) })
    const video = await seedVideoNeedingTts()

    await ctx.services.video.synthesize(video)

    const row = await ctx.daos.video.selectByID(video.id)
    expect(row.deadline_at).toBeCloseTo(row.started_at + BASE_MS + Math.ceil(5.8 * PER_SECOND_MS), -2)
  })

  it('falls back to the base window when the audio is not a readable wav', async () => {
    build({ makeAudio: () => Buffer.from('not a wav at all') })
    const video = await seedVideoNeedingTts()

    const result = await ctx.services.video.synthesize(video)

    // Still submitted: an unreadable header must not block the task, only shorten its window
    // to the base window (deadline_at == started_at + VIDEO_TASK_TIMEOUT_MS).
    expect(result.status).toBe('pending')
    const row = await ctx.daos.video.selectByID(video.id)
    expect(row.status).toBe('pending')
    expect(row.deadline_at).toBe(row.started_at + BASE_MS)
  })

  it('falls back to the base window when the audio file is missing', async () => {
    build({ makeAudio: () => buildWav(1) })
    const video = await seedVideoWithAudio('temp/does-not-exist.wav')

    const result = await ctx.services.video.synthesize(video)

    expect(result.status).toBe('pending')
    expect((await ctx.daos.video.selectByID(video.id)).deadline_at).toBe(
      (await ctx.daos.video.selectByID(video.id)).started_at + BASE_MS
    )
  })

  it('caps the window at VIDEO_TASK_TIMEOUT_MAX_MS for a very long audio', async () => {
    build({ makeAudio: () => buildWav(600, { bits: 8 }), env: { VIDEO_TASK_TIMEOUT_MAX_MS: '5000' } })
    const video = await seedVideoNeedingTts()

    await ctx.services.video.synthesize(video)

    const row = await ctx.daos.video.selectByID(video.id)
    expect(row.deadline_at).toBe(row.started_at + 5000)
  })

  it('does not submit when the deadline write loses the race with the sweep', async () => {
    build({ makeAudio: () => buildWav(36) })
    const video = await seedVideoNeedingTts()
    // The sweep fails the row between the status re-check and the deadline write.
    const videoDao = { ...ctx.daos.video, setDeadline: vi.fn(async () => false) }
    const service = createVideoService({
      videoDao,
      modelDao: ctx.daos.model,
      voiceService: ctx.services.voice,
      media: ctx.media,
      tts: ttsStub,
      face2face: face2faceStub,
      log: SILENT,
      taskTimeout: { baseMs: BASE_MS, perSecondMs: PER_SECOND_MS, maxMs: MAX_MS }
    })

    const result = await service.synthesize(video)

    expect(result.status).toBe('failed')
    expect(videoDao.setDeadline).toHaveBeenCalled()
    expect(face2faceStub.submit).not.toHaveBeenCalled()
    // The row is left for the sweep (which already failed it), never revived as `pending`.
    expect((await ctx.daos.video.selectByID(video.id)).status).toBe('submitting')
  })
})

describe('worker sweep honours the per-task deadline', () => {
  it('does not fail a 36s task whose base window elapsed but whose deadline is still ahead', async () => {
    build({ makeAudio: () => buildWav(36) })
    const video = await seedVideoNeedingTts()
    await ctx.services.video.synthesize(video)

    // 31 minutes after the first claim: past VIDEO_TASK_TIMEOUT_MS, inside the dynamic window.
    await ageTask(video.id, BASE_MS + 60_000)
    const before = await ctx.daos.video.selectByID(video.id)
    expect(before.deadline_at).toBeGreaterThan(Date.now())

    await makeWorker().runOnce()

    const row = await ctx.daos.video.selectByID(video.id)
    expect(row.status).toBe('pending') // not misjudged as failed
    expect(row.claimed_by).toBeNull() // released after polling
  })

  it('fails and releases a task past its dynamic deadline, and hands its code to the reaper', async () => {
    build({ makeAudio: () => buildWav(36) })
    const video = await seedVideoNeedingTts()
    await ctx.services.video.synthesize(video)
    const row = await ctx.daos.video.selectByID(video.id)

    await setDeadline(video.id, Date.now() - 1000)
    const reaper = { reap: vi.fn(async () => ({ reaped: true })) }

    await makeWorker({ reaper }).runOnce()

    const after = await ctx.daos.video.selectByID(video.id)
    expect(after.status).toBe('failed')
    expect(after.message).toMatch(/超时/)
    expect(after.claimed_by).toBeNull()
    expect(reaper.reap).toHaveBeenCalledWith([row.code])
  })

  it('still fails a task with no readable audio once the base window elapsed', async () => {
    build({ makeAudio: () => Buffer.from('not a wav at all') })
    const video = await seedVideoNeedingTts()
    await ctx.services.video.synthesize(video)
    expect((await ctx.daos.video.selectByID(video.id)).deadline_at).toBe(
      (await ctx.daos.video.selectByID(video.id)).started_at + BASE_MS
    )

    await ageTask(video.id, BASE_MS + 60_000)

    await makeWorker().runOnce()

    const row = await ctx.daos.video.selectByID(video.id)
    expect(row.status).toBe('failed')
    expect(row.message).toMatch(/超时/)
  })

  it('leaves a task inside its base window alone', async () => {
    build({ makeAudio: () => Buffer.from('not a wav at all') })
    const video = await seedVideoNeedingTts()
    await ctx.services.video.synthesize(video)
    await makeWorker().runOnce()

    expect((await ctx.daos.video.selectByID(video.id)).status).toBe('pending')
  })
})

describe('video dao deadline bookkeeping', () => {
  it('clears deadline_at on a fresh claim and refuses a late deadline write', async () => {
    const dao = createVideoDao(store)
    const id = await dao.insert({ model_id: 1, name: 'v', status: 'waiting', progress: 0 })
    await dao.claimWaiting(id, { claimedBy: 'w1', maxInflight: 1, now: Date.now() })
    expect(await dao.setDeadline(id, Date.now() + 60_000)).toBe(true)
    expect((await dao.selectByID(id)).deadline_at).toBeTypeOf('number')

    // Re-queued and claimed again: the stale deadline must not survive the new claim.
    await dao.updateStatus(id, 'waiting', '')
    await dao.claimWaiting(id, { claimedBy: 'w2', maxInflight: 1, now: Date.now() })
    expect((await dao.selectByID(id)).deadline_at).toBeNull()

    // A task that is no longer `submitting` cannot be revived by a late write.
    await dao.updateStatus(id, 'failed', '合成超时，已释放')
    expect(await dao.setDeadline(id, Date.now() + 60_000)).toBe(false)
  })
})