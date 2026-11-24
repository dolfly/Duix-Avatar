import path from 'node:path'

import { hashPassword } from './auth.js'

function int(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

function bool(value, fallback = false) {
  if (value === undefined || value === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase())
}

/**
 * Normalise a base url: trim trailing slashes, keep any path prefix (e.g. http://host:8383/easy).
 */
export function normalizeBaseUrl(value, fallback) {
  const raw = (value || fallback || '').trim()
  return raw.replace(/\/+$/, '')
}

export function loadConfig(env = process.env) {
  const dataDir = path.resolve(env.DATA_DIR || path.join(process.cwd(), 'data'))

  // Web auth. The browser deployment requires a login, so refuse to start without
  // credentials (fail fast) rather than silently serving an unprotected API.
  // AUTH_PASSWORD_HASH (a pre-computed scrypt hash) is preferred; AUTH_PASSWORD
  // (plaintext) is hashed here at startup for convenience. Only the hash is kept.
  const authUsername = env.AUTH_USERNAME || ''
  const authPasswordHash = env.AUTH_PASSWORD_HASH || ''
  const authPassword = env.AUTH_PASSWORD || ''
  if (!authUsername || (!authPasswordHash && !authPassword)) {
    throw new Error(
      'Web 鉴权未配置：请设置 AUTH_USERNAME 与 AUTH_PASSWORD_HASH（或 AUTH_PASSWORD）。' +
        ' 浏览器部署要求登录后才能访问，拒绝在无凭据的情况下静默启动。'
    )
  }

  const face2faceBaseUrl = normalizeBaseUrl(env.FACE2FACE_BASE_URL, 'http://127.0.0.1:8383/easy')
  const ttsBaseUrl = normalizeBaseUrl(env.TTS_BASE_URL, 'http://127.0.0.1:18180')
  const rqliteUrl = normalizeBaseUrl(env.RQLITE_URL, 'http://127.0.0.1:4001')

  return {
    env: env.NODE_ENV || 'production',
    host: env.HOST || '0.0.0.0',
    port: int(env.PORT, 8280),
    logLevel: env.LOG_LEVEL || 'info',
    dataDir,
    publicBaseUrl: normalizeBaseUrl(env.PUBLIC_BASE_URL, ''),
    upload: {
      maxFileBytes: int(env.MAX_UPLOAD_MB, 1024) * 1024 * 1024
    },
    rqlite: {
      url: rqliteUrl,
      // rqlite read consistency level: none | weak | strong | all
      level: env.RQLITE_LEVEL || 'weak',
      timeoutMs: int(env.RQLITE_TIMEOUT_MS, 15000),
      retry: int(env.RQLITE_RETRY, 3)
    },
    tts: {
      baseUrl: ttsBaseUrl,
      timeoutMs: int(env.TTS_TIMEOUT_MS, 15 * 60 * 1000),
      // Path prefix the server sends to the TTS service in `reference_audio`. The TTS
      // image prepends its own media_path `/code/data`, so this must be a leading-slash
      // path RELATIVE to that root. Default `/` -> `/origin_audio/x.wav` -> the image
      // resolves `/code/data/origin_audio/x.wav`. `/code/data` here would double-prefix.
      remoteDataRoot: normalizeBaseUrl(env.TTS_REMOTE_DATA_ROOT, '/'),
      // Concurrency gate (DO-124): how many TTS inferences may run at once. The TTS service
      // is a single process whose VRAM grows from ~1.75 GiB idle to ~3.6 GiB mid-synthesis;
      // two concurrent syntheses would double that on the shared card (the DO-118 shape).
      // 1 => only one synthesis in flight, the rest queue FIFO (never dropped, never failed).
      maxInflight: int(env.TTS_MAX_INFLIGHT, 1)
    },
    audition: {
      // A voice audition is a preview, not a full synthesis: cap the accepted text so
      // a 500+-character script can no longer occupy the GPU for hours (and, once
      // thermal-throttled, drag every queued audition past its timeout). Longer text is
      // rejected immediately with a clear message instead of timing out after minutes.
      maxChars: int(env.AUDITION_MAX_CHARS, 200),
      // Per-request wall for the audition TTS call. Much shorter than TTS_TIMEOUT_MS:
      // a hung synthesis is aborted instead of burning the card for 15 minutes.
      timeoutMs: int(env.AUDITION_TIMEOUT_MS, 10 * 60 * 1000)
    },
    face2face: {
      baseUrl: face2faceBaseUrl,
      timeoutMs: int(env.FACE2FACE_TIMEOUT_MS, 60 * 1000),
      // Path prefix the gen-video container sees for DATA_DIR/face2face (its /code/data mount).
      remoteDataRoot: normalizeBaseUrl(env.FACE2FACE_REMOTE_DATA_ROOT, '/code/data'),
      chaofen: int(env.FACE2FACE_CHAOFEN, 0),
      watermarkSwitch: int(env.FACE2FACE_WATERMARK_SWITCH, 0)
    },
    worker: {
      enabled: bool(env.WORKER_ENABLED, true),
      intervalMs: int(env.WORKER_INTERVAL_MS, 2000),
      // A claimed task is leased for this long before another instance may retry it.
      leaseMs: int(env.WORKER_LEASE_MS, 120000),
      // Max tasks concurrently inside the GPU pipeline (submitting + pending). gen-video
      // is a single process, one thread per submit, on a single card, so 1 is the safe
      // default: concurrent inference would thrash the 8 GiB card.
      maxInflight: int(env.VIDEO_MAX_INFLIGHT, 1),
      // Hard wall from first claim to a terminal status (TTS + submit + poll). A task
      // that outlives this is marked failed by the worker so it can't occupy the queue
      // and the card forever. TTS is the long pole (minutes), so 30 min is generous.
      taskTimeoutMs: int(env.VIDEO_TASK_TIMEOUT_MS, 30 * 60 * 1000),
      pollTimeoutMs: int(env.FACE2FACE_TIMEOUT_MS, 60 * 1000)
    },
    gpu: {
      // Admission check before submit: don't submit when the target card can't fit
      // another inference. Fail-closed (cannot determine -> don't submit). Disable only
      // on hosts where the probe cannot run (see doc/web-deployment.md).
      vramCheck: bool(env.VIDEO_VRAM_CHECK, true),
      minFreeVramMb: int(env.VIDEO_MIN_FREE_VRAM_MB, 2048),
      smiBin: env.NVIDIA_SMI_BIN || 'nvidia-smi',
      probeTimeoutMs: int(env.VIDEO_VRAM_PROBE_TIMEOUT_MS, 5000)
    },
    auth: {
      username: authUsername,
      passwordHash: authPasswordHash || hashPassword(authPassword)
    }
  }
}

export default loadConfig