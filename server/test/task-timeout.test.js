import { describe, expect, it } from 'vitest'

import { resolveTaskTimeoutMs, taskDeadlineMs } from '../src/services/task-timeout.js'

const BASE = 30 * 60 * 1000
const PER_SECOND = 180000
const MAX = 12 * 60 * 60 * 1000

describe('resolveTaskTimeoutMs', () => {
  it('uses the base window when the audio length is unknown', () => {
    for (const audioDurationSec of [null, undefined, 0, -1, NaN, 'abc']) {
      expect(resolveTaskTimeoutMs({ baseMs: BASE, perSecondMs: PER_SECOND, maxMs: MAX, audioDurationSec })).toBe(BASE)
    }
  })

  it('extends the window linearly with the audio length (36s -> base + 108min)', () => {
    // DO-121: 36.04s of audio needed >60 min; 30 + 36*180s = 138 min of headroom.
    expect(resolveTaskTimeoutMs({ baseMs: BASE, perSecondMs: PER_SECOND, maxMs: MAX, audioDurationSec: 36 })).toBe(
      BASE + 36 * PER_SECOND
    )
    expect(resolveTaskTimeoutMs({ baseMs: BASE, perSecondMs: PER_SECOND, maxMs: MAX, audioDurationSec: 5.8 })).toBe(
      BASE + Math.ceil(5.8 * PER_SECOND)
    )
  })

  it('never exceeds the absolute cap', () => {
    expect(resolveTaskTimeoutMs({ baseMs: BASE, perSecondMs: PER_SECOND, maxMs: MAX, audioDurationSec: 3600 })).toBe(MAX)
    // A misconfigured base above the cap still cannot produce an unbounded window.
    expect(resolveTaskTimeoutMs({ baseMs: MAX * 2, perSecondMs: PER_SECOND, maxMs: MAX, audioDurationSec: 1 })).toBe(MAX)
  })

  it('falls back to the base window when the knobs are missing', () => {
    expect(resolveTaskTimeoutMs({ audioDurationSec: 36 })).toBe(0)
    expect(resolveTaskTimeoutMs({ baseMs: BASE, audioDurationSec: 36 })).toBe(BASE)
  })
})

describe('taskDeadlineMs', () => {
  it('anchors the window at started_at (total task time, not time since submit)', () => {
    const startedAt = 1_700_000_000_000
    expect(taskDeadlineMs({ startedAt, baseMs: BASE, perSecondMs: PER_SECOND, maxMs: MAX, audioDurationSec: 36 })).toBe(
      startedAt + BASE + 36 * PER_SECOND
    )
  })

  it('falls back to now for a row without started_at (legacy row: shorter, never longer)', () => {
    const before = Date.now()
    const deadline = taskDeadlineMs({ startedAt: null, baseMs: BASE, perSecondMs: PER_SECOND, maxMs: MAX, audioDurationSec: null })
    expect(deadline).toBeGreaterThanOrEqual(before + BASE)
    expect(deadline).toBeLessThanOrEqual(Date.now() + BASE)
  })
})