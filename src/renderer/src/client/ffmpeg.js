/**
 * Browser-side media conversion with ffmpeg.wasm.
 *
 * The desktop build shells out to a bundled ffmpeg/ffprobe binary
 * (src/main/util/ffmpeg.js) to (a) transcode a model video to H.264 and
 * (b) extract the reference WAV that trains the cloned voice. The web build has
 * no binary to ship and no filesystem to run it on, so both steps run in the
 * browser through @ffmpeg/ffmpeg.
 *
 * The wasm core is looked up on the same origin first (`/ffmpeg/ffmpeg-core.js`),
 * so a self-hosted deployment needs no internet access; if the file is not served
 * the module falls back to the pinned unpkg build.
 */
import { FFmpeg } from '@ffmpeg/ffmpeg'
import { fetchFile, toBlobURL } from '@ffmpeg/util'

/** Keep in sync with the @ffmpeg/core version vendored into the web image. */
const CORE_VERSION = '0.12.10'
const LOCAL_CORE_BASE = `${import.meta.env?.BASE_URL || '/'}ffmpeg`.replace(/\/{2,}/g, '/')
const CDN_CORE_BASE = `https://unpkg.com/@ffmpeg/core@${CORE_VERSION}/dist/esm`

let instance = null
let loading = null
const LOGS = []

function baseName(file) {
  return (file?.name || 'input').replace(/[^\w.-]/g, '_')
}

async function exists(url) {
  try {
    const response = await fetch(url, { method: 'HEAD' })
    return response.ok
  } catch {
    return false
  }
}

async function coreUrls() {
  // Local URLs carry the core version as a cache-busting query so that, when the
  // vendored core is updated, browsers and CDN caches (nginx serves them as
  // `immutable`) that hold the old build stop reusing it.
  const localCoreURL = `${LOCAL_CORE_BASE}/ffmpeg-core.js?v=${CORE_VERSION}`
  const localWasmURL = `${LOCAL_CORE_BASE}/ffmpeg-core.wasm?v=${CORE_VERSION}`
  if (await exists(localCoreURL)) {
    return { coreURL: localCoreURL, wasmURL: localWasmURL }
  }
  return {
    coreURL: await toBlobURL(`${CDN_CORE_BASE}/ffmpeg-core.js`, 'text/javascript'),
    wasmURL: await toBlobURL(`${CDN_CORE_BASE}/ffmpeg-core.wasm`, 'application/wasm')
  }
}

async function getFFmpeg() {
  if (instance) return instance
  if (!loading) {
    loading = (async () => {
      const ffmpeg = new FFmpeg()
      ffmpeg.on('log', ({ message }) => {
        LOGS.push(message)
        if (LOGS.length > 200) LOGS.shift()
      })
      const urls = await coreUrls()
      await ffmpeg.load(urls)
      instance = ffmpeg
      return ffmpeg
    })()
    loading.catch(() => {
      loading = null
    })
  }
  return loading
}

/**
 * Transcode to H.264 / yuv420p, matching the desktop `toH264` (video only, the
 * reference audio is extracted separately so it can be uploaded next to it).
 */
export async function toH264(file, onProgress) {
  const ffmpeg = await getFFmpeg()
  const input = `in-${baseName(file)}`
  const output = 'model-h264.mp4'

  const progressHandler = ({ progress }) => {
    if (typeof onProgress === 'function') onProgress(Math.min(1, Math.max(0, progress || 0)))
  }
  if (onProgress) ffmpeg.on('progress', progressHandler)

  try {
    await ffmpeg.writeFile(input, await fetchFile(file))
    const code = await ffmpeg.exec([
      '-i',
      input,
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '23',
      '-pix_fmt',
      'yuv420p',
      '-an',
      '-movflags',
      '+faststart',
      output
    ])
    if (code !== 0) throw new Error(`视频转码失败 (ffmpeg exit ${code})`)
    const data = await ffmpeg.readFile(output)
    return new File([data], output, { type: 'video/mp4' })
  } finally {
    if (onProgress) ffmpeg.off('progress', progressHandler)
    await Promise.allSettled([ffmpeg.deleteFile(input), ffmpeg.deleteFile(output)])
  }
}

/**
 * Extract the reference audio the TTS service trains on, matching the desktop
 * `extractAudio` (`.noVideo()` into a wav container).
 */
export async function extractAudio(file) {
  const ffmpeg = await getFFmpeg()
  const input = `in-${baseName(file)}`
  const output = 'model-audio.wav'

  try {
    await ffmpeg.writeFile(input, await fetchFile(file))
    const code = await ffmpeg.exec(['-i', input, '-vn', output])
    if (code !== 0) throw new Error(`音频提取失败 (ffmpeg exit ${code})`)
    const data = await ffmpeg.readFile(output)
    return new File([data], output, { type: 'audio/wav' })
  } finally {
    await Promise.allSettled([ffmpeg.deleteFile(input), ffmpeg.deleteFile(output)])
  }
}

/**
 * ffprobe replacement: run `ffmpeg -i` and read the banner back from the log.
 * Used when the browser cannot demux a container itself (e.g. a phone's MOV).
 */
export async function probeWithFFmpeg(file, kind = 'video') {
  const ffmpeg = await getFFmpeg()
  const input = `probe-${baseName(file)}`
  let banner = ''
  const logHandler = ({ message }) => {
    banner += `${message}\n`
  }
  ffmpeg.on('log', logHandler)

  try {
    await ffmpeg.writeFile(input, await fetchFile(file))
    // No output file: ffmpeg prints the stream info and exits non-zero.
    await ffmpeg.exec(['-i', input])
  } catch {
    // Expected: the banner is what we are after.
  } finally {
    ffmpeg.off('log', logHandler)
    await Promise.allSettled([ffmpeg.deleteFile(input)])
  }

  const durationMatch = banner.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
  const duration = durationMatch
    ? Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3])
    : 0
  const videoMatch = banner.match(/Video:.*?(\d{2,5})x(\d{2,5})/)

  if (!duration && !videoMatch) {
    return { isOK: false, msg: '无法解析该文件，请确认格式受支持（MP4/MOV/MP3/WAV 等）' }
  }
  return {
    isOK: true,
    name: file.name,
    kind,
    duration,
    width: videoMatch ? Number(videoMatch[1]) : 0,
    height: videoMatch ? Number(videoMatch[2]) : 0,
    size: file.size
  }
}

export default { toH264, extractAudio, probeWithFFmpeg }