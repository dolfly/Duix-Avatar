/**
 * Platform bridge used by the renderer.
 *
 * - Electron build: the same `window.client` handlers as before (dialogs, ffprobe,
 *   window controls) exposed by src/preload/index.js.
 * - Web build: browser implementations (file picker, HTMLMediaElement metadata with
 *   ffmpeg.wasm fallback) from ./web.js.
 *
 * Components keep calling `Client.file.selectVideo()` etc. regardless of the build.
 */
import { createWebClient } from './web.js'

export const isDesktop =
  typeof window !== 'undefined' && Boolean(window.client && window.electron && window.electron.ipcRenderer)

function createElectronClient() {
  return {
    file: {
      ...window.client.file,
      selectFile: (filter = {}) => {
        return window.client.file.selectFile(filter)
      },
      selectImage: async () => {
        return window.client.file.selectFile({ name: 'Images', extensions: ['jpg', 'png', 'jpeg'] })
      },
      selectVideo: async () => {
        return window.client.file.selectFile({ name: 'Videos', extensions: ['mp4', 'mov'] })
      },
      selectAudio: async () => {
        return window.client.file.selectFile({ name: 'Audios', extensions: ['mp3', 'wav', 'flac', 'm4a'] })
      }
    },
    app: {
      ...window.client.app
    }
  }
}

export const Client = isDesktop ? createElectronClient() : createWebClient()

export default Client