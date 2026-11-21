import http from 'node:http'

import { loadConfig } from './config.js'
import { createLogger } from './logger.js'
import { RqliteClient } from './store/rqlite.js'
import { migrate } from './store/schema.js'
import { createContextDao, createModelDao, createVideoDao, createVoiceDao, createAuditionDao } from './dao/index.js'
import { createMediaStore } from './media/index.js'
import { createFace2faceClient, createTtsClient } from './integrations/clients.js'
import { createContextService, createModelService, createVideoService, createVoiceService, createAuditionService } from './services/index.js'
import { createVideoWorker, createAuditionWorker } from './services/worker.js'
import { createApp } from './routes/index.js'
import { createAuthService } from './auth.js'

/**
 * Wire configuration, stores, services and the http app together.
 * Exported so tests can build a fully-formed instance with stubs.
 */
export function buildContext({ env = process.env, logger, store, ttsClient, face2faceClient } = {}) {
  const config = loadConfig(env)
  const log = logger || createLogger({ level: config.logLevel })

  const media = createMediaStore(config)
  media.ensureDirs()

  const rqlite =
    store || new RqliteClient({ ...config.rqlite, logger: log, fetchImpl: globalThis.fetch })
  const daos = {
    context: createContextDao(rqlite),
    model: createModelDao(rqlite),
    voice: createVoiceDao(rqlite),
    video: createVideoDao(rqlite),
    audition: createAuditionDao(rqlite)
  }
  const tts = ttsClient || createTtsClient({ ...config.tts, log })
  const face2face = face2faceClient || createFace2faceClient({ ...config.face2face, log })

  const services = {
    context: createContextService({ contextDao: daos.context }),
    model: createModelService({ modelDao: daos.model, voiceDao: daos.voice, tts, media, log }),
    voice: createVoiceService({ voiceDao: daos.voice, tts, media, log })
  }
  services.audition = createAuditionService({
    auditionDao: daos.audition,
    voiceService: services.voice,
    log
  })
  services.video = createVideoService({
    videoDao: daos.video,
    modelDao: daos.model,
    voiceService: services.voice,
    media,
    tts,
    face2face,
    log
  })

  const worker = config.worker.enabled
    ? createVideoWorker({
        videoDao: daos.video,
        videoService: services.video,
        leaseMs: config.worker.leaseMs,
        intervalMs: config.worker.intervalMs,
        log
      })
    : null

  // Audition synthesis takes minutes, so its lease matches the TTS timeout rather than
  // the (short) video lease; a shorter lease would let a task be re-claimed mid-TTS.
  const auditionWorker = config.worker.enabled
    ? createAuditionWorker({
        auditionDao: daos.audition,
        auditionService: services.audition,
        leaseMs: config.tts.timeoutMs,
        intervalMs: config.worker.intervalMs,
        log
      })
    : null

  const auth = createAuthService({
    username: config.auth.username,
    passwordHash: config.auth.passwordHash
  })

  const app = createApp({ services, media, config, logger: log, worker, rqlite, auth })

  return { config, log, media, rqlite, daos, services, worker, auditionWorker, auth, app }
}

async function main() {
  const context = buildContext()
  const { config, log, rqlite, worker, auditionWorker, app } = context

  log.info('starting duix-avatar server', {
    dataDir: config.dataDir,
    tts: config.tts.baseUrl,
    face2face: config.face2face.baseUrl,
    rqlite: config.rqlite.url
  })

  await migrate(rqlite, log)
  log.info('rqlite schema ready')

  if (worker) worker.start()
  if (auditionWorker) auditionWorker.start()

  const server = http.createServer(app)
  server.listen(config.port, config.host, () => {
    log.info(`duix-avatar server listening on http://${config.host}:${config.port}`)
  })

  const shutdown = (signal) => {
    log.info(`${signal} received, shutting down`)
    if (worker) worker.stop()
    if (auditionWorker) auditionWorker.stop()
    server.close(() => {
      log.info('bye')
      process.exit(0)
    })
    // Don't hang forever on keep-alive sockets.
    setTimeout(() => process.exit(1), 10000).unref()
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))

  return server
}

// Only start when executed directly, so tests can import buildContext.
const isDirectRun = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href

if (isDirectRun) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}