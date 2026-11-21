import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createVideoDao } from '../src/dao/index.js'
import { createVideoWorker } from '../src/services/worker.js'
import { migrate } from '../src/store/schema.js'
import { SqliteStore } from './helpers/sqlite-store.js'

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

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

async function setStartedAt(id, ms) {
  await store.execute('UPDATE video SET started_at = ? WHERE id = ?', [ms, id])
}

/** Fake videoService that records calls and can pause/complete `synthesize`. */
function fakeService({ synthesize, poll } = {}) {
  const calls = { synthesize: [], poll: [] }
  return {
    calls,
    async synthesize(video) {
      calls.synthesize.push(video.id)
      if (synthesize) await synthesize(video)
    },
    async poll(video) {
      calls.poll.push(video.id)
      if (poll) await poll(video)
    }
  }
}

/** synthesize that just parks the task into `pending` (what a real submit does). */
async function parkPending(video) {
  await dao.update(video.id, { status: 'pending', code: `code-${video.id}` })
}

describe('worker admission control', () => {
  it('does not re-submit a task whose synthesize outlives the lease', async () => {
    const id = await insertVideo('waiting')
    const service = fakeService({
      synthesize: async (video) => {
        await sleep(200) // TTS + submit takes longer than the 50ms lease
        await parkPending(video)
      }
    })
    const worker = createVideoWorker({
      videoDao: dao,
      videoService: service,
      leaseMs: 50,
      log: SILENT
    })

    const first = worker.runOnce()
    await sleep(120) // lease (50ms) has now expired while the task is `submitting`
    const second = worker.runOnce() // a later tick must not re-claim it
    await Promise.all([first, second])

    expect(service.calls.synthesize).toEqual([id]) // submitted exactly once
    expect((await dao.selectByID(id)).status).toBe('pending')
  })

  it('holds the queue at the inflight cap and drains once it drops', async () => {
    const inflightId = await insertVideo('submitting') // already on the card
    const queuedId = await insertVideo('waiting')
    const service = fakeService({ synthesize: parkPending })
    const worker = createVideoWorker({
      videoDao: dao,
      videoService: service,
      maxInflight: 1,
      log: SILENT
    })

    await worker.runOnce() // cap reached: must not submit
    expect(service.calls.synthesize).toEqual([])
    expect((await dao.selectByID(queuedId)).status).toBe('waiting') // not lost, not failed

    await dao.update(inflightId, { status: 'success' }) // card frees up
    await worker.runOnce()
    expect(service.calls.synthesize).toEqual([queuedId])
    expect((await dao.selectByID(queuedId)).status).toBe('pending')
  })

  it('fails a stuck pending task at its timeout and keeps draining the queue', async () => {
    const stuckId = await insertVideo('pending', { code: 'stuck' })
    await setStartedAt(stuckId, Date.now() - 2000)
    const queuedId = await insertVideo('waiting')
    const service = fakeService({ synthesize: parkPending })
    const worker = createVideoWorker({
      videoDao: dao,
      videoService: service,
      taskTimeoutMs: 100,
      log: SILENT
    })

    await worker.runOnce()

    const stuck = await dao.selectByID(stuckId)
    expect(stuck.status).toBe('failed')
    expect(stuck.message).toMatch(/超时/)
    expect(stuck.claimed_by).toBeNull()
    // The queue behind it is processed in the same tick.
    expect(service.calls.synthesize).toEqual([queuedId])
    expect((await dao.selectByID(queuedId)).status).toBe('pending')
  })

  it('recovers a stuck submitting record by failing it without a second submit', async () => {
    const id = await insertVideo('submitting')
    await setStartedAt(id, Date.now() - 5000)
    await store.execute('UPDATE video SET claimed_by = ?, claimed_at = ? WHERE id = ?', ['dead-worker', Date.now() - 5000, id])

    const service = fakeService()
    const worker = createVideoWorker({
      videoDao: dao,
      videoService: service,
      taskTimeoutMs: 100,
      log: SILENT
    })

    await worker.runOnce()

    const row = await dao.selectByID(id)
    expect(row.status).toBe('failed') // judged failed, not re-claimed
    expect(row.claimed_by).toBeNull()
    expect(service.calls.synthesize).toEqual([]) // no second submit
  })

  it('leaves a still-in-window submitting task alone even when its lease expired', async () => {
    const id = await insertVideo('submitting')
    await setStartedAt(id, Date.now()) // just started, still within the timeout window
    await store.execute('UPDATE video SET claimed_by = ?, claimed_at = ? WHERE id = ?', ['dead-worker', Date.now() - 100000, id])

    const service = fakeService()
    const worker = createVideoWorker({
      videoDao: dao,
      videoService: service,
      taskTimeoutMs: 60 * 60 * 1000,
      log: SILENT
    })

    await worker.runOnce()

    const row = await dao.selectByID(id)
    expect(row.status).toBe('submitting') // untouched: the worker may still be alive
    expect(service.calls.synthesize).toEqual([])
  })

  it('refuses to submit when the GPU memory gate fails closed', async () => {
    const id = await insertVideo('waiting')
    const service = fakeService({ synthesize: parkPending })
    const worker = createVideoWorker({
      videoDao: dao,
      videoService: service,
      gpuGate: { canSubmit: async () => ({ ok: false, reason: 'GPU 显存不足，等待' }) },
      log: SILENT
    })

    await worker.runOnce()

    expect(service.calls.synthesize).toEqual([])
    const row = await dao.selectByID(id)
    expect(row.status).toBe('waiting')
    expect(row.message).toBe('GPU 显存不足，等待')
  })

  it('submits when the GPU memory gate passes', async () => {
    const id = await insertVideo('waiting')
    const service = fakeService({ synthesize: parkPending })
    const worker = createVideoWorker({
      videoDao: dao,
      videoService: service,
      gpuGate: { canSubmit: async () => ({ ok: true, reason: null }) },
      log: SILENT
    })

    await worker.runOnce()

    expect(service.calls.synthesize).toEqual([id])
    expect((await dao.selectByID(id)).status).toBe('pending')
  })
})
