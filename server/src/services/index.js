import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

/**
 * Service layer: the use cases the web UI needs, ported from the desktop client's
 * src/main/service/*.js. Everything that used to reach into Electron (ipcMain, app
 * paths, better-sqlite3, the ffmpeg binary) is injected instead.
 */

const DEFAULT_TTS_PARAMS = {
  format: 'wav',
  top_p: 0.7,
  max_new_tokens: 1024,
  chunk_length: 100,
  repetition_penalty: 1.2,
  temperature: 0.7,
  need_asr: false,
  streaming: false,
  is_fixed_seed: 0,
  is_norm: 1
}

export function createContextService({ contextDao }) {
  return {
    async list() {
      return contextDao.selectAll()
    },

    async get(key) {
      return contextDao.findByKey(key)
    },

    async save(key, val) {
      const existing = await contextDao.findByKey(key)
      if (existing) {
        await contextDao.update(key, val)
        return { key, val }
      }
      await contextDao.insert(key, val)
      return { key, val }
    }
  }
}

/**
 * @param {object} deps
 * @param {object} deps.modelDao
 * @param {object} deps.voiceDao
 * @param {object} deps.tts  TTS client (preprocessAndTran / makeAudio)
 * @param {object} deps.media media store
 * @param {string} [deps.defaultLang]
 */
export function createModelService({ modelDao, voiceDao, tts, media, log, defaultLang = 'zh' }) {
  async function add({ name, videoFile, audioFile, lang = defaultLang }) {
    if (!name) throw httpError(400, '模特名称不能为空')
    if (!videoFile) throw httpError(400, '缺少模特视频文件')
    if (!audioFile) throw httpError(400, '缺少参考音频文件')

    media.ensureDirs()

    const videoExt = extensionOf(videoFile.originalname, '.mp4')
    const audioExt = extensionOf(audioFile.originalname, '.wav')
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 17)
    const videoRelative = media.copyToTemp(videoFile.path, `${stamp}${videoExt}`)
    const audioRelative = media.copyToOriginAudio(audioFile.path, `${stamp}${audioExt}`)

    try {
      const result = await tts.preprocessAndTran({
        format: audioExt.replace(/^\./, ''),
        reference_audio: media.toTtsRemotePath(audioRelative),
        lang
      })

      if (!result || Number(result.code) !== 0) {
        const message = result?.msg || `TTS 声音复刻失败: ${JSON.stringify(result)}`
        throw httpError(502, message)
      }

      const voiceId = await voiceDao.insert({
        originAudioPath: audioRelative,
        lang,
        asrFormatAudioUrl: result.asr_format_audio_url,
        referenceAudioText: result.reference_audio_text
      })

      return await modelDao.insert({
        name,
        videoPath: videoRelative,
        audioPath: audioRelative,
        voiceId
      })
    } catch (error) {
      media.remove(videoRelative)
      media.removeTts(audioRelative)
      throw error
    } finally {
      removeUploads(media, [videoFile, audioFile], log)
    }
  }

  async function page({ page = 1, pageSize = 10, name = '' } = {}) {
    const [total, rows] = await Promise.all([modelDao.count(name), modelDao.selectPage({ page, pageSize, name })])
    return {
      total,
      list: rows.map((row) => toModelDto(row))
    }
  }

  async function count(name = '') {
    return modelDao.count(name)
  }

  async function find(id) {
    const row = await modelDao.selectByID(id)
    if (!row) return null
    return toModelDto(row)
  }

  async function remove(id) {
    const row = await modelDao.selectByID(id)
    if (!row) return false
    if (row.video_path) media.remove(row.video_path)
    if (row.audio_path) media.removeTts(row.audio_path)
    await modelDao.remove(id)
    return true
  }

  return { add, page, count, find, remove }
}

