import { describe, expect, it } from 'vitest'

import { readWavDuration } from '../src/media/wav-duration.js'

/**
 * Build a minimal but structurally valid PCM WAV: RIFF + fmt (16 bytes) + data.
 * `dataSize` / `dataSizeField` let a test patch the payload size independently of the
 * buffer that is actually passed in (the real caller only reads the header).
 */
function buildWav({
  seconds = 1,
  sampleRate = 8000,
  bits = 16,
  channels = 1,
  dataSize,
  dataSizeField,
  payloadBytes,
  payloadSeconds,
  withFmt = true,
  oddPaddingChunk = false
} = {}) {
  const byteRate = sampleRate * channels * (bits / 8)
  const computed = Math.round(seconds * byteRate)
  const payload = dataSize ?? computed
  const parts = []

  if (oddPaddingChunk) {
    // A JUNK chunk with an odd payload: the following chunk must still be found (word align).
    const junk = Buffer.alloc(8 + 3 + 1)
    junk.write('JUNK', 0, 'latin1')
    junk.writeUInt32LE(3, 4)
    parts.push(junk)
  }

  if (withFmt) {
    const fmt = Buffer.alloc(24)
    fmt.write('fmt ', 0, 'latin1')
    fmt.writeUInt32LE(16, 4)
    fmt.writeUInt16LE(1, 8) // PCM
    fmt.writeUInt16LE(channels, 10)
    fmt.writeUInt32LE(sampleRate, 12)
    fmt.writeUInt32LE(byteRate, 16)
    fmt.writeUInt16LE((channels * bits) / 8, 20) // block align
    fmt.writeUInt16LE(bits, 22)
    parts.push(fmt)
  }

  const data = Buffer.alloc(8)
  data.write('data', 0, 'latin1')
  data.writeUInt32LE(dataSizeField ?? payload, 4)
  parts.push(data)

  const body = Buffer.concat(parts)
  const riff = Buffer.alloc(12)
  riff.write('RIFF', 0, 'latin1')
  riff.writeUInt32LE(body.length, 4)
  riff.write('WAVE', 8, 'latin1')

  const payloadBuffer = Buffer.alloc(payloadBytes ?? (payloadSeconds ? Math.round(payloadSeconds * byteRate) : Math.min(payload, 1024)))
  return { buffer: Buffer.concat([riff, body, payloadBuffer]), byteRate, payload }
}

describe('readWavDuration', () => {
  it('reads the duration of a 36s 16-bit mono wav (the DO-121 long-audio shape)', () => {
    const { buffer } = buildWav({ seconds: 36.04 })
    expect(readWavDuration(buffer)).toBeCloseTo(36.04, 2)
  })

  it('reads fractional durations', () => {
    const { buffer } = buildWav({ seconds: 5.8 })
    expect(readWavDuration(buffer)).toBeCloseTo(5.8, 2)
  })

  it('reads 8-bit and stereo layouts', () => {
    expect(readWavDuration(buildWav({ seconds: 12, bits: 8 }).buffer)).toBeCloseTo(12, 2)
    expect(readWavDuration(buildWav({ seconds: 3, channels: 2 }).buffer)).toBeCloseTo(3, 2)
  })

  it('skips an odd-sized chunk before fmt (word alignment)', () => {
    const { buffer } = buildWav({ seconds: 7, oddPaddingChunk: true })
    expect(readWavDuration(buffer)).toBeCloseTo(7, 2)
  })

  it('derives the payload size from the file size when the data size is unknown', () => {
    const { buffer } = buildWav({ dataSizeField: 0xffffffff, payloadSeconds: 10 })
    expect(readWavDuration(buffer, buffer.length)).toBeCloseTo(10, 2)
  })

  it('derives the payload size from the file size when the data size is zero', () => {
    const { buffer } = buildWav({ dataSizeField: 0, payloadSeconds: 4 })
    expect(readWavDuration(buffer, buffer.length)).toBeCloseTo(4, 2)
  })

  it('ignores a data size that runs past EOF', () => {
    const { buffer } = buildWav({ dataSizeField: 0x7fffffff, payloadSeconds: 6 })
    expect(readWavDuration(buffer, buffer.length)).toBeCloseTo(6, 2)
  })

  it('returns null without a fmt chunk (byte rate unknown)', () => {
    const { buffer } = buildWav({ withFmt: false })
    expect(readWavDuration(buffer)).toBeNull()
  })

  it('returns null for junk, empty or truncated input', () => {
    const junk = Buffer.alloc(40)
    junk.writeUInt32BE(40, 0)
    junk.write('free', 4, 'latin1')
    expect(readWavDuration(junk)).toBeNull()
    expect(readWavDuration(Buffer.alloc(0))).toBeNull()
    expect(readWavDuration(Buffer.alloc(8))).toBeNull()
    expect(readWavDuration(null)).toBeNull()
  })

  it('returns null for a zero-length payload', () => {
    const { buffer } = buildWav({ dataSizeField: 0, payloadBytes: 0 })
    expect(readWavDuration(buffer, buffer.length)).toBeNull()
  })
})