import path from 'node:path'
import fs from 'node:fs'
import express from 'express'
import multer from 'multer'

/**
 * HTTP API of the web deployment.
 *
 * The desktop client talked to the main process over IPC (src/renderer/src/api/index.js);
 * this router exposes the same use cases over REST so the renderer can run in a browser.
 * Every handler is wrapped so rejected promises reach the error middleware (express 4 does
 * not do this by itself).
 */

const JSON_LIMIT = '2mb'

const h = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next)

function parseIntParam(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(Math.max(parsed, min), max)
}

function pageParams(query) {
  return {
    page: parseIntParam(query.page, 1),
    pageSize: parseIntParam(query.pageSize ?? query.page_size, 10, { min: 1, max: 100 }),
    name: typeof query.name === 'string' ? query.name : ''
  }
}

export function createUploads(dir, { maxFileBytes } = {}) {
  const storage = multer.diskStorage({
    destination(req, file, done) {
      done(null, dir)
    },
    filename(req, file, done) {
      const ext = path.extname(file.originalname || '')
      const base = path
        .basename(file.originalname || 'upload', ext)
        .replace(/[^\w.-]/g, '_')
        .slice(0, 40)
      done(null, `${Date.now()}-${Math.random().toString(16).slice(2, 10)}-${base}${ext}`)
    }
  })

  return multer({
    storage,
    limits: { fileSize: maxFileBytes },
    fileFilter(req, file, done) {
      const type = String(file.mimetype || '').toLowerCase()
      // Browsers send a proper audio/* or video/* type. Some clients (curl, a few HTTP
      // libraries) send application/octet-stream instead, so fall back to the extension.
      if (type.startsWith('audio/') || type.startsWith('video/')) {
        done(null, true)
        return
      }
      const ext = path.extname(file.originalname || '').toLowerCase()
      const known = ['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg']
      if (!type || type === 'application/octet-stream') {
        done(null, known.includes(ext))
        return
      }
      done(Object.assign(new Error(`不支持的文件类型: ${type}`), { status: 400 }))
    }
  })
}

/**
 * @param {object} deps
 * @param {object} deps.services { context, model, voice, video }
 * @param {object} deps.media    media store
 * @param {object} deps.config   loaded config
 * @param {object} deps.logger   logger
 * @param {object} [deps.worker] video worker
 * @param {object} [deps.rqlite] rqlite client (health only)
 */
