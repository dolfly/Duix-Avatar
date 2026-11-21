import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'

import { buildContext } from '../src/index.js'
import { createLogger } from '../src/logger.js'
import { migrate } from '../src/store/schema.js'
import { createVideoWorker, createAuditionWorker } from '../src/services/worker.js'
import { SqliteStore } from './helpers/sqlite-store.js'

/**
 * End-to-end API test: real express app, real services, real files on disk, real SQLite
 * (standing in for rqlite) and stub GPU services over real HTTP.
 */

const SILENT = createLogger({ level: process.env.TEST_LOG_LEVEL || 'silent' })

function startStubServer(handler) {
  const server = http.createServer(handler)
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ server, baseUrl: `http://127.0.0.1:${port}`, calls: [] })
    })
  })
}

const ttsState = { preprocess: null }
const f2fState = { submitResponse: { code: 10000, msg: 'ok' }, queryResponse: null, submits: [] }

async function startTtsStub() {
  return startStubServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      if (req.url === '/v1/preprocess_and_tran') {
        ttsState.preprocess = body ? JSON.parse(body) : null
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ code: 0, asr_format_audio_url: 'origin_audio/ref.wav', reference_audio_text: '你好' }))
        return
      }
      if (req.url === '/v1/invoke') {
        // minimal wav header + silence
        res.writeHead(200, { 'content-type': 'audio/wav' })
        res.end(Buffer.from('52494646000000005741564500', 'hex'))
        return
      }
      res.writeHead(404).end()
    })
  })
}

async function startF2fStub() {
  return startStubServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      const url = new URL(req.url, 'http://stub')
      if (url.pathname.endsWith('/submit')) {
        f2fState.submits.push(JSON.parse(body || '{}'))
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(f2fState.submitResponse))
        return
      }
      if (url.pathname.endsWith('/query')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(f2fState.queryResponse || { code: 10000, data: { status: 1, progress: 30 } }))
        return
      }
      res.writeHead(404).end()
    })
  })
}

let dataDir
let store
let tts
let f2f
let ctx
let workerA
let workerB

const AUTH = { username: 'admin', password: 's3cret' }
let authToken = ''

// Protected routes require a bearer token now; this helper keeps the existing tests
// readable while attaching the token obtained in beforeEach.
const authed = {
  get: (url) => request(ctx.app).get(url).set('Authorization', `Bearer ${authToken}`),
  post: (url) => request(ctx.app).post(url).set('Authorization', `Bearer ${authToken}`),
  patch: (url) => request(ctx.app).patch(url).set('Authorization', `Bearer ${authToken}`),
  delete: (url) => request(ctx.app).delete(url).set('Authorization', `Bearer ${authToken}`)
}

beforeAll(async () => {
  tts = await startTtsStub()
  f2f = await startF2fStub()
})

afterAll(async () => {
  await Promise.all(
    [tts, f2f].map(
      (stub) =>
        new Promise((resolve) => {
          stub.server.close(resolve)
        })
    )
  )
})

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duix-avatar-'))
  store = new SqliteStore()
  ctx = buildContext({
    store,
    logger: SILENT,
    env: {
      DATA_DIR: dataDir,
      TTS_BASE_URL: tts.baseUrl,
      FACE2FACE_BASE_URL: `${f2f.baseUrl}/easy`,
      WORKER_ENABLED: 'false',
      AUTH_USERNAME: AUTH.username,
      AUTH_PASSWORD: AUTH.password
    }
  })
  await migrate(store, SILENT)

  const login = await request(ctx.app).post('/api/auth/login').send(AUTH)
  authToken = login.body.token

  workerA = createVideoWorker({ videoDao: ctx.daos.video, videoService: ctx.services.video, log: SILENT, leaseMs: 60000 })
  workerB = createVideoWorker({ videoDao: ctx.daos.video, videoService: ctx.services.video, log: SILENT, leaseMs: 60000 })

  ttsState.preprocess = null
  f2fState.submits = []
  f2fState.submitResponse = { code: 10000, msg: 'ok' }
  f2fState.queryResponse = null
})

