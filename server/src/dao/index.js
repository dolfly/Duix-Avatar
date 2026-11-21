/**
 * DAO layer - every statement is parameterised, no SQL string interpolation.
 * Rows are plain objects keyed by column name (rqlite JSON shape).
 */

const VIDEO_COLUMNS = new Set([
  'model_id',
  'name',
  'status',
  'message',
  'audio_path',
  'param',
  'code',
  'progress',
  'file_path',
  'duration',
  'text_content',
  'voice_id'
])

export function createContextDao(store) {
  return {
    findByKey(key) {
      return store.queryOne('SELECT id, key, val FROM context WHERE key = ? LIMIT 1', [key])
    },
    selectAll() {
      return store.query('SELECT id, key, val FROM context ORDER BY id')
    },
    insert(key, val) {
      return store.execute('INSERT INTO context (key, val) VALUES (?, ?)', [key, val])
    },
    update(key, val) {
      return store.execute('UPDATE context SET val = ? WHERE key = ?', [val, key])
    }
  }
}

export function createModelDao(store) {
  return {
    insert({ name, videoPath, audioPath, voiceId }) {
      return store
        .execute(
          `INSERT INTO f2f_model (name, video_path, audio_path, voice_id, created_at)
           VALUES (?, ?, ?, ?, ?)`,
          [name, videoPath, audioPath, voiceId ?? null, Date.now()]
        )
        .then((result) => Number(result.lastInsertId))
    },

    selectPage({ page = 1, pageSize = 10, name = '' }) {
      const offset = (page - 1) * pageSize
      return store.query(
        `SELECT * FROM f2f_model
         WHERE name LIKE ?
         ORDER BY created_at DESC, id DESC
         LIMIT ? OFFSET ?`,
        [`%${name}%`, pageSize, offset]
      )
    },

    count(name = '') {
      return store
        .queryScalar('SELECT COUNT(*) AS total FROM f2f_model WHERE name LIKE ?', [`%${name}%`])
        .then((total) => Number(total || 0))
    },

    selectByID(id) {
      return store.queryOne('SELECT * FROM f2f_model WHERE id = ?', [id])
    },

    remove(id) {
      return store.execute('DELETE FROM f2f_model WHERE id = ?', [id])
    }
  }
}

export function createVoiceDao(store) {
  return {
    selectAll() {
      return store.query('SELECT * FROM voice ORDER BY id DESC')
    },

    insert({ originAudioPath, lang, asrFormatAudioUrl, referenceAudioText }) {
      return store
        .execute(
          `INSERT INTO voice (origin_audio_path, lang, asr_format_audio_url, reference_audio_text, created_at)
           VALUES (?, ?, ?, ?, ?)`,
          [originAudioPath, lang, asrFormatAudioUrl, referenceAudioText, Date.now()]
        )
        .then((result) => Number(result.lastInsertId))
    },

    selectByID(id) {
      return store.queryOne('SELECT * FROM voice WHERE id = ?', [id])
    }
  }
}

const AUDITION_COLUMNS = new Set(['voice_id', 'text', 'status', 'message', 'file_path'])

export function createAuditionDao(store) {
  return {
    insert({ voiceId, text }) {
      return store
        .execute(
          `INSERT INTO audition (voice_id, text, status, message, file_path, created_at)
           VALUES (?, ?, 'waiting', '', '', ?)`,
          [voiceId, text, Date.now()]
        )
        .then((result) => Number(result.lastInsertId))
    },

    selectByID(id) {
      return store.queryOne('SELECT * FROM audition WHERE id = ?', [id])
    },

    findFirstByStatus(status) {
      return store.queryOne('SELECT * FROM audition WHERE status = ? ORDER BY id ASC LIMIT 1', [status])
    },

    update(id, fields) {
      const columns = Object.keys(fields).filter((column) => AUDITION_COLUMNS.has(column))
      if (!columns.length) return Promise.resolve({ rowsAffected: 0 })
      return store.execute(
        `UPDATE audition SET ${columns.map((column) => `${column} = ?`).join(', ')} WHERE id = ?`,
        [...columns.map((column) => serialize(fields[column])), id]
      )
    },

    updateStatus(id, status, message = '', filePath = '') {
      return store.execute(
        `UPDATE audition SET status = ?, message = ?, file_path = ? WHERE id = ?`,
        [status, message, filePath, id]
      )
    },

    /**
     * Atomically lease a task, mirroring `createVideoDao.claim`. Returns true when
     * this instance won the claim.
     */
    async claim(id, { claimedBy, leaseMs, status, now = Date.now() }) {
      const result = await store.execute(
        `UPDATE audition
            SET claimed_by = ?, claimed_at = ?
          WHERE id = ?
            AND status = ?
            AND (claimed_by IS NULL OR claimed_at IS NULL OR claimed_at < ?)`,
        [claimedBy, now, id, status, now - leaseMs]
      )
      return Number(result.rowsAffected) === 1
    },

    release(id, claimedBy) {
      return store.execute(
        'UPDATE audition SET claimed_by = NULL, claimed_at = NULL WHERE id = ? AND claimed_by = ?',
        [id, claimedBy]
      )
    }
  }
}

