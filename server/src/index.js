import http from 'node:http'

import { loadConfig } from './config.js'
import { createLogger } from './logger.js'
import { RqliteClient } from './store/rqlite.js'
import { migrate } from './store/schema.js'
import { createContextDao, createModelDao, createVideoDao, createVoiceDao, createAuditionDao, createModelTaskDao } from './dao/index.js'
import { createMediaStore } from './media/index.js'
import { createFace2faceClient, createTtsClient } from './integrations/clients.js'
import { createVramGate } from './integrations/gpu.js'
import { createTtsGate } from './integrations/tts-gate.js'
import { createGenVideoReaper } from './integrations/gen-video-reaper.js'
import { createContextService, createModelService, createVideoService, createVoiceService, createAuditionService } from './services/index.js'
import { createVideoWorker, createAuditionWorker, createModelTaskWorker } from './services/worker.js'
import { createApp } from './routes/index.js'
import { createAuthService } from './auth.js'

/**
 * Wire configuration, stores, services and the http app together.
 * Exported so tests can build a fully-formed instance with stubs.
 */
export function buildContext({ env = process.env, logger, store, ttsClient, face2faceClient, vramGate } = {}) {
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
    audition: createAuditionDao(rqlite),
    modelTask: createModelTaskDao(rqlite)
  }
  const tts = ttsClient || createTtsClient({ ...config.tts, log })
  const face2face = face2faceClient || createFace2faceClient({ ...config.face2face, log })

  // GPU memory admission gate, shared by the worker's pre-TTS check and the video
  // service's post-TTS re-check so both consult the same increment budget (DO-146).
  const gpuGate = vramGate
    || createVramGate({
      enabled: config.gpu.vramCheck,
      bin: config.gpu.smiBin,
      minFreeMb: config.gpu.minFreeVramMb,
      timeoutMs: config.gpu.probeTimeoutMs,
      log
    })

  // Every TTS call the server makes (audition preview, video TTS, voice cloning) funnels
  // through this one client, so gating it here shares a single slot across all three
  // entry points. `maxInflight` limits concurrent TTS inferences independently of the
  // video-side `VIDEO_MAX_INFLIGHT` gate.
  const ttsGated = createTtsGate({ tts, maxInflight: config.tts.maxInflight, log })

  // Abandoned-work reaper (DO-160): the total-timeout sweep can only fail our own row, so
  // without this the gen-video thread of a timed-out task keeps rendering and dragging the
  // card down. Default mode `none` (log-only) — `docker` needs the docker socket inside
  // this container, which is an operator/compose decision (see doc/web-deployment.md).
  const reaper = createGenVideoReaper({
    mode: config.worker.reapMode,
    container: config.worker.reapContainer,
    minIntervalMs: config.worker.reapMinIntervalMs,
    timeoutMs: config.worker.reapTimeoutMs,
    log
  })

  const services = {
    context: createContextService({ contextDao: daos.context }),
    model: createModelService({ modelDao: daos.model, voiceDao: daos.voice, tts: ttsGated, media, log, modelTaskDao: daos.modelTask }),
    voice: createVoiceService({ voiceDao: daos.voice, tts: ttsGated, media, log })
  }
  services.audition = createAuditionService({
    auditionDao: daos.audition,
    voiceService: services.voice,
    log,
    maxChars: config.audition.maxChars,
    timeoutMs: config.audition.timeoutMs
  })
  services.video = createVideoService({
    videoDao: daos.video,
    modelDao: daos.model,
    voiceService: services.voice,
    media,
    tts,
    face2face,
    log,
    gpuGate,
    // Dynamic per-task timeout window (DO-161): computed once the audio length is known.
    taskTimeout: {
      baseMs: config.worker.taskTimeoutMs,
      perSecondMs: config.worker.taskTimeoutPerSecondMs,
      maxMs: config.worker.taskTimeoutMaxMs
    }
  })

  const worker = config.worker.enabled
    ? createVideoWorker({
        videoDao: daos.video,
        videoService: services.video,
        leaseMs: config.worker.leaseMs,
        taskTimeoutMs: config.worker.taskTimeoutMs,
        taskTimeoutPerSecondMs: config.worker.taskTimeoutPerSecondMs,
        taskTimeoutMaxMs: config.worker.taskTimeoutMaxMs,
        maxInflight: config.worker.maxInflight,
        intervalMs: config.worker.intervalMs,
        gpuGate,
        reaper,
        reapCooldownMs: config.worker.reapCooldownMs,
        log
      })
    : null

  // Audition synthesis takes minutes, so its lease matches the TTS timeout rather than
  // the (short) video lease. The +60s margin ensures the lease outlives the TTS call
  // even when it runs right up to its own timeout, so another tick can't re-claim the
  // still-`waiting` task mid-flight and synthesise it twice.
  const auditionWorker = config.worker.enabled
    ? createAuditionWorker({
        auditionDao: daos.audition,
        auditionService: services.audition,
        leaseMs: config.audition.timeoutMs + 60000,
        intervalMs: config.worker.intervalMs,
        log
      })
    : null

  // Model clone (`preprocess_and_tran` + ASR) runs minutes-long, so its lease matches
  // the TTS timeout rather than the short video lease.
  const modelTaskWorker = config.worker.enabled
    ? createModelTaskWorker({
        modelTaskDao: daos.modelTask,
        modelService: services.model,
        leaseMs: config.tts.timeoutMs + 60000,
        intervalMs: config.worker.intervalMs,
        log
      })
    : null

  const auth = createAuthService({
    username: config.auth.username,
    passwordHash: config.auth.passwordHash
  })

  const app = createApp({ services, media, config, logger: log, worker, rqlite, auth })

  return { config, log, media, rqlite, daos, services, worker, reaper, auditionWorker, modelTaskWorker, auth, app }
}

async function main() {
  const context = buildContext()
  const { config, log, rqlite, worker, auditionWorker, modelTaskWorker, app } = context

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
  if (modelTaskWorker) modelTaskWorker.start()

  const server = http.createServer(app)
  server.listen(config.port, config.host, () => {
    log.info(`duix-avatar server listening on http://${config.host}:${config.port}`)
  })

  const shutdown = (signal) => {
    log.info(`${signal} received, shutting down`)
    if (worker) worker.stop()
    if (auditionWorker) auditionWorker.stop()
    if (modelTaskWorker) modelTaskWorker.stop()
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