function toModelDto(row) {
  const voiceId = row.voice_id ?? null
  return {
    id: row.id,
    name: row.name,
    voice_id: voiceId,
    created_at: row.created_at,
    // Root-relative media URLs the browser can load.
    video_path: `/api/files/${row.video_path || ''}`,
    audio_path: voiceId ? `/api/voices/${voiceId}/preview` : null,
    video_file: row.video_path || null,
    audio_file: row.audio_path || null
  }
}

export function createVoiceService({ voiceDao, tts, media, log }) {
  async function list() {
    const rows = await voiceDao.selectAll()
    return rows.map((row) => ({
      id: row.id,
      lang: row.lang,
      created_at: row.created_at,
      reference_audio_text: row.reference_audio_text
    }))
  }

  async function find(id) {
    return voiceDao.selectByID(id)
  }

  /** Absolute path of a voice's reference audio (under the TTS data root) or null. */
  function referenceAudioPath(voice) {
    const relative = voice?.origin_audio_path ? String(voice.origin_audio_path).replace(/^\/+/, '') : ''
    if (!relative || relative.includes('..')) return null
    const target = path.resolve(media.ttsRoot, relative)
    if (!target.startsWith(path.resolve(media.ttsRoot) + path.sep)) return null
    return fs.existsSync(target) ? target : null
  }

  /** Synthesise `text`; returns the wav path relative to the face2face media root. */
  async function makeAudio({ voice, text, subDir = 'temp' }) {
    if (!voice) throw httpError(404, '音色不存在')
    const audio = await tts.makeAudio({
      ...DEFAULT_TTS_PARAMS,
      speaker: randomId(),
      text,
      reference_audio: voice.asr_format_audio_url,
      reference_text: voice.reference_audio_text
    })

    media.ensureDirs()
    const fileName = `${randomId()}.wav`
    const relative = subDir ? `${subDir}/${fileName}` : fileName
    await fsp.writeFile(media.safeResolve(relative), audio)
    return relative
  }

  return { list, find, referenceAudioPath, makeAudio }
}

/**
 * Audition (voice preview) tasks. `POST /api/voices/:id/audition` enqueues a task and
 * returns immediately; a background worker runs `synthesize` so the HTTP request never
 * outlives the EdgeOne 15s origin timeout (TTS takes minutes on the Pascal GPU).
 */
export function createAuditionService({ auditionDao, voiceService, log }) {
  async function create({ voiceId, text }) {
    const voice = await voiceService.find(voiceId)
    if (!voice) throw httpError(404, '音色不存在')
    if (!text) throw httpError(400, '试听文本不能为空')
    return auditionDao.insert({ voiceId, text })
  }

  async function find(id) {
    return toAuditionDto(await auditionDao.selectByID(id))
  }

  /** Synthesise the text for a claimed audition task. */
  async function synthesize(task) {
    await auditionDao.update(task.id, { message: '正在生成试听音频' })
    try {
      const voice = await voiceService.find(task.voice_id)
      if (!voice) {
        await auditionDao.updateStatus(task.id, 'failed', '音色不存在')
        return { status: 'failed' }
      }
      const relative = await voiceService.makeAudio({ voice, text: task.text })
      await auditionDao.update(task.id, { status: 'success', message: '', file_path: relative })
      return { status: 'success', filePath: relative }
    } catch (error) {
      log?.error?.(`audition ${task.id} 生成失败: ${error?.message || error}`)
      await auditionDao.updateStatus(task.id, 'failed', error?.message || '试听生成失败')
      return { status: 'failed' }
    }
  }

  return { create, find, synthesize }
}

function toAuditionDto(row) {
  if (!row) return null
  return {
    id: row.id,
    voice_id: row.voice_id,
    text: row.text,
    status: row.status,
    message: row.message,
    created_at: row.created_at,
    audioPath: row.status === 'success' && row.file_path ? `/api/files/${row.file_path}` : null,
    file_name: row.file_path || null
  }
}