afterEach(() => {
  store.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

async function createModel(name = '模特A') {
  const response = await authed
    .post('/api/models')
    .field('name', name)
    .attach('video', Buffer.from('fake-mp4'), { filename: 'raw.mp4', contentType: 'video/mp4' })
    .attach('audio', Buffer.from('fake-wav'), { filename: 'raw.wav', contentType: 'audio/wav' })

  expect(response.status).toBe(201)
  return response.body.id
}

describe('GET /api/health', () => {
  it('reports the worker state and store connectivity', async () => {
    const response = await request(ctx.app).get('/api/health')
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ worker: 'stopped', rqlite: true })
  })
})

describe('auth', () => {
  it('logs in with correct credentials and returns a token', async () => {
    const response = await request(ctx.app).post('/api/auth/login').send(AUTH)
    expect(response.status).toBe(200)
    expect(response.body.token).toMatch(/^[0-9a-f]{64}$/)
  })

  it('rejects wrong credentials with the same 401 shape (no account enumeration)', async () => {
    const wrongPassword = await request(ctx.app)
      .post('/api/auth/login')
      .send({ username: AUTH.username, password: 'wrong-password' })
    const wrongUsername = await request(ctx.app)
      .post('/api/auth/login')
      .send({ username: 'nobody', password: AUTH.password })

    expect(wrongPassword.status).toBe(401)
    expect(wrongUsername.status).toBe(401)
    expect(wrongPassword.body).toEqual(wrongUsername.body)
  })

  it('rejects missing fields with 400', async () => {
    const response = await request(ctx.app).post('/api/auth/login').send({})
    expect(response.status).toBe(400)
  })

  it('rejects protected routes without a token', async () => {
    await expect(request(ctx.app).get('/api/videos')).resolves.toMatchObject({ status: 401 })
    await expect(request(ctx.app).post('/api/videos').send({ name: 'x' })).resolves.toMatchObject({ status: 401 })
  })

  it('rejects an invalid token', async () => {
    await expect(
      request(ctx.app).get('/api/videos').set('Authorization', 'Bearer deadbeef')
    ).resolves.toMatchObject({ status: 401 })
  })

  it('does not create records on unauthenticated writes', async () => {
    const response = await request(ctx.app).post('/api/videos').send({ modelId: 1, name: 'x', textContent: 'y' })
    expect(response.status).toBe(401)
    const rows = await store.query('SELECT * FROM video')
    expect(rows).toHaveLength(0)
  })
})

describe('context API', () => {
  it('creates and updates a key', async () => {
    await expect(authed.get('/api/context/appearance')).resolves.toMatchObject({ status: 404 })

    const created = await authed.post('/api/context').send({ key: 'appearance', val: '#101010' })
    expect(created.status).toBe(200)

    const updated = await authed.post('/api/context').send({ key: 'appearance', val: '#ffffff' })
    expect(updated.status).toBe(200)

    const rows = await store.query('SELECT * FROM context WHERE key = ?', ['appearance'])
    expect(rows).toHaveLength(1)
    expect(rows[0].val).toBe('#ffffff')

    const read = await authed.get('/api/context/appearance')
    expect(read.body).toMatchObject({ key: 'appearance', val: '#ffffff' })
  })

  it('lists every key', async () => {
    await authed.post('/api/context').send({ key: 'a', val: '1' })
    await authed.post('/api/context').send({ key: 'b', val: '2' })
    const response = await authed.get('/api/context')
    expect(response.body.list.map((row) => row.key).sort()).toEqual(['a', 'b', 'db_version'])
  })
})

