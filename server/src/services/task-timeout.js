/**
 * Per-task timeout window (DO-161).
 *
 * Inference time grows with the *audio* length, not with the text length: DO-121 measured
 * 5.8s of audio in ~2 min and 36.04s in >60 min on the thermally throttled P4000, i.e.
 * ~115x realtime at the slow end. A fixed 30-minute wall therefore kills every normal task
 * longer than ~30s of audio, while a genuinely stuck inference must still be failed and
 * released. The window is:
 *
 *   window = min(max, base + ceil(audioSeconds * perSecond))
 *
 * - `base` covers the fixed cost (claim, TTS, submit, model warm-up) and is also the
 *   fallback whenever the audio length is unknown (no `audio_path`, unreadable header).
 * - `perSecond` is the measured worst-case slope with margin; it is deliberately generous
 *   because a false "failed" is worse than a slow task on a single-card pipeline.
 * - `max` is the absolute cap: the window is never infinite, so a stuck task is still
 *   failed (and its gen-video work reaped) in a finite time.
 *
 * The window is anchored at `started_at` (first claim), so it bounds the *total* task time
 * (TTS + submit + poll) exactly like the DO-120 sweep it replaces.
 */

/**
 * @param {object} params
 * @param {number} params.baseMs        fixed part of the window (VIDEO_TASK_TIMEOUT_MS)
 * @param {number} params.perSecondMs   extra window per second of audio
 * @param {number} params.maxMs         absolute cap (VIDEO_TASK_TIMEOUT_MAX_MS)
 * @param {number|null|undefined} params.audioDurationSec real audio length in seconds
 * @returns {number} window in ms (>= 0)
 */
export function resolveTaskTimeoutMs({ baseMs, perSecondMs, maxMs, audioDurationSec } = {}) {
  const base = positive(baseMs)
  const perSecond = positive(perSecondMs)
  const max = positive(maxMs)
  const seconds = Number(audioDurationSec)

  const hasDuration = Number.isFinite(seconds) && seconds > 0
  const dynamic = hasDuration ? base + Math.ceil(seconds * perSecond) : base
  return max ? Math.min(dynamic, max) : dynamic
}

/**
 * Absolute deadline (epoch ms) for one task. `startedAt` is the first-claim time; when it
 * is missing (row predating the `started_at` column) the deadline is computed from now,
 * which can only shorten the window for that legacy row — never lengthen it.
 *
 * @returns {number} epoch ms
 */
export function taskDeadlineMs({ startedAt, baseMs, perSecondMs, maxMs, audioDurationSec } = {}) {
  const start = Number(startedAt)
  const anchor = Number.isFinite(start) && start > 0 ? start : Date.now()
  return anchor + resolveTaskTimeoutMs({ baseMs, perSecondMs, maxMs, audioDurationSec })
}

function positive(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

export default { resolveTaskTimeoutMs, taskDeadlineMs }