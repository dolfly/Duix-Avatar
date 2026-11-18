/**
 * Local stand-ins for the three GPU services (TTS, ASR, gen-video) so the web stack
 * can be exercised without a GPU box:
 *
 *   node scripts/dev-stub-services.mjs            # listens on 18180 / 8383 / 10095
 *   npm run dev:web                               # in another shell
 *
 * The stub returns deterministic answers and, for gen-video, copies the submitted
 * audio to `result.mp4` so the video can be downloaded and previewed.
 * It is for development only - never deploy it.
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const DATA_ROOT = process.env.STUB_DATA_ROOT || path.join(process.cwd(), '.devdata')
// gen-video container mount: the service reports paths under its own /code/data root, which is
// DATA_ROOT/face2face on the host.
const FACE2FACE = path.join(DATA_ROOT, 'face2face', 'temp')
const REMOTE_PREFIX = '/code/data/'
fs.mkdirSync(FACE2FACE, { recursive: true })

/** Map a path as the GPU container sees it back to the host/data layout. */
function localFromRemote(value) {
  const raw = String(value || '')
  if (raw.startsWith(REMOTE_PREFIX)) {
    return path.join(DATA_ROOT, 'face2face', raw.slice(REMOTE_PREFIX.length))
  }
  if (path.isAbsolute(raw) && fs.existsSync(raw)) return raw
  return path.join(DATA_ROOT, raw)
}

function wav(seconds = 1) {
  const sampleRate = 16000
  const samples = Math.floor(sampleRate * seconds)
  const buffer = Buffer.alloc(44 + samples * 2)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(buffer.length - 8, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(samples * 2, 40)
  return buffer
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks)
      if (!raw.length) return resolve({})
      try {
        resolve(JSON.parse(raw.toString('utf8')))
      } catch {
        resolve({ raw })
      }
    })
  })
}

function json(res, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
  res.end(body)
}

const tts = http.createServer(async (req, res) => {
  const body = await readBody(req)
  if (req.url.startsWith('/v1/preprocess_and_tran')) {
    console.log('[tts] preprocess_and_tran', body)
    return json(res, {
      code: 0,
      msg: 'success',
      asr_format_audio_url: body.reference_audio,
      reference_audio_text: 'stub reference text'
    })
  }
  if (req.url.startsWith('/v1/invoke')) {
    console.log('[tts] invoke', { text: body.text, speaker: body.speaker })
    const audio = wav(Math.min(10, Math.max(1, String(body.text || '').length / 5)))
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': audio.length })
    return res.end(audio)
  }
  res.writeHead(404).end()
})

const genVideo = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  if (req.method === 'POST' && url.pathname === '/easy/submit') {
    const body = await readBody(req)
    console.log('[gen-video] submit', body)
    // The service asks for a specific code and expects <code>.mp4 in this directory.
    const code = String(body.code || `stub-${Date.now()}`)
    const target = path.join(FACE2FACE, `${code}.mp4`)
    try {
      if (body.audio_url) {
        const audioLocal = localFromRemote(body.audio_url)
        if (fs.existsSync(audioLocal)) fs.copyFileSync(audioLocal, target)
      }
    } catch (error) {
      console.warn('[gen-video] could not copy audio:', error.message)
    }
    if (!fs.existsSync(target)) fs.writeFileSync(target, Buffer.from('stub mp4 payload'))
    return json(res, { code: 10000, msg: 'success', data: { code } })
  }
  if (req.method === 'GET' && url.pathname === '/easy/query') {
    const code = String(url.searchParams.get('code') || '')
    return json(res, {
      code: 10000,
      msg: 'success',
      data: { status: 2, progress: 1, result: `${code}.mp4`, msg: 'done' }
    })
  }
  res.writeHead(404).end()
})

tts.listen(Number(process.env.STUB_TTS_PORT || 18180), () => console.log('[stub] tts  on :18180'))
genVideo.listen(Number(process.env.STUB_GEN_PORT || 8383), () => console.log('[stub] gen  on :8383'))
console.log('[stub] data root:', DATA_ROOT)