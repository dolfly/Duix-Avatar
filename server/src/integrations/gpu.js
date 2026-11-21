import { execFile } from 'node:child_process'

/**
 * GPU memory admission gate.
 *
 * gen-video holds a single 8 GiB card shared with tts/asr. Before the worker submits a
 * new job it asks this gate whether the card has enough free memory; when it doesn't (or
 * when the number cannot be determined) the worker refuses to submit and leaves the task
 * queued (fail-closed).
 *
 * The probe is `nvidia-smi --query-gpu=memory.free ...`, read through a subprocess with a
 * short timeout so admission never blocks the tick for seconds. `exec` is injectable so
 * tests can simulate the GPU without a real driver.
 */
export function createVramGate({
  enabled = true,
  bin = 'nvidia-smi',
  minFreeMb = 2048,
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
      return { ok: false, reason: `GPU 显存不足（可用 ${freeMb}MB < ${minFreeMb}MB），等待` }
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
