import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createVideoDao } from '../src/dao/index.js'
import { createGenVideoReaper } from '../src/integrations/gen-video-reaper.js'
import { createVideoWorker } from '../src/services/worker.js'
import { migrate } from '../src/store/schema.js'
import { SqliteStore } from './helpers/sqlite-store.js'

/**
 * Orphan cleanup (DO-160).
 *
 * The total-timeout sweep only fails *our* row. The gen-video image is third-party
 * (`guiji2025/*`, `/code/app_local.py`) and exposes no cancel/deadline: `/easy/submit`
 * accepts only audio_url/video_url/code/watermark_switch/digital_auth/chaofen/pn and then
 * starts a bare thread per submit. So a task judged `failed` keeps rendering frames, holds
 * the card and drags every later task past its own timeout — the DO-118 self-reinforcing
 * loop (DO-121 measured 900+ frames rendered after `failed`, TTS 10.8 -> 0.28 tokens/s).
 *
 * These tests pin the server-side contract: the abandoned codes reach the reaper, the
 * reaper is the only thing that can terminate the container-side work, and the queue keeps
 * draining (the next task is neither blocked nor slowed by the abandoned one).
 */

const SILENT = { debug() {}, info() {}, warn() {}, error() {} }

let store
let dao

beforeEach(async () => {
  store = new SqliteStore()
  await migrate(store, SILENT)
  dao = createVideoDao(store)
})

afterEach(() => {
  store.close()
})

async function insertVideo(status, overrides = {}) {
  return dao.insert({
    model_id: 1,
    name: '作品',
    status,
    text_content: '你好',
    voice_id: 1,
    audio_path: 'temp/a.wav',
    progress: 0,
    ...overrides
  })
}

/** Fake videoService that records calls and parks the task into `pending` like a real submit. */
function fakeService() {
  const calls = { synthesize: [], poll: [] }
  return {
    calls,
    async synthesize(video) {
      calls.synthesize.push(video.id)
      await dao.update(video.id, { status: 'pending', code: `code-${video.id}` })
    },
    async poll(video) {
      calls.poll.push(video.id)
    }
  }
}

function fakeReaper({ reaped = true } = {}) {
  const calls = []
  return {
    calls,
    mode: 'docker',
    async reap(codes) {
      calls.push(codes)
      return { reaped, reason: reaped ? 'restarted' : 'restart-failed' }
    }
  }
}

describe('createGenVideoReaper', () => {
  it('is log-only in the default mode and never touches the host', async () => {
    const exec = vi.fn()
    const reaper = createGenVideoReaper({ mode: 'none', exec, log: SILENT })

    const result = await reaper.reap(['code-a'])

    expect(result).toEqual({ reaped: false, reason: 'mode-none' })
    expect(exec).not.toHaveBeenCalled()
  })

  it('degrades an unknown mode to none', () => {
    expect(createGenVideoReaper({ mode: 'reboot-the-host' }).mode).toBe('none')
    expect(createGenVideoReaper({ mode: 'DOCKER' }).mode).toBe('docker')
  })

  it('restarts the gen-video container in docker mode', async () => {
    const exec = vi.fn((bin, args, options, done) => done(null, '', ''))
    const reaper = createGenVideoReaper({ mode: 'docker', container: 'duix-gen-video', exec, log: SILENT })

    const result = await reaper.reap(['code-a', 'code-b'])

    expect(result).toEqual({ reaped: true, reason: 'restarted' })
    expect(exec).toHaveBeenCalledTimes(1)
    expect(exec.mock.calls[0][0]).toBe('docker')
    expect(exec.mock.calls[0][1]).toEqual(['restart', 'duix-gen-video'])
  })

  it('throttles repeated attempts so a failing restart cannot storm', async () => {
    const exec = vi.fn((bin, args, options, done) => done(new Error('Cannot connect to the Docker daemon')))
    let clock = 100000
    const reaper = createGenVideoReaper({
      mode: 'docker',
      exec,
      minIntervalMs: 1000,
      now: () => clock,
      log: SILENT
    })

    const first = await reaper.reap(['code-a'])
    clock += 10 // well inside the throttle window
    const second = await reaper.reap(['code-b'])

    expect(first).toEqual({ reaped: false, reason: 'restart-failed' })
    expect(second).toEqual({ reaped: false, reason: 'throttled' })
    expect(exec).toHaveBeenCalledTimes(1) // the failure was not retried on the next tick
  })

  it('ignores an empty code list', async () => {
    const exec = vi.fn()
    const reaper = createGenVideoReaper({ mode: 'docker', exec, log: SILENT })

    expect(await reaper.reap([])).toEqual({ reaped: false, reason: 'empty' })
    expect(await reaper.reap(['', null])).toEqual({ reaped: false, reason: 'empty' })
    expect(exec).not.toHaveBeenCalled()
  })
})

