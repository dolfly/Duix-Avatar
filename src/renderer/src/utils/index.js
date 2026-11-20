import dayjs from 'dayjs'
import { isDesktop } from '@renderer/client'
export const handleShowMenu = (path) => {
  const MenuList = ['/video/edit', '/login']
  if (MenuList.find((item) => path.includes(item))) {
    return true
  } else {
    return false
  }
}

export const wait = (time = 0) => {
  return new Promise((resolve) => {
    setTimeout(resolve, time * 1000)
  })
}

const blobUrls = new WeakMap()

/**
 * Turn whatever the app stores in `video_path` / `audio_path` / `file_path` into a
 * URL an <img>/<video>/<audio> element can load.
 *
 * - Electron build: an absolute filesystem path becomes `file://…` (unchanged).
 * - Web build: `/api/...` paths, absolute URLs and object URLs are used as-is; a
 *   selected File/Blob is mapped to a stable object URL.
 */
export const localUrl = {
  addFileProtocol(url) {
    if (!url) return url

    if (typeof Blob !== 'undefined' && url instanceof Blob) {
      if (!blobUrls.has(url)) blobUrls.set(url, URL.createObjectURL(url))
      return blobUrls.get(url)
    }

    const value = String(url)
    if (value.startsWith('file:')) return value
    if (!isDesktop) return value
    return `file://${value.replaceAll('\\', '/')}`
  },

  delFileProtocol(url) {
    return url && String(url).replace('file://', '')
  }
}


export const formatDate = (time = new Date(), pattern = 'YYYY-MM-DD HH:mm:ss') => {
  return dayjs(time).format(pattern)
}

export const millisecondsToTime = (milliseconds) => {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const remainingSecondsAfterHours = totalSeconds % 3600;
  const minutes = Math.floor(remainingSecondsAfterHours / 60);
  const seconds = remainingSecondsAfterHours % 60;
  const formattedHours = String(hours).padStart(2, '0');
  const formattedMinutes = String(minutes).padStart(2, '0');
  const formattedSeconds = String(seconds).padStart(2, '0');
  return `${formattedHours}:${formattedMinutes}:${formattedSeconds}`;
}

export const getUniqueId = () => {
  return Date.now() + Math.random().toString(36).substring(2, 15)
}
