/**
 * 「失败后队列能继续」：一条试听挂在 TTS 上超时失败后，它的 claim 必须释放，
 * 下一条等待中的试听仍能被 worker 取到（不被前面的失败堵死）。
 *
 *   cd server && npx vitest run test/audition-queue-continuity.test.js
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it } from 'vitest'
import request from 'supertest'

import { buildContext } from '../src/index.js'
import { createLogger } from '../src/logger.js'
import { migrate } from '../src/store/schema.js'
import { createAuditionWorker } from '../src/services/worker.js'
import { SqliteStore } from './helpers/sqlite-store.js'

const SILENT = createLogger({ level: 'silent' })

function startStubServer(handler) {
  const server = http.createServer(handler)
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` })
    })
  })
}

const AUTH = { username: 'admin', password: 's3cret' }
let dataDir, store, tts, ctx, authToken

function writeTemp(name) {
  const p = path.join(os.tmpdir(), `duix-q-${name}`)
  fs.writeFileSync(p, 'x')
  return p
}

beforeAll(async () => {
  // /v1/invoke 永不响应 => 第一条试听只能靠超时结束。
  tts = await startStubServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      if (req.url === '/v1/preprocess_and_tran') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ code: 0, asr_format_audio_url: 'origin_audio/ref.wav', reference_audio_text: '你好' }))
      }
      // /v1/invoke: never respond
    })
  })
})

afterAll(async () => {
  await new Promise((resolve) => tts.server.close(resolve))
})

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duix-q-'))
  store = new SqliteStore()
  ctx = buildContext({
    store,
    logger: SILENT,
    env: {
      DATA_DIR: dataDir,
      TTS_BASE_URL: tts.baseUrl,
      WORKER_ENABLED: 'false',
      AUDITION_TIMEOUT_MS: '200',
      AUTH_USERNAME: AUTH.username,
      AUTH_PASSWORD: AUTH.password
    }
  })
  await migrate(store, SILENT)
  const login = await request(ctx.app).post('/api/auth/login').send(AUTH)
  authToken = login.body.token
})

afterEach(() => {
  store.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

const authed = {
  get: (url) => request(ctx.app).get(url).set('Authorization', `Bearer ${authToken}`),
  post: (url) => request(ctx.app).post(url).set('Authorization', `Bearer ${authToken}`)
}

describe('voice API', () => {
  it('lets the queue continue after a failed audition', async () => {
    const taskId = await ctx.services.model.enqueue({
      name: 'q',
      videoFile: { path: writeTemp('a.mp4'), originalname: 'a.mp4' },
      audioFile: { path: writeTemp('a.wav'), originalname: 'a.wav' }
    })
    await ctx.services.model.process(await ctx.daos.modelTask.selectByID(taskId))
    const voice = await store.queryOne('SELECT * FROM voice ORDER BY id DESC LIMIT 1')

    // 两条试听先后入队。
    const first = await authed.post(`/api/voices/${voice.id}/audition`).send({ text: '第一条' })
    const second = await authed.post(`/api/voices/${voice.id}/audition`).send({ text: '第二条' })
    expect(first.status).toBe(202)
    expect(second.status).toBe(202)

    const worker = createAuditionWorker({
      auditionDao: ctx.daos.audition,
      auditionService: ctx.services.audition,
      log: SILENT,
      leaseMs: 60000
    })

    // 第一次 tick：第一条挂在 TTS 上 -> 超时 -> 失败。
    await worker.runOnce()
    const afterFirst = await authed.get(`/api/voices/${voice.id}/audition/${first.body.taskId}`)
    expect(afterFirst.body.status).toBe('failed')

    // 失败的任务不能还占着 claim。
    const rows = await store.query('SELECT id, status, claimed_by, claimed_at FROM audition ORDER BY id')
    expect(rows[0].claimed_by).toBeNull()
    expect(rows[1].claimed_by).toBeNull()

    // 第二次 tick：第二条仍能被取到（没被前面的失败堵死）。
    await worker.runOnce()
    const afterSecond = await authed.get(`/api/voices/${voice.id}/audition/${second.body.taskId}`)
    expect(afterSecond.body.status).not.toBe('waiting')
  })
})