export function createVideoService({ videoDao, modelDao, voiceService, media, tts, face2face, log }) {
  async function page({ page = 1, pageSize = 10, name = '' } = {}) {
    const [total, rows, waiting] = await Promise.all([
      videoDao.count(name),
      videoDao.selectPage({ page, pageSize, name }),
      videoDao.selectByStatus('waiting')
    ])
    const waitingIds = waiting.map((row) => row.id)
    return {
      total,
      list: rows.map((row) => toVideoDto(row, { media, waitingIds }))
    }
  }

  async function find(id) {
    const row = await videoDao.selectByID(id)
    if (!row) return null
    return toVideoDto(row, { media })
  }

  async function count(name = '') {
    return videoDao.count(name)
  }

  /**
   * Create or update a draft. `audio` is an uploaded file, `audioPath` an already
   * stored file relative to the media root.
   */
  async function save({ id, modelId, name, textContent, voiceId, audio, audioPath }) {
    // Defense in depth: the route already rejects malformed ids, but the service
    // must never turn one into a silent insert either. `undefined` means "create",
    // anything else has to be a positive integer.
    if (id !== undefined && !(Number.isInteger(id) && id > 0)) {
      throw httpError(400, '无效的视频 ID')
    }

    media.ensureDirs()

    let storedAudio = audioPath || null
    if (audio) {
      storedAudio = media.copyToTemp(audio.path, `${randomId()}${extensionOf(audio.originalname, '.wav')}`)
      removeUploads(media, [audio], log)
    }

    const existing = id ? await videoDao.selectByID(id) : null
    if (existing) {
      await videoDao.update(id, {
        model_id: modelId,
        name,
        text_content: textContent ?? '',
        voice_id: voiceId ?? null,
        audio_path: storedAudio
      })
      return id
    }

    return videoDao.insert({
      model_id: modelId,
      name,
      status: 'draft',
      text_content: textContent ?? '',
      voice_id: voiceId ?? null,
      audio_path: storedAudio,
      progress: 0
    })
  }

  async function modify(fields) {
    await videoDao.update(fields.id, fields)
    return fields.id
  }

  /** Queue a video for synthesis. */
  async function make(id) {
    await videoDao.update(id, { status: 'waiting', message: '', progress: 0 })
    return id
  }

  async function remove(id) {
    const row = await videoDao.selectByID(id)
    if (!row) return false
    if (row.file_path) media.remove(row.file_path)
    else if (row.audio_path) media.remove(row.audio_path)
    await videoDao.remove(id)
    return true
  }

  /** Submit one waiting video to the GPU services (worker holds the claim). */
  async function synthesize(video) {
    await videoDao.update(video.id, { message: '准备合成任务', progress: 0 })

    const model = await modelDao.selectByID(video.model_id)
    if (!model) {
      await videoDao.updateStatus(video.id, 'failed', '模特不存在或已被删除')
      return { status: 'failed' }
    }

    let audioRelative = video.audio_path
    if (!audioRelative) {
      const voiceId = video.voice_id ?? model.voice_id
      const voice = voiceId ? await voiceService.find(voiceId) : null
      if (!voice) {
        await videoDao.updateStatus(video.id, 'failed', '未选择音色或音色已被删除')
        return { status: 'failed' }
      }
      audioRelative = await voiceService.makeAudio({ voice, text: video.text_content })
    }

    const code = randomId()
    const param = {
      audio_url: media.toFace2faceRemotePath(audioRelative),
      video_url: media.toFace2faceRemotePath(model.video_path),
      code,
      pn: 1
    }

    try {
      const result = await face2face.submit(param)
      const ok = Number(result?.code) === 10000
      await videoDao.update(video.id, {
        status: ok ? 'pending' : 'failed',
        audio_path: audioRelative,
        param,
        code,
        message: ok ? '已提交合成任务' : result?.msg || '提交合成任务失败',
        progress: 0,
        file_path: ''
      })
      return { status: ok ? 'pending' : 'failed', code, result }
    } catch (error) {
      log?.error?.(`video ${video.id} 提交合成任务失败: ${error?.message || error}`)
      await videoDao.update(video.id, {
        status: 'failed',
        audio_path: audioRelative,
        code,
        message: `提交合成任务失败: ${error?.message || error}`
      })
      return { status: 'failed', code }
    }
  }

  /** Poll one submitted video and persist the transition. */
  async function poll(video) {
    if (!video.code) {
      await videoDao.updateStatus(video.id, 'failed', '缺少任务编号，无法查询合成进度')
      return { status: 'failed' }
    }

    let result
    try {
      result = await face2face.query(video.code)
    } catch (error) {
      log?.warn?.(`video ${video.id} 查询进度失败: ${error?.message || error}`)
      return { status: 'pending' }
    }

    const code = Number(result?.code)
    if ([9999, 10002, 10003].includes(code)) {
      await videoDao.updateStatus(video.id, 'failed', result?.msg || `合成失败(${code})`)
      return { status: 'failed' }
    }

    if (code !== 10000) {
      log?.warn?.(`video ${video.id} 返回未知状态码: ${code}`)
      return { status: 'pending' }
    }

    const data = result.data || {}
    if (Number(data.status) === 1) {
      await videoDao.update(video.id, {
        status: 'pending',
        message: data.msg || '合成中',
        progress: Number(data.progress || 0)
      })
      return { status: 'pending' }
    }

    if (Number(data.status) === 2) {
      const fileRelative = normalizeResultPath(data.result)
      if (!fileRelative) {
        await videoDao.updateStatus(video.id, 'failed', '合成完成但缺少结果文件')
        return { status: 'failed' }
      }
      const duration = media.probeDuration(fileRelative)
      await videoDao.update(video.id, {
        status: 'success',
        message: data.msg || '合成完成',
        progress: 100,
        file_path: fileRelative,
        duration: duration ?? 0
      })
      return { status: 'success' }
    }

    await videoDao.updateStatus(video.id, 'failed', data.msg || '合成失败')
    return { status: 'failed' }
  }

  return { page, find, count, save, modify, make, remove, synthesize, poll }
}

