import fs from 'node:fs'
import path from 'node:path'
import { readMp4Duration } from './mp4-duration.js'

/**
 * Filesystem layout (relative to DATA_DIR):
 *
 *   $DATA_DIR/face2face/          -> mounted into the gen-video container at $FACE2FACE_REMOTE_DATA_ROOT
 *     temp/                       -> model videos, generated audio and results
 *   $DATA_DIR/voice/data/         -> mounted into the TTS container at $TTS_REMOTE_DATA_ROOT
 *     origin_audio/               -> audio uploaded for voice cloning
 *
 * Relative paths are what the database stores; absolute paths never reach the database so
 * the same database can be moved between hosts.
 */
export function createMediaStore({ dataDir, face2face, tts, publicBaseUrl = '', baseUrl } = {}) {
  const root = path.resolve(dataDir)
  const face2faceRoot = path.join(root, 'face2face')
  const tempDir = path.join(face2faceRoot, 'temp')
  const ttsRoot = path.join(root, 'voice', 'data')
  const originAudioDir = path.join(ttsRoot, 'origin_audio')
  function ensureDirs() {
    for (const dir of [face2faceRoot, tempDir, ttsRoot, originAudioDir]) {
      fs.mkdirSync(dir, { recursive: true })
    }
  }

  function resolve(relative) {
    return path.join(face2faceRoot, relative)
  }

  /**
   * Resolve a request supplied relative path against the media root.
   * Throws when the result escapes the root (path traversal).
   */
  function safeResolve(relative) {
    const target = path.resolve(face2faceRoot, relative)
    if (target !== face2faceRoot && !target.startsWith(face2faceRoot + path.sep)) {
      throw new Error(`path escapes media root: ${relative}`)
    }
    return target
  }

  function exists(relative) {
    if (!relative) return false
    try {
      return fs.statSync(safeResolve(relative)).isFile()
    } catch {
      return false
    }
  }

  /** Remove a media file, ignoring missing files and traversal attempts. */
  function remove(relative) {
    if (!relative) return false
    try {
      fs.rmSync(safeResolve(relative), { force: true })
      return true
    } catch {
      return false
    }
  }

  function copyToTemp(sourcePath, fileName) {
    const target = path.join(tempDir, fileName)
    fs.copyFileSync(sourcePath, target)
    return path.relative(face2faceRoot, target).split(path.sep).join('/')
  }

  /** Copy a reference audio into the TTS data root; returns a path relative to the TTS root. */
  function copyToOriginAudio(sourcePath, fileName) {
    const target = path.join(originAudioDir, fileName)
    fs.copyFileSync(sourcePath, target)
    return path.relative(ttsRoot, target).split(path.sep).join('/')
  }

  /** Remove a file stored relative to the TTS data root. */
  function removeTts(relative) {
    if (!relative) return false
    try {
      const target = path.resolve(ttsRoot, relative)
      if (!target.startsWith(path.resolve(ttsRoot) + path.sep)) return false
      fs.rmSync(target, { force: true })
      return true
    } catch {
      return false
    }
  }

  /** Path as seen by the gen-video container (e.g. temp/<uuid>.mp4 -> /code/data/temp/<uuid>.mp4). */
  function toFace2faceRemotePath(relative) {
    return joinRemote(face2face.remoteDataRoot, relative)
  }

  /** Path as seen by the TTS container. */
  function toTtsRemotePath(relative) {
    return joinRemote(tts.remoteDataRoot, relative)
  }

  /** Read duration of a result mp4 (no ffmpeg involved). */
  function probeDuration(relative) {
    if (!relative) return null
    try {
      const buffer = fs.readFileSync(safeResolve(relative))
      return readMp4Duration(buffer)
    } catch {
      return null
    }
  }

  return {
    root,
    face2faceRoot,
    tempDir,
    ttsRoot,
    originAudioDir,
    ensureDirs,
    resolve,
    safeResolve,
    exists,
    remove,
    removeTts,
    copyToTemp,
    copyToOriginAudio,
    toFace2faceRemotePath,
    toTtsRemotePath,
    probeDuration
  }
}

function joinRemote(remoteRoot, relative) {
  const cleaned = String(relative || '').replace(/\\/g, '/').replace(/^\/+/, '')
  return `${remoteRoot}/${cleaned}`.replace(/\/{2,}/g, '/')
}

export default createMediaStore