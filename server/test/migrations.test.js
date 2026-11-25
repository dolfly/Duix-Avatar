import { beforeEach, describe, expect, it } from 'vitest'

import { migrate, BOOTSTRAP, LATEST_VERSION } from '../src/store/schema.js'
import { SqliteStore } from './helpers/sqlite-store.js'

describe('rqlite migrations', () => {
  let store

  beforeEach(() => {
    store = new SqliteStore()
  })

  it('creates the desktop-compatible schema on an empty store', async () => {
    const version = await migrate(store, { info() {} })

    expect(version).toBe(0)
    expect(Number(await store.queryScalar('SELECT val FROM context WHERE key = ?', ['db_version']))).toBe(
      LATEST_VERSION
    )

    const tables = await store.query(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
    const names = tables.map((row) => row.name)
    expect(names).toEqual(expect.arrayContaining(['context', 'f2f_model', 'video', 'voice', 'audition', 'model_task']))

    const videoColumns = (await store.query('PRAGMA table_info(video)')).map((row) => row.name)
    expect(videoColumns).toEqual(
      expect.arrayContaining(['claimed_by', 'claimed_at', 'started_at', 'deadline_at', 'voice_id', 'duration'])
    )

    const auditionColumns = (await store.query('PRAGMA table_info(audition)')).map((row) => row.name)
    expect(auditionColumns).toEqual(
      expect.arrayContaining(['voice_id', 'text', 'status', 'file_path', 'claimed_by', 'claimed_at'])
    )
  })

  it('is idempotent when the schema is already current', async () => {
    await migrate(store, { info() {} })
    const before = await store.query('SELECT * FROM context ORDER BY id')

    await expect(migrate(store, { info() {} })).resolves.toBe(LATEST_VERSION)

    const after = await store.query('SELECT * FROM context ORDER BY id')
    expect(after).toEqual(before)
  })

  it('seeds db_version only once', () => {
    expect(BOOTSTRAP.join(' ')).toContain('INSERT INTO context')
  })

  it('adds video.deadline_at when upgrading a db_version 7 store (DO-161)', async () => {
    await migrate(store, { info() {} })
    // Rewind to the previous released schema: v7 has no deadline_at column.
    await store.execute('ALTER TABLE video DROP COLUMN deadline_at')
    await store.execute("UPDATE context SET val = '7' WHERE key = 'db_version'")
    expect((await store.query('PRAGMA table_info(video)')).map((row) => row.name)).not.toContain('deadline_at')

    // `migrate` resolves to the version it found, not the one it wrote (see the empty-store case).
    await expect(migrate(store, { info() {} })).resolves.toBe(7)

    const videoColumns = (await store.query('PRAGMA table_info(video)')).map((row) => row.name)
    expect(videoColumns).toContain('deadline_at')
    expect(Number(await store.queryScalar('SELECT val FROM context WHERE key = ?', ['db_version']))).toBe(
      LATEST_VERSION
    )
  })
})