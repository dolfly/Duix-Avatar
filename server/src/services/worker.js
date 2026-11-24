import { randomUUID } from 'node:crypto'

/**
 * Background worker: drains the video queue with admission control.
 *
 * The desktop app owned this loop in the Electron main process. In the web deployment it
 * is a server-side loop that is safe to run on several instances at once:
 *
 *   - a `waiting` task is atomically moved to `submitting` (never claimed twice)
 *   - `pending` tasks are leased with an atomic UPDATE (rows_affected == 1)
 *   - the total-timeout sweep fails tasks that stay in the GPU pipeline too long, so a
 *     stuck gen-video can neither occupy the queue nor the card forever, and hands the
 *     abandoned gen-video codes to the reaper so the inference thread inside the
 *     third-party container is actually terminated (DO-160) instead of becoming an orphan
 *     that keeps rendering and slows every later task
 *   - the in-flight cap and the GPU memory gate run before submit, so submission volume
 *     can never outrun the single card
 *
 * Only one task is *submitted* per tick, matching the previous "one at a time" behaviour.
 */
export function createVideoWorker({
  videoDao,
  videoService,
  leaseMs = 120000,
  taskTimeoutMs = 30 * 60 * 1000,
  maxInflight = 1,
  intervalMs = 2000,
  gpuGate,
  reaper,
  reapCooldownMs = 60 * 1000,
  log,
  timers = { setInterval, clearInterval },
  now = () => Date.now()
}) {
  let timer = null
  let stopped = true
  // gen-video needs ~15s+ (image init + model load) before it accepts submits again, so a
  // reap is followed by a submit cooldown: submitting into the restarting container would
  // fail the next queued task for a reason unrelated to that task.
  let cooldownUntil = 0

  const instanceId = `server-${process.pid}-${randomUUID().slice(0, 8)}`

  async function release(id) {
    try {
      await videoDao.release(id, instanceId)
    } catch (error) {
      log?.warn?.(`failed to release claim on video ${id}: ${error?.message || error}`)
    }
  }

  /**
   * Terminate the GPU work of tasks the sweep just abandoned. Best-effort: the reaper
   * never throws, and a reaper failure must not stop the tick from draining the queue.
   * @returns {Promise<boolean>} true when the container was actually restarted.
   */
  async function reapAbandoned(abandoned) {
    if (!reaper || !abandoned?.length) return false
    try {
      const result = await reaper.reap(abandoned.map((task) => task.code))
      return Boolean(result?.reaped)
    } catch (error) {
      log?.error?.(`gen-video 清场失败: ${error?.message || error}`)
      return false
    }
  }

  async function tick() {
    const tickAt = now()

    // 1. Total-timeout sweep: any task stuck past its window (submitting or pending)
    //    becomes failed and is released. This is the "stuck task releases the card" fix.
    //    The abandoned codes are then reaped so the container-side thread dies with them.
    const abandoned = await videoDao.failTimedOut(tickAt - taskTimeoutMs)
    if (abandoned?.length && (await reapAbandoned(abandoned))) {
      cooldownUntil = tickAt + reapCooldownMs
    }

    let task = null
    try {
      // 2. Poll phase: an already-submitted task keeps making progress. This runs first
      //    so a `pending` task is never starved by the queue behind it. Iterate until one
      //    is claimable so a single held lease can't starve the other pending tasks.
      const pendingTasks = await videoDao.selectByStatus('pending')
      for (const pending of pendingTasks) {
        const claimed = await videoDao.claimPending(pending.id, {
          claimedBy: instanceId,
          leaseMs,
          now: now()
        })
        if (claimed) {
          task = pending
          await videoService.poll(pending)
          return
        }
      }
      // None claimable: other instances hold the pending leases. Fall through to the
      // submit phase; the in-flight cap below decides whether the card has room.

      // 2b. Reaping cooldown: the gen-video container is restarting, so submitting now
      //     would only produce a connection-refused failure. The queue keeps waiting.
      if (tickAt < cooldownUntil) {
        log?.debug?.(`gen-video 清场冷却中（剩 ${cooldownUntil - tickAt}ms），本 tick 不提交`)
        return
      }

      // 3. Submit phase: only when there is something waiting to run.
      const waiting = await videoDao.findFirstByStatus('waiting')
      if (!waiting) return

      // 3a. In-flight cap: do not submit while the card is already busy. The atomic
      //     enforcement lives in claimWaiting; this check is for the observability/log.
      const inflight = await videoDao.countInflight()
      if (inflight >= maxInflight) {
        log?.debug?.(`inflight ${inflight} >= maxInflight ${maxInflight}, keep task ${waiting.id} queued`)
        return
      }

      // 3b. GPU memory admission (fail-closed): don't submit when the card can't fit the
      //     next inference. Surfaced on the queued task so the user sees *why* it waits.
      if (gpuGate) {
        const gate = await gpuGate.canSubmit()
        if (!gate.ok) {
          log?.warn?.(`video ${waiting.id} 未提交: ${gate.reason || 'GPU 显存准入未通过'}`)
          await videoDao.updateWaitingMessage(gate.reason || 'GPU 显存准入未通过，等待')
          return
        }
      }

      // 3c. Claim (waiting -> submitting) and synthesize.
      const claimed = await videoDao.claimWaiting(waiting.id, {
        claimedBy: instanceId,
        maxInflight,
        now: now()
      })
      if (claimed) {
        task = waiting
        await videoService.synthesize(waiting)
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
      log?.info?.('video worker started', { instanceId, intervalMs, leaseMs, taskTimeoutMs, maxInflight })
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

/**
 * Background worker for audition (voice preview) tasks. Same claim/lease contract as
 * `createVideoWorker`, but single-phase: claim a `waiting` task, synthesise the TTS
 * audio, then mark it `success`/`failed`.
 *
 * The lease is intentionally long (callers pass the TTS timeout) because a synthesis
 * takes minutes; a shorter lease would let another tick re-claim the task mid-flight
 * and synthesise it twice.
 */
export function createAuditionWorker({
  auditionDao,
  auditionService,
  leaseMs = 900000,
  intervalMs = 2000,
  log,
  timers = { setInterval, clearInterval },
  now = () => Date.now()
}) {
  let timer = null
  let stopped = true

  const instanceId = `server-${process.pid}-${randomUUID().slice(0, 8)}`

  async function claimOne(status) {
    const task = await auditionDao.findFirstByStatus(status)
    if (!task) return null
    const claimed = await auditionDao.claim(task.id, { claimedBy: instanceId, leaseMs, status, now: now() })
    return claimed ? task : null
  }

  async function release(id) {
    try {
      await auditionDao.release(id, instanceId)
    } catch (error) {
      log?.warn?.(`failed to release claim on audition ${id}: ${error?.message || error}`)
    }
  }

  async function tick() {
    let task = null
    try {
      task = await claimOne('waiting')
      if (task) await auditionService.synthesize(task)
    } catch (error) {
      log?.error?.(`audition worker tick failed: ${error?.stack || error}`)
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
      log?.info?.('audition worker started', { instanceId, intervalMs, leaseMs })
      return this
    },

    stop() {
      stopped = true
      if (timer) timers.clearInterval(timer)
      timer = null
      return Promise.resolve()
    },

    /** Run one tick immediately (used by tests). */
    runOnce: tick,

    get running() {
      return !stopped
    }
  }
}

/**
 * Background worker for model (avatar) clone tasks. Same single-phase claim/lease
 * contract as `createAuditionWorker`: claim a `waiting` task, run the voice clone, then
 * mark it `success`/`failed`. The lease is long because `preprocess_and_tran` takes
 * minutes on the Pascal GPU.
 */
export function createModelTaskWorker({
  modelTaskDao,
  modelService,
  leaseMs = 960000,
  intervalMs = 2000,
  log,
  timers = { setInterval, clearInterval },
  now = () => Date.now()
}) {
  let timer = null
  let stopped = true

  const instanceId = `server-${process.pid}-${randomUUID().slice(0, 8)}`

  async function claimOne(status) {
    const task = await modelTaskDao.findFirstByStatus(status)
    if (!task) return null
    const claimed = await modelTaskDao.claim(task.id, { claimedBy: instanceId, leaseMs, status, now: now() })
    return claimed ? task : null
  }

  async function release(id) {
    try {
      await modelTaskDao.release(id, instanceId)
    } catch (error) {
      log?.warn?.(`failed to release claim on model task ${id}: ${error?.message || error}`)
    }
  }

  async function tick() {
    let task = null
    try {
      task = await claimOne('waiting')
      if (task) await modelService.process(task)
    } catch (error) {
      log?.error?.(`model task worker tick failed: ${error?.stack || error}`)
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
      log?.info?.('model task worker started', { instanceId, intervalMs, leaseMs })
      return this
    },

    stop() {
      stopped = true
      if (timer) timers.clearInterval(timer)
      timer = null
      return Promise.resolve()
    },

    /** Run one tick immediately (used by tests). */
    runOnce: tick,

    get running() {
      return !stopped
    }
  }
}
