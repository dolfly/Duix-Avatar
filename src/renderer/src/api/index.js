/**
 * Renderer API surface.
 *
 * The Electron build answers these calls over IPC (src/main/service/*.js); the web
 * build answers the same signatures over the server REST API (server/). Components
 * therefore need no changes between the desktop binary and the browser deployment.
 *
 * Differences the transport hides:
 * - `addModel` uploads a File (converted to H.264 + reference WAV with ffmpeg.wasm)
 *   instead of a local path.
 * - `saveVideo` sends the uploaded audio as multipart instead of copying a local file.
 * - `exportVideo` streams the file into a browser download.
 */
import { isDesktop } from '@renderer/client'
import { clearToken, getToken } from '@renderer/utils/auth.js'

const JSON_HEADERS = { 'Content-Type': 'application/json' }

function ipcRenderer() {
  return window.electron.ipcRenderer
}

function authHeaders(extra) {
  const headers = new Headers(extra || {})
  const token = getToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  return headers
}

function redirectToLoginIfUnauthorized(response, url) {
  if (response.status !== 401) return
  if (String(url).includes('/api/auth/login')) return
  clearToken()
  if (window.location.hash !== '#/login') window.location.hash = '#/login'
}

export async function http(url, options = {}) {
  const { responseType = 'text', ...fetchOptions } = options
  const response = await fetch(url, { ...fetchOptions, headers: authHeaders(options.headers) })
  redirectToLoginIfUnauthorized(response, url)
  if (!response.ok) {
    const text = await response.text()
    let message = text
    try {
      const parsed = text ? JSON.parse(text) : null
      message = (parsed && parsed.message) || text
    } catch {
      // non-JSON error body; keep the raw text
    }
    throw new Error(message || `请求失败 (${response.status})`)
  }
  if (responseType === 'blob') return response.blob()
  const text = await response.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  return data
}

function query(params) {
  const search = new URLSearchParams()
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value))
  })
  const encoded = search.toString()
  return encoded ? `?${encoded}` : ''
}

const httpApi = {
  videoPage: ({ page = 1, pageSize = 1, name = '' } = {}) =>
    http(`/api/videos${query({ page, pageSize, name })}`),

  findVideo: (id) => http(`/api/videos/${id}`),

  removeVideo: (id) => http(`/api/videos/${id}`, { method: 'DELETE' }),

  saveVideo: async (video) => {
    const audio = video.audio_path
    const hasFile = typeof Blob !== 'undefined' && audio instanceof Blob
    const body = {
      id: video.id,
      model_id: video.model_id,
      name: video.name,
      text_content: video.text_content,
      voice_id: video.voice_id
    }

    let result
    if (!hasFile) {
      result = await http('/api/videos', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) })
    } else {
      const form = new FormData()
      Object.entries(body).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== '') form.append(key, String(value))
      })
      form.append('audio', audio, audio.name || 'audio.wav')
      result = await http('/api/videos', { method: 'POST', body: form })
    }

    // Match the contract of `addModel` / `makeVideo` / `countVideo`: return the
    // numeric id, not the response body object. Previously this leaked `{ id: N }`,
    // which surfaced as `/api/videos/[object Object]/make` on the next step.
    return result ? result.id : false
  },

  makeVideo: async (id) => {
    const result = await http(`/api/videos/${id}/make`, { method: 'POST' })
    return result ? result.id : id
  },

  exportVideo: async (id, fileName = 'duix-avatar.mp4') => {
    const exportUrl = `/api/videos/${id}/export`
    const response = await fetch(exportUrl, { headers: authHeaders() })
    redirectToLoginIfUnauthorized(response, exportUrl)
    if (!response.ok) throw new Error(`导出失败 (${response.status})`)
    const blob = await response.blob()
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = fileName
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    setTimeout(() => URL.revokeObjectURL(url), 2000)
    return true
  },

  modifyVideo: (video) =>
    http(`/api/videos/${video.id}`, {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify(video)
    }),

  countVideo: async (name = '') => {
    const result = await http(`/api/videos/count${query({ name })}`)
    return result ? result.count : 0
  },

  modelPage: ({ page = 1, pageSize = 1, name = '' } = {}) =>
    http(`/api/models${query({ page, pageSize, name })}`),

  findModel: (id) => http(`/api/models/${id}`),

  /**
   * The model video is transcoded to H.264 and the reference audio is extracted in
   * the browser (ffmpeg.wasm), so no ffmpeg binary is needed anywhere.
   */
  addModel: async ({ name, videoPath }) => {
    if (!(typeof Blob !== 'undefined' && videoPath instanceof Blob)) {
      throw new Error('浏览器不支持文件上传')
    }
    const { toH264, extractAudio } = await import('@renderer/client/ffmpeg.js')
    const video = await toH264(videoPath)
    const audio = await extractAudio(video)
    const form = new FormData()
    form.append('name', name)
    form.append('video', video, video.name)
    form.append('audio', audio, audio.name)
    const result = await http('/api/models', { method: 'POST', body: form })
    return result ? result.id : false
  },

  countModel: async (name = '') => {
    const result = await http(`/api/models/count${query({ name })}`)
    return result ? result.count : 0
  },

  removeModel: (id) => http(`/api/models/${id}`, { method: 'DELETE' }),

  getContext: (key) => http(`/api/context/${encodeURIComponent(key)}`),

  saveContext: (key, val) =>
    http('/api/context', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ key, val }) }),

  audition: async (voiceId, text) => {
    const result = await http(`/api/voices/${voiceId}/audition`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ text })
    })
    return result // { taskId, status: 'waiting' }
  },

  auditionStatus: async (voiceId, taskId) => http(`/api/voices/${voiceId}/audition/${taskId}`),

  // The reference-audio preview lives behind auth, but an <audio> tag cannot send
  // the Authorization header. Fetch it with the token here and hand the component a
  // blob URL (the same pattern as `exportVideo`).
  voicePreview: async (audioPath) => {
    const blob = await http(audioPath, { responseType: 'blob' })
    return URL.createObjectURL(blob)
  }
}

