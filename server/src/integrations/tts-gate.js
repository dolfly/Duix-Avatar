/**
 * TTS concurrency gate.
 *
 * The TTS service (`duix-tts`) is a single Python process whose GPU memory grows during a
 * long synthesis: a lone instance climbs from ~1.75 GiB idle to ~3.6 GiB mid-synthesis
 * (measured on CT131). The DO-118 outage was TTS pressure on the shared P4000, and DO-120's
 * admission gates only guard the *video* submit path — they are blind to the TTS calls the
 * server makes directly (audition preview, video TTS, voice cloning).
 *
 * Every TTS call in the server funnels through one client (`createTtsClient`), so wrapping
 * that single client in a counting semaphore here is enough to make *all* TTS entry points
 * share one slot. With `maxInflight === 1` only one synthesis is ever in flight: a second
 * request queues (FIFO, never dropped, never failed) until the first returns, which caps the
 * TTS service's own memory contribution at the single-instance peak instead of doubling it.
 *
 * This gate is deliberately in-process and independent from `VIDEO_MAX_INFLIGHT`: the video
 * gate limits how many jobs sit inside the GPU pipeline (submitting + pending), while this
 * gate limits how many TTS inferences run at once — two different resources, two knobs.
 */
export function createTtsGate({ tts, maxInflight = 1, log } = {}) {
  let inflight = 0
  // FIFO of resolvers for calls waiting on a free slot.
  const waiters = []

  async function withSlot(fn) {
    if (inflight >= maxInflight) {
      const queuedAt = Date.now()
      log?.info?.('等待 TTS 推理槽位（并发闸排队）', {
        inflight,
        queueLength: waiters.length + 1
      })
      await new Promise((resolve) => waiters.push(resolve))
      log?.info?.('获得 TTS 推理槽位', { waitedMs: Date.now() - queuedAt })
    }
    inflight += 1
    try {
      return await fn()
    } finally {
      inflight -= 1
      const next = waiters.shift()
      if (next) next()
    }
  }

  return {
    /**
     * Synthesise an audio file. Signature mirrors `createTtsClient.makeAudio` so the two
     * are interchangeable; the gate only adds the concurrency barrier around the call.
     */
    async makeAudio(param, options) {
      return withSlot(() => tts.makeAudio(param, options))
    },

    /**
     * Clone a voice (`preprocess_and_tran` + ASR). Also a TTS inference and therefore
     * subject to the same single slot, so a clone can't overlap an audition or a video's TTS.
     */
    async preprocessAndTran(param) {
      return withSlot(() => tts.preprocessAndTran(param))
    }
  }
}

export default createTtsGate