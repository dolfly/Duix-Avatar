import { execFile } from 'node:child_process'

/**
 * Reaper for GPU work the server has already abandoned (DO-160).
 *
 * ## Why this exists
 *
 * The total-timeout sweep (`videoDao.failTimedOut`) only changes *our* row: it marks the
 * task `failed` and releases its claim. It cannot reach inside the third-party gen-video
 * image (`guiji2025/*`), where `/easy/submit` starts a bare
 * `threading.Thread(target=task.work)` per submit (`/code/app_local.py`). The thread keeps
 * rendering frames after we gave up, keeps holding the card, and slows every later task —
 * which trips the next timeout, which produces the next orphan: the self-reinforcing loop
 * behind the DO-118 outage (and the DO-121 evidence: a task judged `failed` still rendered
 * 900+ frames and dragged the next TTS from 10.8 to 0.28 tokens/s).
 *
 * ## What the image does and does not offer (verified on CT131, 2026-11-24)
 *
 * `/code/app_local.py` exposes exactly two routes, `/easy/submit` and `/easy/query`:
 *
 *   - `submit` accepts only `audio_url`, `video_url`, `code`, `watermark_switch`,
 *     `digital_auth`, `chaofen`, `pn`. There is **no deadline, no heartbeat and no
 *     cancel/stop parameter**, so "hand the image a deadline and let it self-stop" is not
 *     available without rebuilding the image (out of bounds: third-party, not this repo).
 *   - `query` has no cancel side effect either; it only reads `task_dic`.
 *
 * So the only lever left is the process that owns the GPU work: the gen-video container.
 * Restarting it is the *minimal intrusive fallback* — it kills every inference thread in
 * that container and re-creates the service. This module is that lever, kept behind a
 * pluggable seam so the (much smaller) server-side fixes stay testable without a host.
 *
 * ## Blast radius (must be read before enabling `GEN_VIDEO_REAP_MODE=docker`)
 *
 *   - Every inference running inside the container dies, not just the abandoned one. With
 *     `VIDEO_MAX_INFLIGHT=1` the server only ever has one task in the pipeline, and the
 *     gen-video image itself rejects a second submit with `10001 忙碌中`, so in practice the
 *     victim is the abandoned task plus at most one task submitted in the same window.
 *   - gen-video keeps `task_dic` in memory, so a restart makes every other `pending` task
 *     answer `10004 任务不存在`. `videoService.poll` treats 10004 as a fast failure (see
 *     `services/index.js`), so those tasks end as `failed` with a clear message instead of
 *     hanging until their own 30-minute timeout.
 *   - The container is unavailable while it restarts (image init + model load, ~15s+ on
 *     CT131). The worker therefore observes a reaping cooldown (`reapCooldownMs`) and does
 *     not submit during it, otherwise the next queued task would hit a refusing socket and
 *     fail for a reason that has nothing to do with the task itself.
 *   - It needs `docker` CLI + `/var/run/docker.sock` inside `duix-server`, i.e. root-equivalent
 *     host access. That is a compose change and a production decision, so the default is
 *     `none` (log-only) and enabling it is an operator action — see `doc/web-deployment.md`.
 *
 * The reaper is best-effort by contract: it never throws into the worker tick, and it
 * throttles itself so a permanently failing `docker restart` cannot turn into a restart
 * storm (one attempt per `minIntervalMs`, attempts included).
 */

/** Accepted `GEN_VIDEO_REAP_MODE` values. Anything else degrades to `none`. */
export const REAP_MODES = ['none', 'docker']

export function normalizeReapMode(value) {
  const mode = String(value ?? '')
    .trim()
    .toLowerCase()
  return REAP_MODES.includes(mode) ? mode : 'none'
}

/**
 * @param {object} deps
 * @param {'none'|'docker'} [deps.mode] `none` = log only (default); `docker` = restart the
 *   gen-video container. Unknown values degrade to `none`.
 * @param {string} [deps.container] gen-video container name (compose `container_name`).
 * @param {number} [deps.minIntervalMs] minimum gap between two reap attempts.
 * @param {number} [deps.timeoutMs] timeout for the `docker restart` subprocess.
 * @param {Function} [deps.exec] injectable exec (tests).
 * @param {Function} [deps.now] injectable clock (tests).
 */
export function createGenVideoReaper({
  mode = 'none',
  container = 'duix-gen-video',
  minIntervalMs = 5 * 60 * 1000,
  timeoutMs = 30 * 1000,
  exec = execFile,
  now = () => Date.now(),
  log
} = {}) {
  const reapMode = normalizeReapMode(mode)
  // Attempts (successful or not) share one throttle window: a failing `docker restart`
  // must not be retried on every 2s tick.
  let lastAttemptAt = 0

  /**
   * Terminate the GPU work behind the given gen-video `code`s.
   * @param {string[]} codes abandoned task codes (from `videoDao.failTimedOut`).
   * @returns {Promise<{reaped: boolean, reason: string}>} never rejects.
   */
  async function reap(codes = []) {
    const list = (Array.isArray(codes) ? codes : [codes])
      .map((code) => String(code ?? '').trim())
      .filter(Boolean)
    if (!list.length) return { reaped: false, reason: 'empty' }

    if (reapMode !== 'docker') {
      log?.warn?.(
        `gen-video 侧已放弃任务 ${list.join(', ')}，但 GEN_VIDEO_REAP_MODE=${reapMode}：未终止容器内推理线程，` +
          '孤儿会继续占卡并拖慢后续任务（见 doc/web-deployment.md 的「孤儿清场」）',
        { codes: list }
      )
      return { reaped: false, reason: 'mode-none' }
    }

    const at = now()
    const since = at - lastAttemptAt
    if (since < minIntervalMs) {
      log?.info?.(`gen-video 清场距上次尝试仅 ${since}ms（< ${minIntervalMs}ms），跳过本次重启`, { codes: list })
      return { reaped: false, reason: 'throttled' }
    }
    lastAttemptAt = at

    try {
      await runExec(exec, 'docker', ['restart', container], timeoutMs)
      log?.warn?.(`已重启 ${container} 以终止被放弃的推理线程`, {
        codes: list,
        blastRadius: `容器内全部推理线程被终止；task_dic 丢失，其它 pending 任务会以 10004 快速失败`
      })
      return { reaped: true, reason: 'restarted' }
    } catch (error) {
      log?.error?.(`重启 ${container} 失败（放弃任务 ${list.join(', ')} 仍在占卡）: ${error?.message || error}`)
      return { reaped: false, reason: 'restart-failed' }
    }
  }

  return { reap, mode: reapMode, container }
}

function runExec(exec, bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    exec(bin, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(new Error(error.message || 'exec failed'), { code: error.code, stderr: String(stderr || '') }))
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

export default createGenVideoReaper