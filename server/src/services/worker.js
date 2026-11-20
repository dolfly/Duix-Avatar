import { randomUUID } from 'node:crypto'

/**
 * Background worker: drains the video queue.
 *
 * The desktop app owned this loop in the Electron main process. In the web deployment it
 * is a server-side loop that is safe to run on several instances at once:
 *
 *   - a task is leased with an atomic UPDATE (rows_affected == 1) before it is touched
 *   - leases expire, so an instance that dies mid-task is recovered by the next tick
 *   - only one task is processed per tick, matching the previous "one at a time" behaviour
 */
export function createVideoWorker({
  videoDao,
  videoService,
  leaseMs = 120000,
  intervalMs = 2000,
  log,
  timers = { setInterval, clearInterval },
  now = () => Date.now()
}) {
  let timer = null
  let stopped = true

  const instanceId = `server-${process.pid}-${randomUUID().slice(0, 8)}`

  async function claimOne(status) {
    const task = await videoDao.findFirstByStatus(status)
    if (!task) return null
    const claimed = await videoDao.claim(task.id, { claimedBy: instanceId, leaseMs, status, now: now() })
    return claimed ? task : null
  }

  async function release(id) {
    try {
      await videoDao.release(id, instanceId)
    } catch (error) {
      log?.warn?.(`failed to release claim on video ${id}: ${error?.message || error}`)
    }
  }

  async function tick() {
    let task = null
    try {
      task = await claimOne('pending')
      if (task) {
        await videoService.poll(task)
        return
      }
      task = await claimOne('waiting')
      if (task) {
        await videoService.synthesize(task)
      }
    } catch (error) {
      log?.error?.(`worker tick failed: ${error?.stack || error}`)
    } finally {
      if (task) await release(task.id)
    }
  }

  return {
    instanceId,

    start() {
      if (!stopped) return this
      stopped = false
      tick().catch(() => {})
      timer = timers.setInterval(() => {
        tick().catch(() => {})
      }, intervalMs)
      timer?.unref?.()
      log?.info?.('video worker started', { instanceId, intervalMs, leaseMs })
      return this
    },

    stop() {
      stopped = true
      if (timer) timers.clearInterval(timer)
      timer = null
      return Promise.resolve()
    },

    /** Run one tick immediately (used by tests and by manual queue drains). */
    runOnce: tick,

    get running() {
      return !stopped
    }
  }
}

export default createVideoWorker