const ipcApi = {
  videoPage: ({ page = 1, pageSize = 1, name = '' }) => ipcRenderer().invoke('video/page', { page, pageSize, name }),
  findVideo: (id) => ipcRenderer().invoke('video/find', id),
  removeVideo: (id) => ipcRenderer().invoke('video/remove', id),
  saveVideo: (video) => ipcRenderer().invoke('video/save', video),
  makeVideo: (id) => ipcRenderer().invoke('video/make', id),
  exportVideo: (id, outputPath) => ipcRenderer().invoke('video/export', id, outputPath),
  modifyVideo: (video) => ipcRenderer().invoke('video/modify', video),
  countVideo: (name = '') => ipcRenderer().invoke('video/count', name),

  modelPage: ({ page = 1, pageSize = 1, name = '' }) => ipcRenderer().invoke('model/page', { page, pageSize, name }),
  findModel: (id) => ipcRenderer().invoke('model/find', id),
  addModel: ({ name, videoPath }) => ipcRenderer().invoke('model/addModel', name, videoPath),
  countModel: (name = '') => ipcRenderer().invoke('model/count', name),
  removeModel: (id) => ipcRenderer().invoke('model/remove', id),

  getContext: (key) => ipcRenderer().invoke('context/get', key),
  saveContext: (key, val) => ipcRenderer().invoke('context/save', key, val),

  audition: (voiceId, text) => ipcRenderer().invoke('voice/audition', voiceId, text),
  auditionStatus: () => {},
  voicePreview: () => {}
}

const api = isDesktop ? ipcApi : httpApi

export const videoPage = api.videoPage
export const findVideo = api.findVideo
export const removeVideo = api.removeVideo
export const saveVideo = api.saveVideo
export const makeVideo = api.makeVideo
export const exportVideo = api.exportVideo
export const modifyVideo = api.modifyVideo
export const countVideo = api.countVideo

export const modelPage = api.modelPage
export const findModel = api.findModel
export const addModel = api.addModel
export const countModel = api.countModel
export const removeModel = api.removeModel

export const getContext = api.getContext
export const saveContext = api.saveContext

export const audition = api.audition
export const auditionStatus = api.auditionStatus

export const voicePreview = api.voicePreview

export default api