describe('model API', () => {
  it('stores the uploaded files and exposes playable urls', async () => {
    const id = await createModel('模特A')

    const model = await ctx.services.model.find(id)
    expect(model.name).toBe('模特A')
    expect(model.video_path).toMatch(/^\/api\/files\/temp\/.+\.mp4$/)
    expect(model.audio_path).toBe('/api/voices/1/preview')
    expect(fs.existsSync(path.join(dataDir, 'face2face', model.video_file))).toBe(true)
    expect(fs.existsSync(path.join(dataDir, 'voice', 'data', 'origin_audio', path.basename(model.audio_file)))).toBe(
      true
    )
    expect(ttsState.preprocess).toMatchObject({ format: 'wav', lang: 'zh' })

    const videoResponse = await authed.get(model.video_path)
    expect(videoResponse.status).toBe(200)
    expect(videoResponse.headers['content-type']).toMatch(/video\/mp4/)
  })

  it('paginates and filters by name', async () => {
    await createModel('张三')
    await createModel('李四')

    const page = await authed.get('/api/models?page=1&pageSize=1')
    expect(page.body.total).toBe(2)
    expect(page.body.list).toHaveLength(1)

    const filtered = await authed.get('/api/models?name=张')
    expect(filtered.body.total).toBe(1)
    expect(filtered.body.list[0].name).toBe('张三')
  })

  it('counts models and filters the count by name', async () => {
    await createModel('张三')
    await createModel('李四')

    const all = await authed.get('/api/models/count')
    expect(all.status).toBe(200)
    expect(all.body).toEqual({ count: 2 })

    const filtered = await authed.get('/api/models/count?name=张')
    expect(filtered.status).toBe(200)
    expect(filtered.body).toEqual({ count: 1 })
  })

  it('requires a token for the count endpoint', async () => {
    await expect(request(ctx.app).get('/api/models/count')).resolves.toMatchObject({ status: 401 })
  })

  it('deletes the model together with its files', async () => {
    const id = await createModel()
    const model = await ctx.services.model.find(id)

    const response = await authed.delete(`/api/models/${id}`)
    expect(response.status).toBe(200)
    expect(fs.existsSync(path.join(dataDir, 'face2face', model.video_file))).toBe(false)
  })

  it('rejects requests without the required fields', async () => {
    const response = await authed.post('/api/models').field('name', 'x')
    expect(response.status).toBe(400)
    expect(response.body.message).toMatch(/缺少/)
  })

  it('surfaces TTS failures', async () => {
    const original = ttsState.preprocess
    const stub = await startStubServer((req, res) => {
      req.resume()
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ code: 500, msg: '声音复刻失败' }))
      })
    })
    try {
      const failing = buildContext({
        store,
        logger: SILENT,
        env: {
          DATA_DIR: dataDir,
          TTS_BASE_URL: stub.baseUrl,
          WORKER_ENABLED: 'false',
          AUTH_USERNAME: AUTH.username,
          AUTH_PASSWORD: AUTH.password
        }
      })
      await expect(failing.services.model.add({
        name: 'bad',
        videoFile: { path: writeTemp('a.mp4'), originalname: 'a.mp4' },
        audioFile: { path: writeTemp('a.wav'), originalname: 'a.wav' }
      })).rejects.toThrow(/声音复刻失败/)
    } finally {
      await new Promise((resolve) => stub.server.close(resolve))
      ttsState.preprocess = original
    }
  })
})

