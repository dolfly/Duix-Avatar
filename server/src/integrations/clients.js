import axios from 'axios'

/**
 * HTTP clients for the two upstream GPU services. They are unchanged from the desktop
 * client (src/main/api/*.js) - only the base urls now come from configuration, and the
 * gen-video payloads carry container-side paths.
 */

export function createTtsClient({ baseUrl, timeoutMs, http = axios, log }) {
  const instance = http.create({
    baseURL: baseUrl,
    timeout: timeoutMs,
    // TTS returns raw wav bytes for /v1/invoke
    responseType: 'arraybuffer'
  })

  return {
    /**
     * Clone a voice from a reference audio file.
     * @param {{format: string, reference_audio: string, lang: string}} param reference_audio
     *   is relative to the TTS data root (e.g. origin_audio/xxx.wav)
     */
    async preprocessAndTran(param) {
      log?.debug?.('tts preprocess_and_tran', param)
      const { data } = await instance.post('/v1/preprocess_and_tran', param, { responseType: 'json' })
      return data
    },

    /**
     * Synthesise an audio file.
     * @returns {Promise<Buffer>} wav bytes
     */
    async makeAudio(param) {
      log?.debug?.('tts invoke', { ...param, text: truncate(param.text) })
      const { data } = await instance.post('/v1/invoke', param, { responseType: 'arraybuffer' })
      return Buffer.isBuffer(data) ? data : Buffer.from(data)
    }
  }
}

export function createFace2faceClient({ baseUrl, timeoutMs, http = axios, log, chaofen = 0, watermarkSwitch = 0 }) {
  const instance = http.create({ baseURL: baseUrl, timeout: timeoutMs })

  return {
    /**
     * Submit a face2face job.
     * @param {{audio_url: string, video_url: string, code: string, pn: number}} param
     */
    async submit(param) {
      log?.debug?.('face2face submit', { ...param, code: param.code })
      const { data } = await instance.post('/submit', {
        chaofen,
        watermark_switch: watermarkSwitch,
        ...param
      })
      return data
    },

    /** Query job status by the code generated at submit time. */
    async query(code) {
      const { data } = await instance.get('/query', { params: { code } })
      log?.debug?.('face2face query', code, data)
      return data
    }
  }
}

function truncate(text, max = 40) {
  const value = String(text ?? '')
  return value.length > max ? `${value.slice(0, max)}...` : value
}

export default { createTtsClient, createFace2faceClient }