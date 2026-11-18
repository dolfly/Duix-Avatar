import { describe, expect, it } from 'vitest'

import { readMp4Duration } from '../src/media/mp4-duration.js'

/**
 * Build a minimal but structurally valid MP4: ftyp + moov(mvhd).
 */
function buildMp4(durationSeconds, { version = 0, timescale = 1000 } = {}) {
  const parts = []

  const ftyp = Buffer.alloc(24)
  ftyp.writeUInt32BE(24, 0)
  ftyp.write('ftyp', 4, 'latin1')
  ftyp.write('isom', 8, 'latin1')
  parts.push(ftyp)

  let mvhd
  if (version === 1) {
    mvhd = Buffer.alloc(44)
    mvhd.writeUInt32BE(44, 0)
    mvhd.write('mvhd', 4, 'latin1')
    mvhd.writeUInt8(1, 8)
    mvhd.writeUInt32BE(timescale, 28)
    mvhd.writeBigUInt64BE(BigInt(Math.round(durationSeconds * timescale)), 32)
  } else {
    mvhd = Buffer.alloc(32)
    mvhd.writeUInt32BE(32, 0)
    mvhd.write('mvhd', 4, 'latin1')
    mvhd.writeUInt8(0, 8)
    mvhd.writeUInt32BE(timescale, 20)
    mvhd.writeUInt32BE(Math.round(durationSeconds * timescale), 24)
  }

  const moov = Buffer.alloc(8 + mvhd.length)
  moov.writeUInt32BE(moov.length, 0)
  moov.write('moov', 4, 'latin1')
  mvhd.copy(moov, 8)
  parts.push(moov)

  return Buffer.concat(parts)
}

describe('readMp4Duration', () => {
  it('reads mvhd v0 duration', () => {
    expect(readMp4Duration(buildMp4(12.5))).toBeCloseTo(12.5, 3)
  })

  it('reads mvhd v1 duration', () => {
    expect(readMp4Duration(buildMp4(93.75, { version: 1 }))).toBeCloseTo(93.75, 3)
  })

  it('returns null for buffers without moov', () => {
    const junk = Buffer.alloc(40)
    junk.writeUInt32BE(40, 0)
    junk.write('free', 4, 'latin1')
    expect(readMp4Duration(junk)).toBeNull()
  })

  it('returns null for empty or too small input', () => {
    expect(readMp4Duration(Buffer.alloc(0))).toBeNull()
    expect(readMp4Duration(null)).toBeNull()
  })

  it('stops on malformed box sizes', () => {
    const buffer = Buffer.alloc(8)
    buffer.writeUInt32BE(4, 0)
    buffer.write('moov', 4, 'latin1')
    expect(readMp4Duration(buffer)).toBeNull()
  })
})