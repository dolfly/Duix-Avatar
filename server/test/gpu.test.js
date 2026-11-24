import { describe, expect, it } from 'vitest'

import { createVramGate } from '../src/integrations/gpu.js'

const SILENT = { debug() {}, info() {}, warn() {}, error() {} }

function fakeExec(stdout, { fail } = {}) {
  return (bin, args, options, callback) => {
    if (fail) {
      callback(Object.assign(new Error('nvidia-smi not found'), { code: 'ENOENT' }), '', '')
      return
    }
    callback(null, stdout, '')
  }
}

describe('createVramGate', () => {
  it('admits when free memory is above the threshold', async () => {
    const gate = createVramGate({ minFreeMb: 2048, exec: fakeExec('4096\n'), log: SILENT })
    await expect(gate.canSubmit()).resolves.toEqual({ ok: true, reason: null })
  })

  it('refuses when free memory is below the threshold (threshold is configurable)', async () => {
    const low = createVramGate({ minFreeMb: 2048, exec: fakeExec('1024\n'), log: SILENT })
    await expect(low.canSubmit()).resolves.toMatchObject({ ok: false })
    expect((await low.canSubmit()).reason).toMatch(/显存不足/)

    // The same probe reading passes when the threshold is lowered.
    const relaxed = createVramGate({ minFreeMb: 512, exec: fakeExec('1024\n'), log: SILENT })
    await expect(relaxed.canSubmit()).resolves.toEqual({ ok: true, reason: null })
  })

  it('fails closed when the probe cannot run', async () => {
    const gate = createVramGate({ minFreeMb: 2048, exec: fakeExec('', { fail: true }), log: SILENT })
    await expect(gate.canSubmit()).resolves.toMatchObject({ ok: false })
    expect((await gate.canSubmit()).reason).toMatch(/fail-closed/)
  })

  it('fails closed on malformed probe output', async () => {
    const gate = createVramGate({ minFreeMb: 2048, exec: fakeExec('garbage\n'), log: SILENT })
    await expect(gate.canSubmit()).resolves.toMatchObject({ ok: false })
  })

  it('skips the check when disabled', async () => {
    const gate = createVramGate({ enabled: false, exec: fakeExec('', { fail: true }), log: SILENT })
    await expect(gate.canSubmit()).resolves.toEqual({ ok: true, reason: null })
  })

  it('sums free memory across the visible GPUs', async () => {
    const gate = createVramGate({ minFreeMb: 2048, exec: fakeExec('1500\n1500\n'), log: SILENT })
    await expect(gate.canSubmit()).resolves.toEqual({ ok: true, reason: null })
  })

  it('admits at the steady-state free with the increment-budget default (DO-146)', async () => {
    // CT131 steady state: whole-card free ~2017-2035 MiB with gen-video's own ~2974 MiB
    // resident. The old whole-card floor (2048) rejected this forever; the increment
    // budget (~1500) admits it, since the resident is gen-video's own, not external pressure.
    const gate = createVramGate({ minFreeMb: 1500, exec: fakeExec('2035\n'), log: SILENT })
    await expect(gate.canSubmit()).resolves.toEqual({ ok: true, reason: null })

    const steady = createVramGate({ minFreeMb: 1500, exec: fakeExec('2017\n'), log: SILENT })
    await expect(steady.canSubmit()).resolves.toEqual({ ok: true, reason: null })
  })

  it('refuses when external pressure eats past the increment budget (accident shape)', async () => {
    // During a long TTS the card drops to a few hundred MiB free: below the ~1500 increment
    // budget, so a new submit is refused (fail-closed preserved).
    const low = createVramGate({ minFreeMb: 1500, exec: fakeExec('335\n'), log: SILENT })
    await expect(low.canSubmit()).resolves.toMatchObject({ ok: false })
    expect((await low.canSubmit()).reason).toMatch(/增量预算/)
  })

  it('refuses when the probe reading is below the increment at the inference low-water mark', async () => {
    // 719 MiB is the measured low-water mark mid-inference: already below the increment
    // budget, so no further task is admitted while one is still consuming the card.
    const gate = createVramGate({ minFreeMb: 1500, exec: fakeExec('719\n'), log: SILENT })
    await expect(gate.canSubmit()).resolves.toMatchObject({ ok: false })
  })
})
