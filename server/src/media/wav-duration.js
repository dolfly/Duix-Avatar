/**
 * Pure WAV duration probe.
 *
 * The TTS service returns raw WAV bytes (`voiceService.makeAudio` writes `<uuid>.wav`), and
 * the per-task timeout window is derived from the *real* audio length (DO-161). The web
 * deployment must not ship an ffmpeg/ffprobe binary, so the header is inspected directly:
 * `fmt ` carries the byte rate, `data` the payload size, and duration = dataSize / byteRate.
 *
 * Only the first bytes of the file are needed (the `fmt ` / `data` chunk headers sit at the
 * front of a RIFF file), so callers can pass a short header buffer plus the real file size.
 *
 * Returns seconds (float) or null when the buffer is not a readable PCM WAV.
 */

const HEADER = 12
const FMT_MIN = 16
/** 0xFFFFFFFF marks an unknown/streaming data size (also used by RF64). */
const UNKNOWN_SIZE = 0xffffffff

/**
 * @param {Buffer|Uint8Array} input first bytes of the file (at least the chunk headers)
 * @param {number} [fileSize] real file size in bytes; lets an unknown `data` size be derived
 * @returns {number|null} duration in seconds
 */
export function readWavDuration(input, fileSize) {
  const buffer = toBuffer(input)
  if (!buffer || buffer.length < HEADER) return null

  const magic = buffer.toString('latin1', 0, 4)
  if (magic !== 'RIFF' && magic !== 'RF64') return null
  if (buffer.toString('latin1', 8, 12) !== 'WAVE') return null

  let offset = HEADER
  let byteRate = 0

  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('latin1', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    const body = offset + 8

    if (id === 'fmt ') {
      if (body + FMT_MIN > buffer.length) return null
      byteRate = buffer.readUInt32LE(body + 8)
      if (!byteRate) {
        // Some encoders leave byteRate at 0; recompute it from the channel layout.
        const channels = buffer.readUInt16LE(body + 2)
        const sampleRate = buffer.readUInt32LE(body + 4)
        const bitsPerSample = buffer.readUInt16LE(body + 14)
        byteRate = channels * sampleRate * (bitsPerSample / 8)
      }
      offset = nextChunk(body, size)
      continue
    }

    if (id === 'data') {
      if (!byteRate) return null
      const dataSize = resolveDataSize({ size, body, fileSize })
      if (!dataSize) return null
      const seconds = dataSize / byteRate
      return Number.isFinite(seconds) && seconds > 0 ? seconds : null
    }

    offset = nextChunk(body, size)
  }

  return null
}

/**
 * `data` size in bytes. A zero / 0xFFFFFFFF / beyond-EOF size means "unknown" (streaming
 * writer that patched the header late, or RF64): fall back to what the file actually holds.
 */
function resolveDataSize({ size, body, fileSize }) {
  const total = Number(fileSize)
  const available = Number.isFinite(total) && total > body ? total - body : 0
  // A short header buffer is normal (the payload is not read), so only an explicit
  // "unknown" marker or a size past EOF means the header cannot be trusted.
  if (!size || size === UNKNOWN_SIZE) return available || null
  if (available && size > available) return available
  return size
}

/** Chunks are word aligned: an odd payload is followed by one pad byte. */
function nextChunk(body, size) {
  if (!Number.isFinite(size) || size < 0) return Number.POSITIVE_INFINITY
  return body + size + (size % 2)
}

function toBuffer(input) {
  if (!input) return null
  if (Buffer.isBuffer(input)) return input
  if (input instanceof Uint8Array) return Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  return null
}

export default readWavDuration