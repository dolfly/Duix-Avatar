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
})