describe('video API', () => {
  async function createDraft(overrides = {}) {
    const modelId = await createModel()
    const response = await authed
      .post('/api/videos')
      .send({ modelId, name: '作品A', textContent: '你好世界', ...overrides })
    expect(response.status).toBe(201)
    return response.body.id
  }

  it('creates a draft and queues it', async () => {
    const id = await createDraft()

    const draft = await ctx.services.video.find(id)
    expect(draft).toMatchObject({ name: '作品A', status: 'draft', text_content: '你好世界', progress: 0 })

    const queued = await authed.post(`/api/videos/${id}/make`)
    expect(queued.status).toBe(200)
    expect((await ctx.services.video.find(id)).status).toBe('waiting')
  })

  it('patches editable fields', async () => {
    const id = await createDraft()
    const response = await authed.patch(`/api/videos/${id}`).send({ name: '改名', textContent: '新的文案' })
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ name: '改名', text_content: '新的文案' })
  })

  it('deletes a draft', async () => {
    const id = await createDraft()
    await expect(authed.delete(`/api/videos/${id}`)).resolves.toMatchObject({ status: 200 })
    await expect(authed.get(`/api/videos/${id}`)).resolves.toMatchObject({ status: 404 })
  })

  it('reports 404 for unknown ids', async () => {
    await expect(authed.get('/api/videos/999')).resolves.toMatchObject({ status: 404 })
    await expect(authed.post('/api/videos/999/make')).resolves.toMatchObject({ status: 200 })
  })

  it('synthesises a video through the GPU stubs and reports progress', async () => {
    const id = await createDraft({ voiceId: 1 })
    await authed.post(`/api/videos/${id}/make`)

    await workerA.runOnce()

    const submitted = await ctx.services.video.find(id)
    expect(submitted.status).toBe('pending')
    expect(f2fState.submits).toHaveLength(1)
    expect(f2fState.submits[0]).toMatchObject({
      audio_url: expect.stringContaining('/code/data/temp/'),
      video_url: expect.stringContaining('/code/data/temp/')
    })
    expect(submitted.audio_path).toMatch(/^\/api\/files\/temp\/.+\.wav$/)

    f2fState.queryResponse = { code: 10000, data: { status: 1, progress: 60, msg: '合成中' } }
    await workerA.runOnce()
    expect((await ctx.services.video.find(id)).progress).toBe(60)

    fs.writeFileSync(path.join(dataDir, 'face2face', 'temp', 'result.mp4'), 'fake-result')
    f2fState.queryResponse = { code: 10000, data: { status: 2, result: 'result.mp4' } }
    await workerA.runOnce()

    const done = await ctx.services.video.find(id)
    expect(done.status).toBe('success')
    expect(done.file_path).toMatch(/^\/api\/files\/temp\/result\.mp4$/)

    const download = await authed.get(done.file_path)
    expect(download.status).toBe(200)
    expect(download.body.toString()).toBe('fake-result')

    const exported = await authed.get(`/api/videos/${id}/export`)
    expect(exported.status).toBe(200)
    expect(exported.headers['content-disposition']).toMatch(/attachment/)
  })

  it('marks the video failed when the GPU service rejects it', async () => {
    const id = await createDraft({ voiceId: 1 })
    await authed.post(`/api/videos/${id}/make`)
    f2fState.submitResponse = { code: 10001, msg: '参数错误' }
    await workerA.runOnce()

    const video = await ctx.services.video.find(id)
    expect(video.status).toBe('failed')
    expect(video.message).toBe('参数错误')
  })

  it('marks the video failed when the GPU task fails', async () => {
    const id = await createDraft({ voiceId: 1 })
    await authed.post(`/api/videos/${id}/make`)
    await workerA.runOnce()

    f2fState.queryResponse = { code: 10002, msg: '任务失败' }
    await workerA.runOnce()
    expect((await ctx.services.video.find(id)).status).toBe('failed')
  })

  it('lets only one instance synthesise the same task', async () => {
    const id = await createDraft({ voiceId: 1 })
    await authed.post(`/api/videos/${id}/make`)

    await Promise.all([workerA.runOnce(), workerB.runOnce()])

    expect(f2fState.submits).toHaveLength(1)
    const claims = await store.query('SELECT claimed_by, claimed_at FROM video WHERE id = ?', [id])
    expect(claims[0].claimed_by).toBeNull()
  })

  it('fails a queued video when its model was deleted', async () => {
    const modelId = await createModel()
    const response = await authed.post('/api/videos').send({ modelId, name: '无模特', textContent: 'x' })
    const id = response.body.id
    await authed.delete(`/api/models/${modelId}`)

    await authed.post(`/api/videos/${id}/make`)
    await workerA.runOnce()

    const video = await ctx.services.video.find(id)
    expect(video.status).toBe('failed')
    expect(video.message).toMatch(/模特/)
  })
})

describe('video id validation', () => {
  it('rejects invalid ids on POST /api/videos without inserting', async () => {
    const modelId = await createModel()
    for (const bad of ['abc', {}, 0, -1, null]) {
      const response = await authed
        .post('/api/videos')
        .send({ id: bad, modelId, name: '作品', textContent: '文案' })
      expect(response.status).toBe(400)
      expect(response.body.message).toMatch(/无效的视频 ID/)
    }
    const rows = await store.query('SELECT * FROM video')
    expect(rows).toHaveLength(0)
  })

  it('treats an empty-string id as create and a numeric id as update', async () => {
    const modelId = await createModel()

    const created = await authed
      .post('/api/videos')
      .send({ id: '', modelId, name: '作品A', textContent: '文案' })
    expect(created.status).toBe(201)
    const id = created.body.id
    expect(Number.isInteger(id)).toBe(true)
    expect(id).toBeGreaterThan(0)

    // Re-POSTing with the returned id must update the same row, never insert a
    // second one (the old code turned a malformed id into a fresh draft).
    const updated = await authed
      .post('/api/videos')
      .send({ id, modelId, name: '作品A改', textContent: '新文案' })
    expect(updated.status).toBe(200)
    expect(updated.body.id).toBe(id)

    const rows = await store.query('SELECT * FROM video')
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe('作品A改')
    expect(rows[0].text_content).toBe('新文案')
  })

  it('rejects invalid ids at the service layer too', async () => {
    await expect(ctx.services.video.save({ id: 0, name: 'x' })).rejects.toThrow(/无效的视频 ID/)
    await expect(ctx.services.video.save({ id: NaN, name: 'x' })).rejects.toThrow(/无效的视频 ID/)
    await expect(ctx.services.video.save({ id: {}, name: 'x' })).rejects.toThrow(/无效的视频 ID/)
  })
})

