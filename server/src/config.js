import path from 'node:path'

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
      // Path prefix the TTS container sees for DATA_DIR/voice/data (its /code/data mount).
      remoteDataRoot: normalizeBaseUrl(env.TTS_REMOTE_DATA_ROOT, '/code/data')
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
      pollTimeoutMs: int(env.FACE2FACE_TIMEOUT_MS, 60 * 1000)
    }
  }
}

export default loadConfig