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
     * Atomically lease a task. Returns true when this instance won the claim.
     * rqlite executes the statement in a transaction, so rows_affected is authoritative
     * even with several server instances sharing one database.
     */
    async claim(id, { claimedBy, leaseMs, status, now = Date.now() }) {
      const result = await store.execute(
        `UPDATE video
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
        'UPDATE video SET claimed_by = NULL, claimed_at = NULL WHERE id = ? AND claimed_by = ?',
        [id, claimedBy]
      )
    },

    findStale(leaseMs, now = Date.now()) {
      return store.query(
        'SELECT * FROM video WHERE claimed_by IS NOT NULL AND claimed_at < ? ORDER BY id ASC',
        [now - leaseMs]
      )
    }
  }
}

function serialize(value) {
  if (value === undefined || value === null) return null
  if (typeof value === 'object') return JSON.stringify(value)
  return value
}

export default { createContextDao, createModelDao, createVoiceDao, createAuditionDao, createVideoDao }