export function createApp({ services, media, config, logger, worker, rqlite, auth }) {
  const app = express()
  app.disable('x-powered-by')

  const log = logger
  const uploadsDir = path.join(media.root, 'uploads')
  fs.mkdirSync(uploadsDir, { recursive: true })
  const upload = createUploads(uploadsDir, { maxFileBytes: config.upload.maxFileBytes })

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    next()
  })

  app.use('/api', express.json({ limit: JSON_LIMIT }))

  // Login: the only way to obtain a token. Public by definition.
  app.post(
    '/api/auth/login',
    h(async (req, res) => {
      const { username, password } = req.body || {}
      if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
        res.status(400).json({ code: 400, message: '用户名和密码不能为空' })
        return
      }
      const token = auth.login(username, password)
      if (!token) {
        res.status(401).json({ code: 401, message: '用户名或密码错误' })
        return
      }
      res.json({ token })
    })
  )

  // Health is left open for monitoring/liveness probes.
  app.get(
    '/api/health',
    h(async (req, res) => {
      let rqliteOk = false
      try {
        await rqlite?.ping()
        rqliteOk = Boolean(rqlite)
      } catch (error) {
        log.warn(`rqlite 健康检查失败: ${error?.message || error}`)
      }
      res.json({
        status: rqliteOk ? 'ok' : 'degraded',
        uptime: Math.round(process.uptime()),
        worker: worker?.running ? 'running' : 'stopped',
        rqlite: rqliteOk,
        version: process.env.APP_VERSION || '1.0.0'
      })
    })
  )

  // Media files (model videos, generated audio and video) are referenced directly by
  // <video>/<img>/<audio> tags, which cannot send Authorization headers, so they stay
  // public. Range requests are enabled so the browser can scrub the <video> preview.
  app.use(
    '/api/files',
    express.static(media.face2faceRoot, {
      dotFiles: 'deny',
      index: false,
      maxAge: 0,
      etag: true,
      acceptRanges: true,
      setHeaders(res, filePath) {
        const { query } = res.req
        if (query && query.download !== undefined) {
          const fileName = typeof query.name === 'string' ? query.name : path.basename(filePath)
          res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`)
        }
      }
    })
  )

  // Everything else under /api requires a valid bearer token.
  app.use('/api', requireAuth(auth))

  app.get('/api/logs', (req, res) => {
    res.json({ list: log.tail(parseIntParam(req.query.limit, 200, { min: 1, max: 1000 })) })
  })

  app.get('/api/config', (req, res) => {
    res.json({
      name: 'Duix.Avatar',
      worker: Boolean(worker?.running),
      maxUploadMb: Math.round(config.upload.maxFileBytes / 1024 / 1024)
    })
  })

  app.use('/api/context', createContextRouter(services.context))
  app.use('/api/models', createModelRouter(services.model, upload))
  app.use('/api/videos', createVideoRouter(services.video, upload, media))
  app.use('/api/voices', createVoiceRouter(services.voice, services.audition))

  app.use('/api', (req, res) => {
    res.status(404).json({ code: 404, message: `接口不存在: ${req.method} ${req.originalUrl}` })
  })

  app.use(errorHandler(log))

  return app
}

function createContextRouter(contextService) {
  const router = express.Router()

  router.get(
    '/',
    h(async (req, res) => {
      res.json({ list: await contextService.list() })
    })
  )

  router.get(
    '/:key',
    h(async (req, res) => {
      const row = await contextService.get(req.params.key)
      if (!row) {
        res.status(404).json({ code: 404, message: `未找到配置: ${req.params.key}` })
        return
      }
      res.json(row)
    })
  )

  router.post(
    '/',
    h(async (req, res) => {
      const { key, val } = req.body || {}
      if (!key) {
        res.status(400).json({ code: 400, message: 'key 不能为空' })
        return
      }
      res.json(await contextService.save(key, val ?? ''))
    })
  )

  return router
}

function createModelRouter(modelService, upload) {
  const router = express.Router()

  router.get(
    '/',
    h(async (req, res) => {
      res.json(await modelService.page(pageParams(req.query)))
    })
  )

  router.get(
    '/count',
    h(async (req, res) => {
      res.json({ count: await modelService.count(req.query.name || '') })
    })
  )

  router.post(
    '/batch-delete',
    h(async (req, res) => {
      const parsed = parseIds(req.body?.ids)
      if (parsed.invalid) {
        res.status(400).json({ code: 400, message: 'ids 必须是非空的正整数数组' })
        return
      }
      res.json(await modelService.batchRemove(parsed.ids))
    })
  )

  router.get(
    '/:id',
    h(async (req, res) => {
      const model = await modelService.find(req.params.id)
      if (!model) {
        res.status(404).json({ code: 404, message: '模特不存在' })
        return
      }
      res.json(model)
    })
  )

  router.post(
    '/',
    upload.fields([
      { name: 'video', maxCount: 1 },
      { name: 'audio', maxCount: 1 }
    ]),
    h(async (req, res) => {
      const files = req.files || {}
      const id = await modelService.add({
        name: req.body?.name,
        videoFile: files.video?.[0],
        audioFile: files.audio?.[0],
        lang: req.body?.lang || 'zh'
      })
      res.status(201).json({ id })
    })
  )

  router.delete(
    '/:id',
    h(async (req, res) => {
      const removed = await modelService.remove(req.params.id)
      if (!removed) {
        res.status(404).json({ code: 404, message: '模特不存在' })
        return
      }
      res.json({ id: Number(req.params.id), removed: true })
    })
  )

  return router
}

function createVideoRouter(videoService, upload, media) {
  const router = express.Router()

  router.get(
    '/',
    h(async (req, res) => {
      res.json(await videoService.page(pageParams(req.query)))
    })
  )

  router.get(
    '/count',
    h(async (req, res) => {
      res.json({ count: await videoService.count(req.query.name || '') })
    })
  )

  router.post(
    '/batch-delete',
    h(async (req, res) => {
      const parsed = parseIds(req.body?.ids)
      if (parsed.invalid) {
        res.status(400).json({ code: 400, message: 'ids 必须是非空的正整数数组' })
        return
      }
      res.json(await videoService.batchRemove(parsed.ids))
    })
  )

  router.get(
    '/:id',
    h(async (req, res) => {
      const video = await videoService.find(req.params.id)
      if (!video) {
        res.status(404).json({ code: 404, message: '作品不存在' })
        return
      }
      res.json(video)
    })
  )

  // JSON body, or multipart when an audio file is uploaded. multer ignores non-multipart
  // requests, so express.json() parses those afterwards.
  router.post('/', upload.single('audio'), express.json(), h(async (req, res) => {
    const body = req.body || {}
    const parsedId = parseVideoId(body.id)
    if (parsedId.invalid) {
      res.status(400).json({ code: 400, message: '无效的视频 ID' })
      return
    }
    const id = parsedId.id
    const savedId = await videoService.save({
      id,
      modelId: toNumberOrNull(body.modelId ?? body.model_id),
      name: body.name,
      textContent: body.textContent ?? body.text_content ?? '',
      voiceId: toNumberOrNull(body.voiceId ?? body.voice_id),
      audio: req.file,
      audioPath: body.audioPath ?? body.audio_path
    })
    res.status(id ? 200 : 201).json({ id: savedId })
  }))

  router.patch('/:id', express.json(), h(async (req, res) => {
    const body = req.body || {}
    const fields = {}
    if (body.name !== undefined) fields.name = body.name
    if (body.textContent !== undefined || body.text_content !== undefined) {
      fields.text_content = body.textContent ?? body.text_content
    }
    if (body.voiceId !== undefined || body.voice_id !== undefined) {
      fields.voice_id = toNumberOrNull(body.voiceId ?? body.voice_id)
    }
    if (body.modelId !== undefined || body.model_id !== undefined) {
      fields.model_id = toNumberOrNull(body.modelId ?? body.model_id)
    }
    if (body.status !== undefined) fields.status = body.status
    if (body.message !== undefined) fields.message = body.message
    if (body.progress !== undefined) fields.progress = Number(body.progress) || 0
    if (!Object.keys(fields).length) {
      res.status(400).json({ code: 400, message: '没有可更新的字段' })
      return
    }
    await videoService.modify({ id: Number(req.params.id), ...fields })
    res.json(await videoService.find(req.params.id))
  }))

  router.delete(
    '/:id',
    h(async (req, res) => {
      const removed = await videoService.remove(req.params.id)
      if (!removed) {
        res.status(404).json({ code: 404, message: '作品不存在' })
        return
      }
      res.json({ id: Number(req.params.id), removed: true })
    })
  )

  router.post(
    '/:id/make',
    h(async (req, res) => {
      await videoService.make(Number(req.params.id))
      res.json({ id: Number(req.params.id), status: 'waiting' })
    })
  )

  router.get(
    '/:id/export',
    h(async (req, res, next) => {
      const video = await videoService.find(req.params.id)
      if (!video || video.status !== 'success' || !video.file_name) {
        res.status(404).json({ code: 404, message: '作品不存在或尚未合成完成' })
        return
      }
      const absolute = media.safeResolve(video.file_name)
      const fileName = `${String(video.name || video.id).replace(/[\\/:*?"<>|]/g, '_')}.mp4`
      res.download(absolute, fileName, (error) => {
        if (error) next(error)
      })
    })
  )

  return router
}

function createVoiceRouter(voiceService, auditionService) {
  const router = express.Router()

  router.get(
    '/',
    h(async (req, res) => {
      res.json({ list: await voiceService.list() })
    })
  )

  // Reference audio of a cloned voice, served straight from the TTS data root so no
  // absolute server path ever reaches the browser.
  router.get(
    '/:id/preview',
    h(async (req, res) => {
      const voice = await voiceService.find(req.params.id)
      if (!voice) {
        res.status(404).json({ code: 404, message: '音色不存在' })
        return
      }
      const absolute = voiceService.referenceAudioPath(voice)
      if (!absolute) {
        res.status(404).json({ code: 404, message: '参考音频不存在' })
        return
      }
      res.sendFile(absolute)
    })
  )

  // Audition is queued instead of synthesised inline: TTS takes minutes on the Pascal
  // GPU, far beyond the EdgeOne 15s origin timeout. The route returns 202 with a task id
  // immediately, and the background worker fills in the audio via the status endpoint.
  router.post(
    '/:id/audition',
    express.json(),
    h(async (req, res) => {
      const text = String(req.body?.text ?? req.query.text ?? '')
      const taskId = await auditionService.create({ voiceId: Number(req.params.id), text })
      res.status(202).json({ taskId, status: 'waiting' })
    })
  )

  router.get(
    '/:id/audition/:taskId',
    h(async (req, res) => {
      const task = await auditionService.find(Number(req.params.taskId))
      if (!task || Number(task.voice_id) !== Number(req.params.id)) {
        res.status(404).json({ code: 404, message: '试听任务不存在' })
        return
      }
      res.json(task)
    })
  )

  return router
}

function toNumberOrNull(value) {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Validate the `ids` body of a batch-delete request: a non-empty array of positive
 * integers. Malformed input is rejected as a whole (400) so the service never guesses
 * which entries the caller meant; ids that are well-formed but absent from the store
 * are handled per-id by the service and returned in `failed`.
 */
function parseIds(value) {
  if (!Array.isArray(value) || value.length === 0) return { invalid: true }
  const ids = []
  for (const item of value) {
    const id = Number(item)
    if (!Number.isInteger(id) || id <= 0) return { invalid: true }
    ids.push(id)
  }
  return { ids }
}

/**
 * Parse the `id` field of `POST /api/videos`.
 *
 * - `undefined` or `''` → create a new record (the web client sends `id: ''` for
 *   brand-new drafts).
 * - a positive integer (number, or numeric string) → update that record.
 * - anything else (`null`, `0`, negatives, `{}`, `"abc"`, `NaN`) → `{ invalid: true }`;
 *   the caller must answer 400 rather than silently inserting a new row — that was
 *   how every invalid id used to become a fresh draft.
 */
function parseVideoId(value) {
  if (value === undefined || value === '') return {}
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 ? { id: value } : { invalid: true }
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '') return {}
    if (/^\d+$/.test(trimmed)) {
      const parsed = Number(trimmed)
      return Number.isInteger(parsed) && parsed > 0 ? { id: parsed } : { invalid: true }
    }
  }
  return { invalid: true }
}

function requireAuth(auth) {
  return (req, res, next) => {
    const token = extractBearerToken(req)
    if (!token || !auth.verify(token)) {
      res.status(401).json({ code: 401, message: '未登录或令牌已失效' })
      return
    }
    next()
  }
}

function extractBearerToken(req) {
  const header = req.headers.authorization || ''
  const match = /^Bearer\s+(.+)$/i.exec(header)
  return match ? match[1].trim() : ''
}

function errorHandler(log) {
  // eslint-disable-next-line no-unused-vars
  return (error, req, res, next) => {
    const status = error.status || (error.code === 'LIMIT_FILE_SIZE' ? 413 : 500)
    const message = status === 413 ? '上传文件过大' : error.message || '服务器内部错误'
    if (status >= 500) log.error(req.method, req.originalUrl, error?.stack || message)
    else log.warn(req.method, req.originalUrl, message)
    res.status(status).json({ code: status, message })
  }
}

export default createApp