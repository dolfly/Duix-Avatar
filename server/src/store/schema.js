/**
 * Schema migrations for the rqlite metadata store.
 *
 * Versions 1-3 mirror the desktop client's SQLite schema (src/main/db/sql.js) so an
 * existing database file imported into rqlite keeps working. Version 4 adds the
 * columns used for multi-instance task claiming.
 */

export const BOOTSTRAP = [
  `CREATE TABLE IF NOT EXISTS context
   (
       id  INTEGER PRIMARY KEY AUTOINCREMENT,
       key TEXT,
       val TEXT
   )`,
  `INSERT INTO context (key, val)
   SELECT 'db_version', '0'
   WHERE NOT EXISTS (SELECT 1 FROM context WHERE key = 'db_version')`
]

export const migrations = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS context
       (
           id  INTEGER PRIMARY KEY AUTOINCREMENT,
           key TEXT,
           val TEXT
       )`,
      `INSERT INTO context (key, val)
       SELECT 'db_version', '1'
       WHERE NOT EXISTS (SELECT 1 FROM context WHERE key = 'db_version')`,
      `CREATE TABLE IF NOT EXISTS f2f_model
       (
           id         INTEGER PRIMARY KEY AUTOINCREMENT,
           name       TEXT,
           video_path TEXT,
           audio_path TEXT,
           voice_id   INTEGER,
           created_at INTEGER
       )`,
      `CREATE TABLE IF NOT EXISTS video
       (
           id           INTEGER PRIMARY KEY AUTOINCREMENT,
           file_path    TEXT,
           status       TEXT,
           message      TEXT,
           model_id     INTEGER,
           audio_path   TEXT,
           param        INTEGER,
           code         TEXT,
           created_at   INTEGER,
           progress     INTEGER DEFAULT 0,
           name         TEXT,
           duration     INTEGER,
           text_content TEXT
       )`
    ]
  },
  {
    version: 2,
    statements: [
      `CREATE TABLE IF NOT EXISTS voice
       (
           id                   INTEGER PRIMARY KEY AUTOINCREMENT,
           origin_audio_path    TEXT,
           lang                 TEXT,
           asr_format_audio_url TEXT,
           reference_audio_text TEXT,
           created_at           INTEGER
       )`
    ]
  },
  {
    version: 3,
    statements: [
      `ALTER TABLE video ADD COLUMN voice_id INTEGER`
    ]
  },
  {
    version: 4,
    statements: [
      `ALTER TABLE video ADD COLUMN claimed_by TEXT`,
      `ALTER TABLE video ADD COLUMN claimed_at INTEGER`
    ]
  },
  {
    // Audition (voice preview) tasks. The TTS synthesis takes minutes on the Pascal
    // GPU, far beyond the EdgeOne 15s origin timeout, so auditions are queued and
    // synthesised by a background worker (the same claim/lease pattern as `video`).
    version: 5,
    statements: [
      `CREATE TABLE IF NOT EXISTS audition
       (
           id         INTEGER PRIMARY KEY AUTOINCREMENT,
           voice_id   INTEGER,
           text       TEXT,
           status     TEXT,
           message    TEXT,
           file_path  TEXT,
           created_at INTEGER,
           claimed_by TEXT,
           claimed_at INTEGER
       )`
    ]
  }
]

export const LATEST_VERSION = migrations[migrations.length - 1].version

/**
 * Apply every migration newer than the stored db_version.
 * @param {{executeBatch: Function, queryOne: Function, queryScalar: Function}} store
 */
export async function migrate(store, log) {
  await store.executeBatch(BOOTSTRAP)

  const current = Number((await store.queryScalar('SELECT val FROM context WHERE key = ?', ['db_version'])) || 0)

  for (const migration of migrations) {
    if (migration.version <= current) continue
    if (log) log.info(`applying rqlite migration v${migration.version}`)
    await store.executeBatch(migration.statements)
    await store.execute('UPDATE context SET val = ? WHERE key = ?', [String(migration.version), 'db_version'])
  }

  return current
}