describe('voice API', () => {
  it('previews the reference audio of a cloned voice', async () => {
    await createModel()
    const response = await authed.get('/api/voices/1/preview')
    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toMatch(/audio/)
  })

  it('auditions text asynchronously and exposes the generated audio', async () => {
    await createModel()

    // The audition is queued and must return immediately (202), never waiting on the
    // minutes-long TTS call.
    const queued = await authed.post('/api/voices/1/audition').send({ text: '试听一下' })
    expect(queued.status).toBe(202)
    expect(queued.body).toMatchObject({ status: 'waiting' })
    const taskId = queued.body.taskId

    // Before the worker runs, the task is still waiting with no audio.
    const pending = await authed.get(`/api/voices/1/audition/${taskId}`)
    expect(pending.status).toBe(200)
    expect(pending.body.status).toBe('waiting')
    expect(pending.body.audioPath).toBeNull()

    // The background worker synthesises the audio.
    const auditionWorker = createAuditionWorker({
      auditionDao: ctx.daos.audition,
      auditionService: ctx.services.audition,
      log: SILENT,
      leaseMs: 60000
    })
    await auditionWorker.runOnce()

    const done = await authed.get(`/api/voices/1/audition/${taskId}`)
    expect(done.status).toBe(200)
    expect(done.body.status).toBe('success')
    expect(done.body.audioPath).toMatch(/^\/api\/files\/temp\/.+\.wav$/)
    expect(fs.existsSync(path.join(dataDir, 'face2face', done.body.file_name))).toBe(true)
  })

  it('lets only one instance synthesise the same audition task', async () => {
    await createModel()
    const queued = await authed.post('/api/voices/1/audition').send({ text: '试听一下' })
    const taskId = queued.body.taskId

    const workerA = createAuditionWorker({
      auditionDao: ctx.daos.audition,
      auditionService: ctx.services.audition,
      log: SILENT,
      leaseMs: 60000
    })
    const workerB = createAuditionWorker({
      auditionDao: ctx.daos.audition,
      auditionService: ctx.services.audition,
      log: SILENT,
      leaseMs: 60000
    })

    await Promise.all([workerA.runOnce(), workerB.runOnce()])

    const rows = await store.query('SELECT * FROM audition')
    expect(rows).toHaveLength(1)
    const claims = await store.query('SELECT claimed_by, claimed_at FROM audition WHERE id = ?', [taskId])
    expect(claims[0].claimed_by).toBeNull()
  })

  it('rejects audition requests without text', async () => {
    await createModel()
    await expect(authed.post('/api/voices/1/audition').send({})).resolves.toMatchObject({ status: 400 })
  })

  it('rejects audition requests for an unknown voice', async () => {
    await expect(authed.post('/api/voices/999/audition').send({ text: 'x' })).resolves.toMatchObject({
      status: 404
    })
  })

  it('returns 404 for an unknown audition task', async () => {
    await createModel()
    await expect(authed.get('/api/voices/1/audition/999')).resolves.toMatchObject({ status: 404 })
  })
})

describe('media routes', () => {
  it('serves range requests for video scrubbing', async () => {
    const id = await createModel()
    const model = await ctx.services.model.find(id)
    const response = await authed.get(model.video_path).set('Range', 'bytes=0-3')
    expect(response.status).toBe(206)
    expect(response.headers['content-range']).toMatch(/^bytes 0-3\//)
  })

  it('refuses path traversal', async () => {
    const response = await authed.get('/api/files/%2e%2e/package.json')
    expect(response.status).toBe(404)
  })
})

function writeTemp(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duix-upload-'))
  const file = path.join(dir, name)
  fs.writeFileSync(file, 'x')
  return file
}