export function createVideoDao(store) {
  return {
    insert(video) {
      const columns = Object.keys(video).filter((column) => VIDEO_COLUMNS.has(column))
      if (!columns.length) throw new Error('video insert requires at least one column')
      const placeholders = columns.map(() => '?').join(', ')
      return store
        .execute(
          `INSERT INTO video (${columns.join(', ')}, created_at)
           VALUES (${placeholders}, ?)`,
          [...columns.map((column) => serialize(video[column])), Date.now()]
        )
        .then((result) => Number(result.lastInsertId))
    },

    update(id, fields) {
      const columns = Object.keys(fields).filter((column) => VIDEO_COLUMNS.has(column))
      if (!columns.length) return Promise.resolve({ rowsAffected: 0 })
      return store.execute(
        `UPDATE video SET ${columns.map((column) => `${column} = ?`).join(', ')} WHERE id = ?`,
        [...columns.map((column) => serialize(fields[column])), id]
      )
    },

    updateStatus(id, status, message = '', progress = 0, filePath = '') {
      return store.execute(
        `UPDATE video SET status = ?, message = ?, progress = ?, file_path = ? WHERE id = ?`,
        [status, message, progress, filePath, id]
      )
    },

    selectPage({ page = 1, pageSize = 10, name = '' }) {
      const offset = (page - 1) * pageSize
      return store.query(
        `SELECT * FROM video
         WHERE name LIKE ?
         ORDER BY created_at DESC, id DESC
         LIMIT ? OFFSET ?`,
        [`%${name}%`, pageSize, offset]
      )
    },

    count(name = '') {
      return store
        .queryScalar('SELECT COUNT(*) AS total FROM video WHERE name LIKE ?', [`%${name}%`])
        .then((total) => Number(total || 0))
    },

    selectByStatus(status) {
      return store.query('SELECT * FROM video WHERE status = ? ORDER BY id ASC', [status])
    },

    findFirstByStatus(status) {
      return store.queryOne('SELECT * FROM video WHERE status = ? ORDER BY id ASC LIMIT 1', [status])
    },

    selectByID(id) {
      return store.queryOne('SELECT * FROM video WHERE id = ?', [id])
    },

    remove(id) {
      return store.execute('DELETE FROM video WHERE id = ?', [id])
    },

    /**
     * Atomically move a `waiting` task into the intermediate `submitting` state.
     *
     * The status flip is what fixes the duplicate-submission bug: the old `claim()` kept
     * the task `waiting` while `synthesize()` did the minutes-long TTS, so once the lease
     * expired another tick re-claimed the *same still-waiting* row and submitted it again.
     * Once the row is `submitting` it can no longer be found by the `waiting` queue.
     *
     * The in-flight admission gate is enforced atomically in the same statement (rqlite
     * runs it as a transaction), so two racing workers can never both sneak a task past
     * the `maxInflight` cap. `started_at` is (re)set here: a re-queued task gets a fresh
     * total-timeout window.
     */
    async claimWaiting(id, { claimedBy, maxInflight, now = Date.now() }) {
      const result = await store.execute(
        `UPDATE video
            SET status = 'submitting', claimed_by = ?, claimed_at = ?, started_at = ?
          WHERE id = ?
            AND status = 'waiting'
            AND (SELECT COUNT(*) FROM video WHERE status IN ('submitting', 'pending')) < ?`,
        [claimedBy, now, now, id, maxInflight]
      )
      return Number(result.rowsAffected) === 1
    },

    /**
     * Re-lease an already-submitted `pending` task so this worker can poll it. The lease
     * (short, `leaseMs`) is what makes a crashed polling worker recoverable by another
     * instance; `started_at` is left untouched so the total timeout keeps counting from
     * first claim. `COALESCE` backfills rows that predate the `started_at` column.
     */
    async claimPending(id, { claimedBy, leaseMs, now = Date.now() }) {
      const result = await store.execute(
        `UPDATE video
            SET claimed_by = ?, claimed_at = ?, started_at = COALESCE(started_at, ?)
          WHERE id = ?
            AND status = 'pending'
            AND (claimed_by IS NULL OR claimed_at IS NULL OR claimed_at < ?)`,
        [claimedBy, now, now, id, now - leaseMs]
      )
      return Number(result.rowsAffected) === 1
    },

    release(id, claimedBy) {
      return store.execute(
        'UPDATE video SET claimed_by = NULL, claimed_at = NULL WHERE id = ? AND claimed_by = ?',
        [id, claimedBy]
      )
    },

    /** Number of tasks currently inside the GPU pipeline (submitted or submitting). */
    async countInflight() {
      return Number(
        (await store.queryScalar(
          "SELECT COUNT(*) AS n FROM video WHERE status IN ('submitting', 'pending')",
          []
        )) || 0
      )
    },

    /**
     * Fail every task that has spent longer than its total timeout inside the GPU
     * pipeline. Called at the top of each tick; `started_at` is the first-claim time, so
     * a gen-video that keeps answering "processing" can no longer occupy the queue and
     * the card forever. Also releases the claim so the row is fully free.
     */
    async failTimedOut(cutoffMs) {
      return store.execute(
        `UPDATE video
            SET status = 'failed', message = '合成超时，已释放', claimed_by = NULL, claimed_at = NULL
          WHERE status IN ('submitting', 'pending')
            AND started_at IS NOT NULL
            AND started_at < ?`,
        [cutoffMs]
      )
    },

    /** Surface a queue-wide wait reason on every `waiting` task (best effort, idempotent). */
    updateWaitingMessage(message) {
      return store.execute('UPDATE video SET message = ? WHERE status = ?', [message, 'waiting'])
    }
  }
}

function serialize(value) {
  if (value === undefined || value === null) return null
  if (typeof value === 'object') return JSON.stringify(value)
  return value
}

export default { createContextDao, createModelDao, createVoiceDao, createAuditionDao, createVideoDao }