function toVideoDto(row, { media, waitingIds = [] }) {
  const status = row.status
  let progress = row.progress ?? 0
  if (status === 'waiting') {
    const index = waitingIds.indexOf(row.id)
    progress = index >= 0 ? `${index + 1} / ${waitingIds.length}` : '0 / 0'
  }

  const absolute = (relative, options) =>
    relative ? `/api/files/${relative}${options?.download ? '?download=1' : ''}` : null

  return {
    id: row.id,
    name: row.name,
    status,
    message: row.message,
    model_id: row.model_id,
    voice_id: row.voice_id,
    text_content: row.text_content,
    created_at: row.created_at,
    progress,
    duration: row.duration ?? 0,
    param: row.param || null,
    code: row.code || null,
    file_path: status === 'success' ? absolute(row.file_path) : null,
    file_name: row.file_path || null,
    audio_path: row.audio_path ? absolute(row.audio_path) : null,
    has_audio: Boolean(row.audio_path),
    download_url: status === 'success' ? absolute(row.file_path, { download: true }) : null
  }
}

export function normalizeResultPath(result) {
  const cleaned = String(result || '').replace(/\\/g, '/').replace(/^\/+/, '')
  if (!cleaned) return ''
  return cleaned.startsWith('temp/') ? cleaned : `temp/${cleaned}`
}

export function randomId() {
  return globalThis.crypto?.randomUUID?.() || fallbackUuid()
}

function fallbackUuid() {
  const bytes = new Uint8Array(16)
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function extensionOf(fileName, fallback = '') {
  const match = String(fileName || '').match(/(\.[a-z0-9]+)$/i)
  return match ? match[1].toLowerCase() : fallback
}

export function httpError(status, message) {
  return Object.assign(new Error(message), { status })
}

function removeUploads(media, files, log) {
  for (const file of files || []) {
    if (!file?.path) continue
    try {
      fs.rmSync(file.path, { force: true })
    } catch (error) {
      log?.warn?.(`failed to remove upload ${file.path}: ${error?.message}`)
    }
  }
}