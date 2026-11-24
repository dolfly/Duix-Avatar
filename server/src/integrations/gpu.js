import { execFile } from 'node:child_process'

/**
 * GPU memory admission gate (incremental-budget semantics, DO-146).
 *
 * gen-video holds a single 8 GiB card shared with tts/asr. Before the worker submits a new
 * job it asks this gate whether the card can fit one more inference; when it can't (or when
 * the number cannot be determined) the worker refuses to submit and leaves the task queued
 * (fail-closed). The same gate is consulted a second time *after* TTS, right before
 * `face2face.submit`, so a task whose own TTS (or a concurrent orphan) changed the card's
 * headroom is re-admitted instead of launched onto an already-pressured card.
 *
 * **Threshold semantics** (`minFreeMb`, exposed as `VIDEO_MIN_FREE_VRAM_MB`): this is the
 * *incremental budget* one inference needs, not a whole-card free lower bound. The original
 * DO-120 gate compared the whole-card `memory.free` against a fixed floor; that floor
 * counted gen-video's own resident VRAM (~2.6-3.0 GiB, a one-time step that appears after
 * the first real inference) as external pressure, so once the steady-state free settled at
 * ~2017 MiB any threshold above it blocked *every* subsequent submission. The card is
 * 8192 MiB; one more inference only needs the ~1300 MiB *increment* above gen-video's
 * existing resident (measured on CT131: steady free 2017 MiB minus the 719 MiB low-water
 * mark during a real run). The default therefore budgets 1300 MiB + a ~200 MiB margin.
 *
 * We cannot attribute residency to processes at runtime: `duix-server` runs with only the
 * `utility` capability (no compute access) and the gen-video image is third-party, so
 * process-level VRAM attribution is unavailable. The increment is instead a static budget
 * knob derived from measurement; an operator on a different card size re-tunes
 * `VIDEO_MIN_FREE_VRAM_MB` to that card's per-inference increment.
 *
 * The probe is `nvidia-smi --query-gpu=memory.free ...`, read through a subprocess with a
 * short timeout so admission never blocks the tick for seconds. `exec` is injectable so
 * tests can simulate the GPU without a real driver.
 */
export function createVramGate({
  enabled = true,
  bin = 'nvidia-smi',
  minFreeMb = 1500,
  timeoutMs = 5000,
  exec = execFile,
  log
} = {}) {
  async function freeMemoryMb() {
    const args = ['--query-gpu=memory.free', '--format=csv,noheader,nounits']
    // No `-i` filter: the container's NVIDIA_VISIBLE_DEVICES already scopes the visible
    // card(s), and inside a container device indices are remapped (host GPU_IDS=1 -> 0),
    // so a host-side index would query the wrong device.
    const { stdout } = await runExec(exec, bin, args, timeoutMs)
    const values = String(stdout)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map(Number)
    const total = values.reduce((sum, value) => sum + value, 0)
    if (!values.length || !Number.isFinite(total)) {
      throw new Error(`unexpected ${bin} output: ${JSON.stringify(String(stdout))}`)
    }
    return total
  }

  /**
   * @returns {Promise<{ok: boolean, reason: string|null}>} admission verdict. `ok:false`
   *   means "do not submit"; the worker surfaces `reason` on the queued task.
   */
  async function canSubmit() {
    if (!enabled) return { ok: true, reason: null }
    let freeMb
    try {
      freeMb = await freeMemoryMb()
    } catch (error) {
      log?.warn?.(`GPU 显存查询失败（fail-closed，不提交）: ${error?.message || error}`)
      return { ok: false, reason: '无法查询 GPU 显存，暂停提交（fail-closed）' }
    }
    if (freeMb < minFreeMb) {
      return {
        ok: false,
        reason: `GPU 显存不足（本次推理需 ${minFreeMb}MB 增量预算，可用 ${freeMb}MB），等待`
      }
    }
    return { ok: true, reason: null }
  }

  return { freeMemoryMb, canSubmit }
}

function runExec(exec, bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    exec(bin, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        const wrapped = Object.assign(new Error(error.message || 'exec failed'), {
          code: error.code,
          stderr: String(stderr || '')
        })
        reject(wrapped)
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

export default createVramGate
