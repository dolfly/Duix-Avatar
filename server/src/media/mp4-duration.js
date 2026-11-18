/**
 * Pure MP4 duration probe.
 *
 * The desktop client shelled out to ffprobe to read the duration of a generated video.
 * The web deployment must not ship an ffmpeg binary, so the handful of files we care
 * about (MP4 output of the gen-video service) are inspected directly: the `mvhd` box
 * inside `moov` holds timescale + duration.
 *
 * Returns seconds (float) or null when the file is not a readable MP4.
 */

const BOX_HEADER = 8
const BOX_SIZE_64 = 16

/**
 * @param {Buffer|Uint8Array} input
 * @returns {number|null} duration in seconds
 */
export function readMp4Duration(input) {
  const buffer = toBuffer(input)
  if (!buffer || buffer.length < BOX_HEADER) return null

  let offset = 0
  while (offset + BOX_HEADER <= buffer.length) {
    const size = readUint32(buffer, offset)
    const type = buffer.toString('latin1', offset + 4, offset + 8)
    let boxSize = size
    let headerSize = BOX_HEADER

    if (size === 1) {
      if (offset + BOX_SIZE_64 > buffer.length) return null
      boxSize = Number(readBigUint64(buffer, offset + 8))
      headerSize = BOX_SIZE_64
    } else if (size === 0) {
      boxSize = buffer.length - offset
    }

    if (!Number.isFinite(boxSize) || boxSize < headerSize) return null

    if (type === 'moov') {
      return readMoovDuration(buffer, offset + headerSize, offset + boxSize)
    }

    offset += boxSize
  }

  return null
}

function readMoovDuration(buffer, start, end) {
  let offset = start
  while (offset + BOX_HEADER <= end) {
    const size = readUint32(buffer, offset)
    const type = buffer.toString('latin1', offset + 4, offset + 8)
    const headerSize = size === 1 ? BOX_SIZE_64 : BOX_HEADER
    const boxSize = size === 1 ? Number(readBigUint64(buffer, offset + 8)) : size || end - offset

    if (!Number.isFinite(boxSize) || boxSize < headerSize) return null

    if (type === 'mvhd') {
      return readMvhdDuration(buffer, offset + headerSize)
    }

    offset += boxSize
  }

  return null
}

function readMvhdDuration(buffer, offset) {
  if (offset + 4 > buffer.length) return null
  const version = buffer.readUInt8(offset)

  if (version === 1) {
    // creation(8) modification(8) timescale(4) duration(8)
    const timescale = buffer.readUInt32BE(offset + 20)
    const duration = Number(buffer.readBigUInt64BE(offset + 24))
    return timescale > 0 ? duration / timescale : null
  }

  // creation(4) modification(4) timescale(4) duration(4)
  const timescale = buffer.readUInt32BE(offset + 12)
  const duration = buffer.readUInt32BE(offset + 16)
  return timescale > 0 ? duration / timescale : null
}

function toBuffer(input) {
  if (!input) return null
  if (Buffer.isBuffer(input)) return input
  if (input instanceof Uint8Array) return Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  return null
}

function readUint32(buffer, offset) {
  return buffer.readUInt32BE(offset)
}

function readBigUint64(buffer, offset) {
  if (typeof buffer.readBigUInt64BE === 'function') return buffer.readBigUInt64BE(offset)
  return BigInt(buffer.readUInt32BE(offset)) * 2n ** 32n + BigInt(buffer.readUInt32BE(offset + 4))
}

export default readMp4Duration