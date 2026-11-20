/**
 * Browser implementation of the desktop bridge (`window.client`).
 *
 * The Electron build resolves the same API from `window.client` (see ./index.js);
 * in the web build these functions replace the native dialogs, the ffprobe based
 * media inspection and the window controls with their browser equivalents.
 *
 * `selectVideo()` / `selectAudio()` / `selectImage()` resolve to a `File`, which the
 * api layer uploads (and, for models, converts with ffmpeg.wasm) instead of a path.
 */

const IMAGE_ACCEPT = 'image/jpeg,image/png'
const VIDEO_ACCEPT = 'video/mp4,video/quicktime,video/*'
const AUDIO_ACCEPT = 'audio/mpeg,audio/wav,audio/x-wav,audio/flac,audio/mp4,audio/*'

function pickFile({ accept, multiple = false }) {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.multiple = multiple
    input.style.display = 'none'
    // Safari only opens the picker for a node that is in the document.
    document.body.appendChild(input)

    let settled = false
    const finish = (file) => {
      if (settled) return
      settled = true
      window.removeEventListener('focus', onFocus)
      input.remove()
      resolve(file || null)
    }

    input.addEventListener('change', () => {
      finish(input.files && input.files.length ? input.files[0] : null)
    })

    // Cancelling the picker fires no `change` event in most browsers; the window
    // regains focus, which is a good enough signal to stop waiting.
    const onFocus = () => {
      setTimeout(() => {
        if (!settled && (!input.files || input.files.length === 0)) finish(null)
      }, 500)
    }
    window.addEventListener('focus', onFocus)
    input.click()
  })
}

function objectUrl(file) {
  return URL.createObjectURL(file)
}

/**
 * Read duration (and dimensions) from a media file.
 *
 * The browser media element handles the formats the web build itself produces
 * (H.264 MP4 / WAV). For containers it cannot demux - MOV from a phone, for
 * instance - the metadata probe is retried through ffmpeg.wasm, so the desktop
 * "ffprobe" check keeps working without a native binary.
 */
function probeMediaElement(file, kind) {
  return new Promise((resolve) => {
    const url = objectUrl(file)
    const el = document.createElement(kind)
    el.preload = 'metadata'

    const settle = (result) => {
      el.removeAttribute('src')
      URL.revokeObjectURL(url)
      resolve(result)
    }

    el.addEventListener('loadedmetadata', () => {
      settle({
        isOK: true,
        name: file.name,
        duration: Number.isFinite(el.duration) ? el.duration : 0,
        width: el.videoWidth || 0,
        height: el.videoHeight || 0,
        size: file.size
      })
    })
    el.addEventListener('error', () => {
      settle({ isOK: false, msg: `${file.name} 无法被浏览器解析` })
    })
    el.src = url
  })
}

export function createWebClient() {
  return {
    file: {
      selectFile: (filter = {}) => pickFile({ accept: filter.accept || '' }),

      selectImage: () => pickFile({ accept: IMAGE_ACCEPT }),

      selectVideo: () => pickFile({ accept: VIDEO_ACCEPT }),

      selectAudio: () => pickFile({ accept: AUDIO_ACCEPT }),

      async getVideoInfo(file) {
        if (!file) return { isOK: false, msg: '未选择文件' }
        const info = await probeMediaElement(file, 'video')
        if (info.isOK) return info
        const { probeWithFFmpeg } = await import('./ffmpeg.js')
        return probeWithFFmpeg(file, 'video')
      },

      async getAudioInfo(file) {
        if (!file) return { isOK: false, msg: '未选择文件' }
        const info = await probeMediaElement(file, 'audio')
        if (info.isOK) return info
        const { probeWithFFmpeg } = await import('./ffmpeg.js')
        return probeWithFFmpeg(file, 'audio')
      },

      /**
       * The web build has no native save dialog: `exportVideo` streams the file and
       * the browser's own download manager asks the user where to put it.
       */
      saveFile: async (defaultPath = '') => defaultPath || 'duix-avatar'
    },

    app: {
      // No window frame in the browser; these keep the header markup working.
      isMaximized: async () => false,
      minimize: async () => {},
      maximize: async () => {},
      close: async () => {},
      openLog: async () => {
        // In the browser the log panel lives inside the app (see LogPanel.vue),
        // so notify the UI layer instead of opening a raw JSON tab.
        window.dispatchEvent(new CustomEvent('duix:open-log-panel'))
      }
    }
  }
}

export default createWebClient