describe('worker orphan cleanup', () => {
  it('reaps the abandoned gen-video code and keeps draining the queue', async () => {
    const orphanId = await insertVideo('pending', { code: 'orphan-code' })
    await store.execute('UPDATE video SET started_at = 0 WHERE id = ?', [orphanId])
    const queuedId = await insertVideo('waiting')

    const service = fakeService()
    const reaper = fakeReaper()
    const worker = createVideoWorker({
      videoDao: dao,
      videoService: service,
      reaper,
      reapCooldownMs: 0,
      taskTimeoutMs: 100,
      now: () => 1000,
      log: SILENT
    })

    await worker.runOnce()

    // The abandoned task is failed and its container-side thread is terminated ...
    const orphan = await dao.selectByID(orphanId)
    expect(orphan.status).toBe('failed')
    expect(orphan.claimed_by).toBeNull()
    expect(reaper.calls).toEqual([['orphan-code']])
    // ... and the next task is submitted in the same tick, not slowed by the orphan.
    expect(service.calls.synthesize).toEqual([queuedId])
    expect((await dao.selectByID(queuedId)).status).toBe('pending')
  })

  it('does not reap a task that was still in TTS (no code, no GPU work)', async () => {
    const ttsOnlyId = await insertVideo('submitting', { code: null })
    await store.execute('UPDATE video SET started_at = 0 WHERE id = ?', [ttsOnlyId])

    const reaper = fakeReaper()
    const worker = createVideoWorker({
      videoDao: dao,
      videoService: fakeService(),
      reaper,
      taskTimeoutMs: 100,
      now: () => 1000,
      log: SILENT
    })

    await worker.runOnce()

    expect((await dao.selectByID(ttsOnlyId)).status).toBe('failed')
    expect(reaper.calls).toEqual([]) // nothing to terminate inside the container
  })

  it('keeps draining when the reaper throws', async () => {
    const orphanId = await insertVideo('pending', { code: 'orphan-code' })
    await store.execute('UPDATE video SET started_at = 0 WHERE id = ?', [orphanId])
    const queuedId = await insertVideo('waiting')

    const service = fakeService()
    const worker = createVideoWorker({
      videoDao: dao,
      videoService: service,
      reaper: {
        async reap() {
          throw new Error('docker daemon gone')
        }
      },
      reapCooldownMs: 0,
      taskTimeoutMs: 100,
      now: () => 1000,
      log: SILENT
    })

    await worker.runOnce()

    expect((await dao.selectByID(orphanId)).status).toBe('failed')
    expect(service.calls.synthesize).toEqual([queuedId])
    expect((await dao.selectByID(queuedId)).status).toBe('pending')
  })

  it('holds the queue during the post-reap cooldown, then submits', async () => {
    const orphanId = await insertVideo('pending', { code: 'orphan-code' })
    await store.execute('UPDATE video SET started_at = 0 WHERE id = ?', [orphanId])
    const queuedId = await insertVideo('waiting')

    const service = fakeService()
    let clock = 1000
    const worker = createVideoWorker({
      videoDao: dao,
      videoService: service,
      reaper: fakeReaper(),
      reapCooldownMs: 5000,
      taskTimeoutMs: 100,
      now: () => clock,
      log: SILENT
    })

    await worker.runOnce() // reaps, enters cooldown
    expect(service.calls.synthesize).toEqual([]) // gen-video is restarting: don't submit
    expect((await dao.selectByID(queuedId)).status).toBe('waiting') // not lost, not failed

    clock += 2000
    await worker.runOnce() // still cooling down
    expect(service.calls.synthesize).toEqual([])

    clock += 4000 // cooldown (5000ms) has elapsed
    await worker.runOnce()
    expect(service.calls.synthesize).toEqual([queuedId])
    expect((await dao.selectByID(queuedId)).status).toBe('pending')
  })

  it('does not reap when no task timed out', async () => {
    const queuedId = await insertVideo('waiting')
    const reaper = fakeReaper()
    const worker = createVideoWorker({
      videoDao: dao,
      videoService: fakeService(),
      reaper,
      taskTimeoutMs: 100,
      now: () => 1000,
      log: SILENT
    })

    await worker.runOnce()

    expect(reaper.calls).toEqual([])
    expect((await dao.selectByID(queuedId)).status).toBe('pending')
  })
})